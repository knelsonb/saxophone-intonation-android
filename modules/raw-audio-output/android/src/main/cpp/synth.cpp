// v1.4 — TinySoundFont wrapper for BellCurve raw-audio-output module.
//
// Single-instance synth wrapping tsf.h (single-header MIT-licensed SF2 player).
// Render path is int16 stereo to match the Kotlin AudioTrack configuration.
//
// Thread model (v1.1.1 — command queue, v1.4 — deferred firing):
//   - All control calls (note_on/off, program_change, pitch_bend, gain) come
//     from the JNI thread. They push a Command onto a queue under a brief
//     mutex hold (microseconds) and return immediately — they DO NOT touch
//     TSF state directly.
//   - synth_render_short() is called from the Kotlin worker thread. It
//     swaps the queue out under the lock (microseconds), drops the lock,
//     partitions the local queue into "due now" vs "deferred" (atFrame past
//     the current render window), applies the due set, then re-enqueues the
//     deferred set under the lock. tsf_render_short runs OUTSIDE the lock.
//   - Buffer-granular firing: a command with atFrame inside the current
//     buffer applies at the START of the buffer's render (~23 ms quantum).
//     Sub-buffer accuracy would require splitting the render call mid-buffer
//     and is out of scope (// v1.4-followup).
//
// Frame clock:
//   g_frame_position is incremented by `samples` on every successful render.
//   JS reads it via synth_get_current_frame() to peg wall-clock → frame-clock.
//
// Fire callback:
//   When a command is applied, if g_fired_cb is set we invoke it with
//   (kind, tick_kind, channel, midi, velocity, atFrame). The JNI bridge plugs
//   in a trampoline that attaches the audio thread to the JVM and calls back
//   into Kotlin. Listener must not block — Kotlin posts to a dispatcher.
//
// Invariant: only synth_render_short() and synth_init/shutdown ever call
// into TSF directly. Every JNI control call routes via the queue. This
// keeps the JS-thread hold at queue-push latency (~1 µs) instead of the
// ~23 ms it would be if we serialised against a full render quantum.
//
// init/shutdown are not on the audio hot path — they hold the lock across
// the full TSF call. The render thread is not running during init() and
// must be stopped before shutdown(); the Kotlin side enforces this with
// a join, but v1.3.4 added a render-active fence in case the join times out.

#include <android/log.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

#define LOG_TAG "BellCurve/Synth"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

#define TSF_IMPLEMENTATION
#include "tsf.h"

namespace {

    enum class CmdKind : uint8_t {
        NoteOn        = 1,
        NoteOff       = 2,
        ProgramChange = 3,
        PitchBend     = 4,
        AllNotesOff   = 5,
        SetMasterGain = 6,
    };

    // v1.4 — tick discriminator threaded through scheduled commands so the JS
    // bus can correlate the fire event back to the originating scheduler
    // intent (beat vs subdivision). 0 = unspecified (preserves legacy noteOn
    // path).
    constexpr uint8_t TICK_NONE = 0;
    constexpr uint8_t TICK_BEAT = 1;
    constexpr uint8_t TICK_SUB  = 2;

    struct Command {
        CmdKind  kind;
        uint8_t  tick_kind;   // 0=none, 1=beat, 2=sub
        int      channel;     // unused for SetMasterGain
        int      midi;        // NoteOn/NoteOff
        int      program;     // ProgramChange
        float    velocity;    // NoteOn
        float    semitones;   // PitchBend
        float    gain;        // SetMasterGain
        int64_t  atFrame;     // -1 = fire ASAP (legacy path); else absolute frame
    };

    tsf*       g_tsf       = nullptr;
    int        g_channels  = 2;     // 1 = mono, 2 = stereo
    int        g_rate      = 44100;

    // Protects g_tsf init/shutdown AND g_queue push/swap. NOT held across
    // tsf_render_short.
    std::mutex            g_mu;
    std::vector<Command>  g_queue;

