# After-Action Report — Audio latency & metronome timing

**Date:** 2026-05-28 · **Device:** Pixel 9 Pro (caiman, Android 16) · **Anchor commit:** `7a54320` (build versionCode 14 / 1.3.2, validated on-device ~10:34 local)

## Situation

The metronome pendulum looked "inverted" at fast tempo — the arm crossed center well before the click was heard. Initial framing was a visual/animation bug; the real issue was audio-output latency.

## What we found (measured, not assumed)

1. **The pendulum was correct.** It pegs to the engine's `commandFired` event (the moment a note is *written* to the audio buffer). The arm leading the sound was a *timing offset*, not a mapping flip.
2. **The frame clock pegs the WRITE position, not the PLAYBACK position.** `g_frame_position` counts frames handed to AudioTrack; the sound emerges one output-latency later. The realtime engine made *relative* scheduling precise but never modeled the *absolute* write→hear gap.
3. **That gap was ~245 ms** — proven with `AudioTrack.getTimestamp()` (`framesWritten − framePosition`), not inferred. Cause: three stacked errors —
   - rendering at **44.1 kHz on a 48 kHz-native device** → forced HAL resampler, disqualified the FAST mixer;
   - AudioTrack buffer = `getMinBufferSize × 2` (~120 ms);
   - no `PERFORMANCE_MODE_LOW_LATENCY`.
   The code's `ROUTE_LATENCY_MS` "speaker = 25 ms" was a hand-tuned guess **~10× too low**.
4. **Beat intervals also jittered ±13 ms** — notes fire at the 1024-frame *buffer boundary*, not their exact sample (frame-scheduled, not sample-accurate).

## What we changed (Step A — no AAudio rewrite)

- Render at the **device-native rate** (queried, fallback 48000) for `synth_init` + AudioTrack; expose `getSampleRate()` so the JS frame clock pegs at the same rate (kills the 8.8 % skew).
- `PERFORMANCE_MODE_LOW_LATENCY` + small build-time buffer (with safe fallback) + render thread at `THREAD_PRIORITY_AUDIO`.
- Result: **245 ms → 85 ms**, `underruns = 0`.

Plus the multisensory beat cue: distinct GM voice per beat (kick/snare/tom/cowbell), per-beat bob color (red/orange/yellow/blue), numeral.

## Principles (the durable lessons)

1. **Measure on the device; never ship a latency guess.** `getTimestamp` / onset logs / `dumpsys media.audio_flinger` beat speculation every time. The one number nobody measured (25 ms) was the one that was wrong.
2. **Know which clock you're on.** Schedule and visualize against the *playback* clock, not the *write* clock. Latency is the gap between them — make it a measured, first-class value, not a constant.
3. **Android low-latency is all-or-nothing, and granular.** The FAST/direct path needs native rate **and** a small buffer requested *at build time* (shrinking after doesn't re-grant it) **and** `LOW_LATENCY` **and** (for the *direct* track) **PCM_FLOAT + `USAGE_GAME`**. `perfMode == LOW_LATENCY` being granted does **not** mean you got the fast path — verify with `getTimestamp` and the track's `dumpsys` flags.
4. **Latency and precision are independent axes.** Absolute latency has a hardware floor (~20 ms AudioTrack fast, ~6–8 ms AAudio MMAP here); timing *precision* (sub-ms) is software — sample-accurate sub-buffer firing + scheduling on the DAC clock. Don't conflate "late" with "uneven."

## Remaining path to <25 ms (not yet done)

`85 ms` is the AudioTrack normal-mixer plateau: LOW_LATENCY is granted but the 16-bit / `USAGE_MEDIA` track is still mixed through the ~60 ms pipe. Next:
- **PCM_FLOAT rendering + `USAGE_GAME`** → likely the *direct* fast track (~25–30 ms), still on AudioTrack.
- **AAudio MMAP EXCLUSIVE** (device advertises mmap+exclusive, 2 ms burst) → **~6–8 ms** floor. Callback model; needs lock-free/alloc-free render path first.
- **Sub-buffer sample-accurate firing** → kills the ±13 ms jitter (task #164).

## Revert

If refinement regresses: `git reset --hard 7a54320` restores this known-good state. (Temporary diagnostics — `ONSET` / `OUTLAT` / `PendDiag` logs — are in this commit; strip before release.)
