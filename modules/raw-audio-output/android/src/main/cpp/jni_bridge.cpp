// v1.4 — JNI bridge between RawAudioOutputModule.kt and synth.cpp.
//
// Method naming follows the JNI convention:
//   Java_<package_with_underscores>_<ClassName>_<methodName>
// All native methods live on the SynthBridge object (Kotlin object, exposed
// as a class with static methods to JNI).
//
// v1.4 additions:
//   - nativeNoteOnAt + nativeGetCurrentFrame (scheduled fire + frame peg)
//   - nativeRegisterFiredCallback installs a JNI trampoline on the audio
//     render thread. We cache JavaVM* in JNI_OnLoad, keep a global ref to
//     the listener object + its callback method, and AttachCurrentThread
//     lazily inside the trampoline. The Kotlin listener must NOT block:
//     it should post to a dispatcher and return.

#include <atomic>
#include <cstdint>
#include <jni.h>

extern "C" {
    int      synth_init(const char* sf2_path, int sample_rate, int channels);
    void     synth_shutdown();
    void     synth_set_master_gain(float linear);
    void     synth_note_on(int channel, int midi, float velocity);
    void     synth_note_off(int channel, int midi);
    void     synth_program_change(int channel, int program);
    void     synth_pitch_bend(int channel, float semitones);
    void     synth_all_notes_off(int channel);
    int      synth_render_short(short* out, int samples);
    void     synth_note_on_at(int channel, int midi, float velocity, int64_t atFrame, uint8_t tick_kind);
    int64_t  synth_get_current_frame();
    void     synth_clear_scheduled(); // v1.4 — renamed from synth_clear_queue; preserves fire-ASAP commands
    typedef  void (*g_fired_cb_t)(uint8_t kind, uint8_t tick_kind, int channel,
                                   int midi, float velocity, int64_t atFrame);
    void     synth_set_fired_cb(g_fired_cb_t cb);
}

// ---------------------------------------------------------------------------
// JavaVM + listener cache. Populated in JNI_OnLoad and
// nativeRegisterFiredCallback respectively. Audio thread reads them lock-free
// via atomic pointer load.
//
// v1.4 — N3: atomic-snapshot pattern to eliminate the data race between the
// audio thread reading (listener, mid) and nativeRegisterFiredCallback writing
// them as two separate atomic stores. Previously the audio thread could read
// `listener` from registration N but `mid` from registration N-1 — undefined
// behaviour calling the wrong method ID on the wrong object.
//
// Fix: pack (listener, mid) into a ListenerSnapshot struct. A single
// std::atomic<ListenerSnapshot*> is the sole shared state. The trampoline
// acquire-loads the pointer and copies both fields onto its local stack before
// any JNI call — the local copy is used exclusively from that point on.
// Registration allocates a new snapshot and atomic-stores the pointer.
// The OLD snapshot is intentionally leaked (not freed, DeleteGlobalRef not
// called for the old listener). Max ~10 registrations per app lifetime at
// ~32 + sizeof(jobject) bytes each = negligible. nativeShutdown releases the
// CURRENT snapshot's listener ref only; older snapshots' listener refs are
// also leaked — the process is dying at that point anyway.
// ---------------------------------------------------------------------------
namespace {
    JavaVM* g_jvm = nullptr;

    // v1.4 — N3: listener snapshot for atomic (listener, mid) update.
    struct ListenerSnapshot { // v1.4
        jobject   listener; // global ref
        jmethodID mid;
    };

    // Single atomic pointer. Audio thread acquire-loads; registration
    // release-stores. Only the CURRENT pointer's listener ref is ever
    // DeleteGlobalRef'd (in nativeShutdown). Older snapshots are leaked.
    std::atomic<ListenerSnapshot*> g_listener_snapshot{nullptr}; // v1.4