    // v1.3.4 — render-active flag to close the TOCTOU on shutdown.
    //
    // The render thread checks `if (!g_tsf)` OUTSIDE the lock (apply_command).
    // Kotlin SynthRenderer.stop() (SynthRenderer.kt:140) joins the worker with
    // a 1500 ms timeout BEFORE the module's OnDestroy calls nativeShutdown —
    // but if the join times out the worker is leaked and nativeShutdown runs
    // anyway, so the render thread CAN still be touching g_tsf when shutdown
    // nulls it. The fence below makes shutdown wait until any active render
    // returns; the render thread raises the flag before any TSF access and
    // lowers it on exit (via the RAII guard below).
    std::atomic<bool>     g_render_active{false};

    // v1.3.4 — RAII guard for g_render_active. Guarantees the flag is
    // lowered on ALL exit paths from synth_render_short: normal return,
    // early return, and exception unwind. The destructor is implicitly
    // noexcept (trivially destructible atomic store); it does NOT fire on
    // std::abort/_exit, but those tear down the process anyway.
    struct RenderActiveGuard {
        RenderActiveGuard()  noexcept { g_render_active.store(true,  std::memory_order_release); }
        ~RenderActiveGuard() noexcept { g_render_active.store(false, std::memory_order_release); }
        // Non-copyable, non-movable — single RAII owner per render call.
        RenderActiveGuard(const RenderActiveGuard&)            = delete;
        RenderActiveGuard& operator=(const RenderActiveGuard&) = delete;
    };

    // v1.4 — monotonic render-frame counter. Render thread bumps it by
    // `samples` after each tsf_render_short call. JS / callers read via the
    // C-export synth_get_current_frame().
    std::atomic<int64_t>  g_frame_position{0};
}

// ---------------------------------------------------------------------------
// v1.4 — Fire callback. Invoked from the audio render thread when a command
// is applied. The bridge layer must keep this short and lock-free.
// ---------------------------------------------------------------------------
//
// Signature: kind (CmdKind cast to uint8_t), tick_kind, channel, midi,
// velocity, atFrame. For NoteOff: velocity=0, atFrame preserved. For
// ProgramChange the `midi` arg carries the program number; for PitchBend it
// carries the semitone value as a float in `velocity`. (Listeners that only
// care about NoteOn — the common case — can filter on kind.)
extern "C" {
    typedef void (*g_fired_cb_t)(uint8_t kind, uint8_t tick_kind, int channel,
                                  int midi, float velocity, int64_t atFrame);
}

namespace {
    std::atomic<g_fired_cb_t> g_fired_cb{nullptr};
}

// Pushes a fully-constructed command. Lock hold time is the vector push_back
// (typically 10s of nanoseconds; allocation when capacity grows, but we
// reserve once below).
static inline void enqueue(const Command& c) {
    std::lock_guard<std::mutex> lk(g_mu);
    g_queue.push_back(c);
}

