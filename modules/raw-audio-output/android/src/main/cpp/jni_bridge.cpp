// v1.1 — JNI bridge between RawAudioOutputModule.kt and synth.cpp.
//
// Method naming follows the JNI convention:
//   Java_<package_with_underscores>_<ClassName>_<methodName>
// All native methods live on the SynthBridge object (Kotlin object, exposed
// as a class with static methods to JNI).

#include <jni.h>
#include <cstdint>

extern "C" {
    int  synth_init(const char* sf2_path, int sample_rate, int channels);
    void synth_shutdown();
    void synth_set_master_gain(float linear);
    void synth_note_on(int channel, int midi, float velocity);
    void synth_note_off(int channel, int midi);
    void synth_program_change(int channel, int program);
    void synth_pitch_bend(int channel, float semitones);
    void synth_all_notes_off(int channel);
    int  synth_render_short(short* out, int samples);
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

JNI_FN(void, nativeShutdown)(JNIEnv*, jobject) {
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
JNI_FN(jint, nativeRenderShort)(JNIEnv* env, jobject, jshortArray outBuf, jint frames) {
    void* raw = env->GetPrimitiveArrayCritical(outBuf, nullptr);
    if (!raw) return 0;
    int written = synth_render_short(reinterpret_cast<short*>(raw), frames);
    env->ReleasePrimitiveArrayCritical(outBuf, raw, 0);
    return written;
}