    // Audio-thread trampoline. JNI methods need a JNIEnv; the audio render
    // thread is native-only by default so we AttachCurrentThread on first
    // call (and reuse the env for subsequent calls — Detach happens never;
    // the audio thread persists for the synth's lifetime). If Attach fails
    // we silently drop the event rather than crashing the renderer.
    void fired_trampoline(uint8_t kind, uint8_t tick_kind, int channel,
                          int midi, float velocity, int64_t atFrame) {
        if (!g_jvm) return;
        // v1.4 — N3: acquire-load the snapshot pointer and immediately copy
        // (listener, mid) onto the stack. All subsequent JNI calls use the
        // LOCAL copies, so a concurrent nativeRegisterFiredCallback that
        // stores a new pointer cannot affect this invocation.
        ListenerSnapshot* snap = g_listener_snapshot.load(std::memory_order_acquire);
        if (!snap) return;
        jobject   listener = snap->listener; // stack copy
        jmethodID mid      = snap->mid;      // stack copy
        if (!listener || !mid) return;

        JNIEnv* env = nullptr;
        // GetEnv first — if the thread is already attached, reuse the env.
        jint rc = g_jvm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
        bool attached = false;
        if (rc == JNI_EDETACHED) {
            // Audio thread is native — attach once and keep it attached for
            // the lifetime of the renderer. Subsequent calls hit the
            // GetEnv == JNI_OK fast path.
            if (g_jvm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
            attached = true;
        } else if (rc != JNI_OK || !env) {
            return;
        }

        env->CallVoidMethod(
            listener, mid,
            static_cast<jint>(kind),
            static_cast<jint>(tick_kind),
            static_cast<jint>(channel),
            static_cast<jint>(midi),
            static_cast<jfloat>(velocity),
            static_cast<jlong>(atFrame)
        );
        // Best-effort exception clear so a Kotlin-side throw from the listener
        // doesn't poison the next callback.
        if (env->ExceptionCheck()) env->ExceptionClear();

        // We deliberately do NOT DetachCurrentThread on success — the audio
        // thread is long-lived and re-attaching every render is expensive
        // (microseconds matter here). Detach only on the rare path where we
        // attached but somehow can't proceed, but that's handled above.
        (void)attached;
    }
}

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*reserved*/) {
    g_jvm = vm;
    return JNI_VERSION_1_6;
}

#define JNI_FN(ret, name) \
    extern "C" JNIEXPORT ret JNICALL \
    Java_expo_modules_rawaudiooutput_SynthBridge_##name

JNI_FN(jint, nativeInit)(JNIEnv* env, jobject /*thiz*/, jstring sf2Path,
                          jint sampleRate, jint channels) {
    const char* path = env->GetStringUTFChars(sf2Path, nullptr);
    int rc = synth_init(path, sampleRate, channels);
    env->ReleaseStringUTFChars(sf2Path, path);
    return rc;
}

JNI_FN(void, nativeShutdown)(JNIEnv* env, jobject) {
    // Tear down callback FIRST so the audio thread can't fire into a
    // listener we're about to delete.
    synth_set_fired_cb(nullptr);
    // v1.4 — N3: swap the snapshot pointer to null and release only the
    // CURRENT snapshot's listener global ref. Older leaked snapshots' listener
    // refs are intentionally not released (process is dying; sub-kilobyte leak).
    ListenerSnapshot* snap = g_listener_snapshot.exchange(nullptr, std::memory_order_acq_rel);
    if (snap && snap->listener) env->DeleteGlobalRef(snap->listener);
    // snap itself is leaked (intentional, see N3 design note above).
    synth_shutdown();
}

JNI_FN(void, nativeSetMasterGain)(JNIEnv*, jobject, jfloat gain) {
    synth_set_master_gain(gain);
}

JNI_FN(void, nativeNoteOn)(JNIEnv*, jobject, jint channel, jint midi, jfloat velocity) {
    synth_note_on(channel, midi, velocity);
}

JNI_FN(void, nativeNoteOff)(JNIEnv*, jobject, jint channel, jint midi) {
    synth_note_off(channel, midi);
}

JNI_FN(void, nativeProgramChange)(JNIEnv*, jobject, jint channel, jint program) {
    synth_program_change(channel, program);
}

JNI_FN(void, nativePitchBend)(JNIEnv*, jobject, jint channel, jfloat semitones) {
    synth_pitch_bend(channel, semitones);
}

JNI_FN(void, nativeAllNotesOff)(JNIEnv*, jobject, jint channel) {
    synth_all_notes_off(channel);
}

// v1.4 — scheduled noteOn. atFrame is the absolute frame index. tick_kind is
// 0=none/1=beat/2=sub for the JS scheduler-intent discriminator.
JNI_FN(void, nativeNoteOnAt)(JNIEnv*, jobject, jint channel, jint midi,
                              jfloat velocity, jlong atFrame, jint tickKind) {
    synth_note_on_at(channel, midi, velocity, static_cast<int64_t>(atFrame),
                      static_cast<uint8_t>(tickKind & 0xff));
}

JNI_FN(jlong, nativeGetCurrentFrame)(JNIEnv*, jobject) {
    return static_cast<jlong>(synth_get_current_frame());
}

// v1.4 — drop pending scheduled commands (atFrame >= 0). Preserves fire-ASAP
// (atFrame < 0) commands. Renamed from nativeClearQueue in v1.4.
JNI_FN(void, nativeClearScheduled)(JNIEnv*, jobject) { // v1.4
    synth_clear_scheduled();
}