// Applies one command to TSF state. Caller must hold ownership of TSF
// (i.e. the render thread, post-swap, lock released). After applying we
// fire the registered callback (if any) so listeners can correlate the
// FIRE moment (not the ENQUEUE moment) with their UI/state.
//
// v1.4 — `currentFrame` is the buffer-start frame index from
// synth_render_short. Used by the past-atFrame defensive guard below.
// Pass 0 from any non-render-thread caller (currently none).
static void apply_command(const Command& c, int64_t currentFrame) {
    if (!g_tsf) return;

    // v1.4 — defensive past-atFrame drop. This is the SECOND belt; the JS
    // schedule-time guard in useMetronome is the primary line of defense.
    // A small "past" delta is NORMAL because of buffer-granular firing: when
    // we partition due/deferred in synth_render_short, any command with
    // atFrame inside the current buffer window [currentFrame, bufferEnd) is
    // "due" — its atFrame is by definition <= bufferEnd-1 < currentFrame for
    // some samples in the buffer.
    //
    // Threshold rationale (v1.4 — raised from 100 ms to 500 ms):
    //   JS scheduler looks ahead ~150 ms; a delayed render quantum can add
    //   ~200 ms of stall; add a 150 ms safety margin → 500 ms total. A
    //   command more than 500 ms past at apply time signals a genuine missed
    //   window (heartbeat-to-render race) rather than a normal buffer-boundary
    //   fire. 100 ms was too aggressive and dropped legitimate scheduled
    //   commands that arrived during a render stall.
    //
    // atFrame < 0 means "fire ASAP" (legacy path) — never drop those.
    constexpr int64_t PAST_ATFRAME_THRESHOLD_MS = 500; // v1.4 — see rationale above
    if (c.atFrame > 0 && currentFrame > 0) {
        const int64_t threshold = static_cast<int64_t>(g_rate) * PAST_ATFRAME_THRESHOLD_MS / 1000;
        if (c.atFrame < currentFrame - threshold) {
            LOGE("apply_command: dropping past-atFrame command (atFrame=%lld currentFrame=%lld kind=%u channel=%d midi=%d)",
                 (long long)c.atFrame, (long long)currentFrame,
                 static_cast<unsigned>(c.kind), c.channel, c.midi);
            return;
        }
    }

    switch (c.kind) {
        case CmdKind::NoteOn:
            tsf_channel_note_on(g_tsf, c.channel, c.midi, c.velocity);
            break;
        case CmdKind::NoteOff:
            tsf_channel_note_off(g_tsf, c.channel, c.midi);
            break;
        case CmdKind::ProgramChange:
            // v1.3.3 — drum_channel flag must be 1 for channel 9 (GM percussion)
            // so TSF looks up the preset in bank 128 (the drum kits) instead
            // of bank 0 (melodic). For all other channels, drum_channel=0 →
            // bank 0 = normal GM melodic patches.
            tsf_channel_set_presetnumber(
                g_tsf, c.channel, c.program, c.channel == 9 ? 1 : 0);
            break;
        case CmdKind::PitchBend: {
            // Allow ±12 semitones. TSF's pitchrange R is the ± value (total
            // ±R), so the range is 12.0f — NOT 24. (Was 24.0f: with the encode
            // below mapping ±12 st → full wheel, a 24 range made the wheel
            // decode to ±24 → every bend came out 2× too large. The A4
            // calibration bend, e.g. +7.85¢ at A4=442, sounded as ~+15.7¢.)
            // Map linearly to the 14-bit wheel [0, 16383] with 8192 = centre.
            tsf_channel_set_pitchrange(g_tsf, c.channel, 12.0f);
            float clamped = c.semitones;
            if (clamped > 12.0f)  clamped = 12.0f;
            if (clamped < -12.0f) clamped = -12.0f;
            int wheel = 8192 + static_cast<int>((clamped / 12.0f) * 8191.0f);
            if (wheel < 0)     wheel = 0;
            if (wheel > 16383) wheel = 16383;
            tsf_channel_set_pitchwheel(g_tsf, c.channel, wheel);
            break;
        }
        case CmdKind::AllNotesOff:
            tsf_channel_sounds_off_all(g_tsf, c.channel);
            break;
        case CmdKind::SetMasterGain:
            tsf_set_volume(g_tsf, c.gain);
            break;
    }

    // v1.4 — notify listeners. Acquire-load — the JNI layer publishes the
    // pointer with release semantics in synth_set_fired_cb.
    g_fired_cb_t cb = g_fired_cb.load(std::memory_order_acquire);
    if (cb) {
        float v = c.velocity;
        int midi = c.midi;
        switch (c.kind) {
            case CmdKind::ProgramChange:
                // Encode program in `midi`, velocity = 0.
                midi = c.program; v = 0.0f;
                break;
            case CmdKind::PitchBend:
                // Encode semitones in `velocity`; midi unused.
                v = c.semitones; midi = 0;
                break;
            case CmdKind::AllNotesOff:
            case CmdKind::SetMasterGain:
                v = (c.kind == CmdKind::SetMasterGain) ? c.gain : 0.0f;
                midi = 0;
                break;
            case CmdKind::NoteOff:
                v = 0.0f;
                break;
            case CmdKind::NoteOn:
                break;
        }
        cb(static_cast<uint8_t>(c.kind), c.tick_kind, c.channel, midi, v, c.atFrame);
    }
}

