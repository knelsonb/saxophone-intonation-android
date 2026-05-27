// v1.1 — TinySoundFont wrapper for BellCurve raw-audio-output module.
//
// Single-instance synth wrapping tsf.h (single-header MIT-licensed SF2 player).
// Render path is int16 stereo to match the Kotlin AudioTrack configuration.
//
// Thread model (v1.1.1 — command queue):
//   - All control calls (note_on/off, program_change, pitch_bend, gain) come
//     from the JNI thread. They push a Command onto a queue under a brief
//     mutex hold (microseconds) and return immediately — they DO NOT touch
//     TSF state directly.
//   - synth_render_short() is called from the Kotlin worker thread. It
//     swaps the queue out under the lock (microseconds), drops the lock,
//     applies the commands to TSF, then calls tsf_render_short OUTSIDE
//     the lock. Render thread is the only writer of TSF voice state.
//
// Invariant: only synth_render_short() and synth_init/shutdown ever call
// into TSF directly. Every JNI control call routes via the queue. This
// keeps the JS-thread hold at queue-push latency (~1 µs) instead of the
// ~23 ms it would be if we serialised against a full render quantum.
//
// init/shutdown are not on the audio hot path — they hold the lock across
// the full TSF call. The render thread is not running during init() and
// must be stopped before shutdown(); the Kotlin side enforces this.

#include <mutex>
#include <vector>
#include <cstring>

#define TSF_IMPLEMENTATION
#include "tsf.h"

namespace {

    enum class CmdKind : uint8_t {
        NoteOn,
        NoteOff,
        ProgramChange,
        PitchBend,
        AllNotesOff,
        SetMasterGain,
    };

    struct Command {
        CmdKind kind;
        int     channel;   // unused for SetMasterGain
        int     midi;      // NoteOn/NoteOff
        int     program;   // ProgramChange
        float   velocity;  // NoteOn
        float   semitones; // PitchBend
        float   gain;      // SetMasterGain
    };

    tsf*       g_tsf       = nullptr;
    int        g_channels  = 2;     // 1 = mono, 2 = stereo
    int        g_rate      = 44100;

    // Protects g_tsf init/shutdown AND g_queue push/swap. NOT held across
    // tsf_render_short.
    std::mutex            g_mu;
    std::vector<Command>  g_queue;
}

// Pushes a fully-constructed command. Lock hold time is the vector push_back
// (typically 10s of nanoseconds; allocation when capacity grows, but we
// reserve once below).
static inline void enqueue(const Command& c) {
    std::lock_guard<std::mutex> lk(g_mu);
    g_queue.push_back(c);
}

// Applies one command to TSF state. Caller must hold ownership of TSF
// (i.e. the render thread, post-swap, lock released).
static void apply_command(const Command& c) {
    if (!g_tsf) return;
    switch (c.kind) {
        case CmdKind::NoteOn:
            tsf_channel_note_on(g_tsf, c.channel, c.midi, c.velocity);
            break;
        case CmdKind::NoteOff:
            tsf_channel_note_off(g_tsf, c.channel, c.midi);
            break;
        case CmdKind::ProgramChange:
            // bank=0 (GM), preset=program (0-127)
            tsf_channel_set_presetnumber(g_tsf, c.channel, c.program, 0);
            break;
        case CmdKind::PitchBend: {
            // Allow ±12 semitones via a 24-semitone range. Map linearly to
            // the 14-bit wheel [0, 16383] with 8192 = centre.
            tsf_channel_set_pitchrange(g_tsf, c.channel, 24.0f);
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

    // Pre-reserve queue capacity so common-case enqueues never allocate
    // under the lock. 64 is comfortably above the worst-case burst — even
    // a fast trill maxes around 10 commands per buffer.
    g_queue.clear();
    g_queue.reserve(64);

    return 0;
}

void synth_shutdown() {
    std::lock_guard<std::mutex> lk(g_mu);
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
    Command c{}; c.kind = CmdKind::SetMasterGain; c.gain = linear;
    enqueue(c);
}

void synth_note_on(int channel, int midi, float velocity) {
    Command c{}; c.kind = CmdKind::NoteOn;
    c.channel = channel; c.midi = midi; c.velocity = velocity;
    enqueue(c);
}

void synth_note_off(int channel, int midi) {
    Command c{}; c.kind = CmdKind::NoteOff;
    c.channel = channel; c.midi = midi;
    enqueue(c);
}

void synth_program_change(int channel, int program) {
    Command c{}; c.kind = CmdKind::ProgramChange;
    c.channel = channel; c.program = program;
    enqueue(c);
}

void synth_pitch_bend(int channel, float semitones) {
    Command c{}; c.kind = CmdKind::PitchBend;
    c.channel = channel; c.semitones = semitones;
    enqueue(c);
}

void synth_all_notes_off(int channel) {
    Command c{}; c.kind = CmdKind::AllNotesOff;
    c.channel = channel;
    enqueue(c);
}

// ---------------------------------------------------------------------------
// Render — drains the queue, applies, renders. Render itself is lock-free.
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
    // Swap the queue out under the lock — fast.
    std::vector<Command> local;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_tsf) {
            // Not initialised. Fill silence and bail. Drop any queued commands
            // so they don't apply to a future synth instance.
            g_queue.clear();
            std::memset(out, 0, samples * g_channels * sizeof(short));
            return samples;
        }
        local.swap(g_queue);
        // g_queue is now empty; capacity is preserved on the swapped-in side
        // (we don't .reserve here — the empty vec inside `local` had cap 0,
        // and swap moves both buffers, so g_queue picks up cap 0 the first
        // time. Re-reserve to keep the hot path allocation-free.)
        g_queue.reserve(64);
    }

    // Apply commands lock-free. We are the only writer of TSF voice state.
    for (const auto& c : local) {
        apply_command(c);
    }

    // Render outside the lock. TSF's internal voice mixer is only touched
    // by this thread.
    tsf_render_short(g_tsf, out, samples, 0 /* mixing=0 means overwrite */);
    return samples;
}

} // extern "C"