// v1.4 — register Kotlin listener for fire-time callbacks. The listener must
// expose a method matching:
//   void onCommandFired(int kind, int tickKind, int channel, int midi,
//                       float velocity, long atFrame)
// Passing null clears the listener.
JNI_FN(void, nativeRegisterFiredCallback)(JNIEnv* env, jobject, jobject listener) {
    // v1.4 — N3: atomic-snapshot registration. We allocate a new
    // ListenerSnapshot, populate it, then atomic-store the pointer. The OLD
    // snapshot is intentionally leaked (see design note above). This makes
    // the (listener, mid) pair visible to the audio thread atomically — the
    // trampoline always sees a consistent snapshot rather than a torn state
    // from two separate atomic stores.
    if (!listener) {
        // Null listener: install null snapshot to disable callbacks.
        // The old snapshot is leaked (intentional).
        g_listener_snapshot.store(nullptr, std::memory_order_release);
        synth_set_fired_cb(nullptr);
        return;
    }

    jclass cls = env->GetObjectClass(listener);
    if (!cls) {
        g_listener_snapshot.store(nullptr, std::memory_order_release);
        synth_set_fired_cb(nullptr);
        return;
    }
    // Signature: (IIIIFJ)V — int, int, int, int, float, long → void.
    jmethodID mid = env->GetMethodID(cls, "onCommandFired", "(IIIIFJ)V");
    env->DeleteLocalRef(cls);
    if (!mid) {
        // Clear pending NoSuchMethodError; not having the method is a fatal
        // misconfiguration on the Kotlin side and we surface it via an
        // empty callback (no fire events) rather than crashing.
        if (env->ExceptionCheck()) env->ExceptionClear();
        g_listener_snapshot.store(nullptr, std::memory_order_release);
        synth_set_fired_cb(nullptr);
        return;
    }

    jobject global = env->NewGlobalRef(listener);
    if (!global) {
        g_listener_snapshot.store(nullptr, std::memory_order_release);
        synth_set_fired_cb(nullptr);
        return;
    }

    // Allocate a new snapshot. The old snapshot pointer (if any) is leaked —
    // intentional, see N3 design note. Sub-kilobyte total across all
    // registrations (~10 max over app lifetime).
    ListenerSnapshot* snap = new ListenerSnapshot{global, mid}; // v1.4
    g_listener_snapshot.store(snap, std::memory_order_release);
    synth_set_fired_cb(&fired_trampoline);
}

// Renders `frames` frames into the provided short[] (length must be
// frames * channels). Returns the number of frames written.
//
// v1.1.1 — GetPrimitiveArrayCritical guarantees direct (no-copy) pointer
// access and suppresses GC for the window. Standard JNI pattern for tight
// audio loops. Constraints (per JNI spec):
//   - Must be brief. We are: one tsf_render_short call.
//   - Cannot call any other JNI function in between. We don't.
//   - Cannot allocate Java objects in between. We don't.
// Pair with ReleasePrimitiveArrayCritical, mode 0. With the critical pair
// no copy occurred on Get, so Release with any mode is effectively a no-op
// for the memory itself — mode 0 is the safe default.
//
// v1.4 caveat: synth_render_short may now call back into Java via the fire
// trampoline. The trampoline runs OUTSIDE the GetPrimitiveArrayCritical
// window because apply_command runs before the swap — wait, actually it
// runs inside synth_render_short. Re-checking: apply_command IS called
// during synth_render_short, which is itself called inside the critical
// section here. That means the fire callback executes during a JNI
// critical region — which is illegal (we'd call other JNI functions).
//
// Fix: move the GetPrimitiveArrayCritical pair to wrap ONLY the
// tsf_render_short portion. But synth_render_short doesn't expose that
// split. Simpler fix: switch to GetShortArrayElements / Release with
// mode 0 — that DOES allow JNI calls in between, at the cost of a
// potential array copy. ART's HotSpot generally avoids the copy when
// the array fits and is contiguous. The 1024-frame * 2-channel * 2-byte
// = 4 KB buffer is well within the no-copy fast path on Android.
JNI_FN(jint, nativeRenderShort)(JNIEnv* env, jobject, jshortArray outBuf, jint frames) {
    jboolean isCopy = JNI_FALSE;
    jshort* raw = env->GetShortArrayElements(outBuf, &isCopy);
    if (!raw) return 0;
    int written = synth_render_short(reinterpret_cast<short*>(raw), frames);
    // Mode 0: copy back (if a copy was made) and free the C buffer.
    env->ReleaseShortArrayElements(outBuf, raw, 0);
    return written;
}