extern "C" {

// Returns 0 on success, non-zero on failure.
// `sf2_path` must be a filesystem path readable by the process.
int synth_init(const char* sf2_path, int sample_rate, int channels) {
    std::lock_guard<std::mutex> lk(g_mu);

    if (g_tsf) {
        tsf_close(g_tsf);
        g_tsf = nullptr;
    }

    g_tsf = tsf_load_filename(sf2_path);
    if (!g_tsf) return 1;

    g_rate = sample_rate;
    g_channels = (channels == 1) ? 1 : 2;
    tsf_set_output(
        g_tsf,
        g_channels == 1 ? TSF_MONO : TSF_STEREO_INTERLEAVED,
        sample_rate,
        0.0f /* gain dB */
    );

    // v1.3.3 — GM channel 9 = percussion. Tell TSF explicitly: drum_channel=1
    // looks up the preset in bank 128 (the GM drum kits). Without this, our
    // metronome's noteOn(9, midi, vel) hits a channel with no preset loaded
    // and TSF renders silence (the "metronome shitting itself" bug). preset=0
    // is the Standard Drum Kit in GM bank 128 / GeneralUser-GS.
    tsf_channel_set_presetnumber(g_tsf, 9, 0, 1);

    // v1.4 — metronome audio is handled by the MIDI engine: scheduled
    // noteOnAt commands on channel 9 (GM percussion) render through TSF and
    // are the SOLE audible click source. The drum channel runs at unity so
    // those scheduled notes actually sound. (Earlier v1.4 builds muted this
    // channel pending a WAV-via-expo-audio path that was never wired — that
    // left the metronome silent. Completing the migration: unmute + drive the
    // click entirely from noteOnAt in useMetronome.) Per-beat loudness is
    // applied upstream via the note velocity (clickVolume × beat velocity).
    tsf_channel_set_volume(g_tsf, 9, 1.0f);

    // Pre-reserve queue capacity so common-case enqueues never allocate
    // under the lock. 64 is comfortably above the worst-case burst — even
    // a fast trill maxes around 10 commands per buffer.
    g_queue.clear();
    g_queue.reserve(64);

    // v1.4 — reset frame clock on every fresh init so JS peg math starts at zero.
    g_frame_position.store(0, std::memory_order_release);

    return 0;
}

void synth_shutdown() {
    // v1.3.4 — fence the render path. The Kotlin worker is normally joined
    // before this runs (RawAudioOutputModule.OnDestroy → renderer.stop()
    // → t.join(1500) on SynthRenderer.kt:140, BEFORE nativeShutdown on
    // RawAudioOutputModule.kt:79). The join can time out (`t.isAlive` then
    // logs "render thread did not exit within 1500 ms"); in that path the
    // worker keeps running while we tear down. Spin briefly on the active
    // flag so we never tsf_close a synth while apply_command/tsf_render_short
    // is dereferencing it.
    //
    // MAX_SHUTDOWN_WAIT_MS: a render quantum is ~23 ms, so 250 ms covers
    // ~10× worst-case. After the deadline we inspect the flag once more.
    // If the render thread is STILL active, the AudioTrack.write is hung
    // (broken OEM HAL) and there is no safe time to call tsf_close. In
    // that case we intentionally LEAK g_tsf (~30 MB soundfont state) rather
    // than dereference-after-free. OnDestroy still returns to Android in
    // bounded time. A logcat ERROR tells us we hit the path.
    const int MAX_SHUTDOWN_WAIT_MS = 250;
    for (int i = 0; i < MAX_SHUTDOWN_WAIT_MS && g_render_active.load(std::memory_order_acquire); ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    std::lock_guard<std::mutex> lk(g_mu);

    if (g_render_active.load(std::memory_order_acquire)) {
        // v1.3.4 — render thread is still live after MAX_SHUTDOWN_WAIT_MS ms.
        // AudioTrack.write is likely blocked on a broken HAL. Refuse to free
        // TSF: leak the instance rather than UAF. g_tsf is left non-null so
        // apply_command keeps working if the thread eventually unblocks; the
        // process is about to die anyway.
        LOGE("synth_shutdown: render thread still active after %d ms — "
             "leaking TSF instance to avoid UAF (broken AudioTrack HAL?)",
             MAX_SHUTDOWN_WAIT_MS);
        g_queue.clear();
        return;
    }

    if (g_tsf) {
        tsf_close(g_tsf);
        g_tsf = nullptr;
    }
    g_queue.clear();
}

// ---------------------------------------------------------------------------
// JNI control surface — all enqueue, none touch TSF directly.
// ---------------------------------------------------------------------------

void synth_set_master_gain(float linear) {
    Command c{}; c.kind = CmdKind::SetMasterGain; c.gain = linear; c.atFrame = -1;
    enqueue(c);
}

void synth_note_on(int channel, int midi, float velocity) {
    Command c{}; c.kind = CmdKind::NoteOn;
    c.channel = channel; c.midi = midi; c.velocity = velocity; c.atFrame = -1;
    enqueue(c);
}

void synth_note_off(int channel, int midi) {
    Command c{}; c.kind = CmdKind::NoteOff;
    c.channel = channel; c.midi = midi; c.atFrame = -1;
    enqueue(c);
}

void synth_program_change(int channel, int program) {
    Command c{}; c.kind = CmdKind::ProgramChange;
    c.channel = channel; c.program = program; c.atFrame = -1;
    enqueue(c);
}

void synth_pitch_bend(int channel, float semitones) {
    Command c{}; c.kind = CmdKind::PitchBend;
    c.channel = channel; c.semitones = semitones; c.atFrame = -1;
    enqueue(c);
}

void synth_all_notes_off(int channel) {
    Command c{}; c.kind = CmdKind::AllNotesOff;
    c.channel = channel; c.atFrame = -1;
    enqueue(c);
}

// v1.4 — scheduled noteOn. atFrame is an absolute frame index in the synth's
// monotonic frame clock (read via synth_get_current_frame). tick_kind is the
// scheduler-intent discriminator (0=none, 1=beat, 2=sub) round-tripped to the
// fire callback so JS listeners can correlate.
void synth_note_on_at(int channel, int midi, float velocity, int64_t atFrame, uint8_t tick_kind) {
    Command c{}; c.kind = CmdKind::NoteOn;
    c.channel = channel; c.midi = midi; c.velocity = velocity;
    c.atFrame = atFrame; c.tick_kind = tick_kind;
    enqueue(c);
}

// v1.4 — Drops only SCHEDULED commands (atFrame >= 0). Called from stop
// paths to prevent tail-firing after user-requested silence. Without this,
// a stop() that only issues allNotesOff() still leaves ~150 ms of
// future-scheduled noteOns sitting in g_queue; they fire on the next render
// quantum AFTER the user pressed stop, producing audible ghost clicks.
//
// Fire-ASAP commands (atFrame < 0) — e.g. drone/pipes legacy noteOns that
// haven't been drained yet — are PRESERVED by this function. Renamed from
// synth_clear_queue in v1.4 to make the partition contract explicit.
//
// Holds g_mu briefly (vector partition is O(n) but n is bounded — at the
// heartbeat-ahead window we schedule a handful of commands at a time).
// Capacity is preserved so the post-stop hot path stays allocation-free.
void synth_clear_scheduled() { // v1.4 — renamed from synth_clear_queue; partitions, not wipes
    std::lock_guard<std::mutex> lk(g_mu);
    // Partition: move fire-ASAP (atFrame < 0) commands to the front,
    // drop the rest (atFrame >= 0 = scheduled).
    auto it = std::stable_partition(g_queue.begin(), g_queue.end(),
        [](const Command& c) { return c.atFrame < 0; });
    g_queue.erase(it, g_queue.end());
}

// v1.4 — atomic read of the render-frame counter. Cheap; no lock.
int64_t synth_get_current_frame() {
    return g_frame_position.load(std::memory_order_acquire);
}

// v1.4 — register the fire callback. Pass nullptr to unregister.
void synth_set_fired_cb(g_fired_cb_t cb) {
    g_fired_cb.store(cb, std::memory_order_release);
}

// ---------------------------------------------------------------------------
// Render — drains the queue, partitions due/deferred, applies due, renders,
// re-enqueues deferred. Render itself is lock-free.
// ---------------------------------------------------------------------------
//
// Latency note: a control change pushed AFTER the render thread has swapped
// the queue but BEFORE the next swap will land one buffer (~23 ms @ 44.1 kHz
// / 1024 frames) later. This is the correct tradeoff: audio latency is
// identical to the pre-queue code (we still render in 1024-frame quanta),
// but JS-thread blocking drops from ~23 ms worst-case to ~1 µs.
//
// `out` buffer must hold (samples * channels) int16 values.
// `samples` is the number of FRAMES, matching tsf_render_short's contract.
// Returns the number of frames written (== samples on success).
int synth_render_short(short* out, int samples) {
    // v1.3.4 — RAII guard raises the render-active fence at construction and
    // lowers it on any exit path (normal return, early return, exception
    // unwind). Memory order: release on both ctor (true) and dtor (false),
    // paired with the acquire load in synth_shutdown's spin-wait.
    RenderActiveGuard renderGuard;

    // v1.4 — snapshot frame clock at the START of this buffer. Commands with
    // atFrame within [currentFrame, currentFrame + samples) fire now; anything
    // strictly beyond gets re-enqueued for a future quantum.
    const int64_t currentFrame = g_frame_position.load(std::memory_order_acquire);
    const int64_t bufferEnd    = currentFrame + samples;

    // Swap the queue out under the lock — fast.
    std::vector<Command> local;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_tsf) {
            // Not initialised. Fill silence and bail. Drop any queued commands
            // so they don't apply to a future synth instance.
            g_queue.clear();
            std::memset(out, 0, samples * g_channels * sizeof(short));
            // v1.4 — still advance the clock so callers observing the frame
            // counter don't see it freeze when the synth is unconfigured.
            g_frame_position.store(currentFrame + samples, std::memory_order_release);
            return samples;  // renderGuard dtor lowers g_render_active
        }
        local.swap(g_queue);
        // g_queue is now empty; capacity is preserved on the swapped-in side
        // (we don't .reserve here — the empty vec inside `local` had cap 0,
        // and swap moves both buffers, so g_queue picks up cap 0 the first
        // time. Re-reserve to keep the hot path allocation-free.)
        g_queue.reserve(64);
    }

    // v1.4 — partition: "due" commands apply this quantum, "deferred" return
    // to the queue. atFrame < 0 means "fire ASAP" (the legacy noteOn path)
    // and is always due.
    std::vector<Command> deferred;
    for (const auto& c : local) {
        if (c.atFrame < 0 || c.atFrame < bufferEnd) {
            apply_command(c, currentFrame);
        } else {
            deferred.push_back(c);
        }
    }

    // Re-enqueue any deferred commands. Common case: empty.
    if (!deferred.empty()) {
        std::lock_guard<std::mutex> lk(g_mu);
        // Prepend the deferred set onto whatever has accumulated since the
        // swap; their original ordering is preserved relative to each other.
        // Note: we don't sort by atFrame — at the heartbeat cadence we
        // schedule ~150 ms ahead in monotonic order, so insertion order ~=
        // atFrame order. // v1.4-followup: sort if out-of-order schedules
        // become a real source.
        if (g_queue.empty()) {
            g_queue.swap(deferred);
        } else {
            g_queue.insert(g_queue.begin(), deferred.begin(), deferred.end());
        }
    }

    // Render outside the lock. TSF's internal voice mixer is only touched
    // by this thread.
    tsf_render_short(g_tsf, out, samples, 0 /* mixing=0 means overwrite */);

    // v1.4 — advance the frame clock AFTER a successful render so observers
    // never see a frame that hasn't actually been rendered yet.
    g_frame_position.store(currentFrame + samples, std::memory_order_release);
    return samples;  // renderGuard dtor lowers g_render_active
}

} // extern "C"
