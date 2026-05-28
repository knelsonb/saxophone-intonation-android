# Changelog

All notable changes to BellCurve are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.4] — 2026-05-27

### Real-time MIDI engine

- Native `Command.atFrame` + `tick_kind` pipeline: beats are scheduled against
  the hardware frame clock, partitioned per render quantum into due/deferred
  buckets.
- `synth_note_on_at` C export; JNI passthroughs `nativeNoteOnAt` /
  `nativeGetCurrentFrame` / `nativeRegisterFiredCallback`.
- Fire callback invoked at apply time with `(kind, tick, channel, midi, vel,
  atFrame)` — re-emitted on the JS bus as `'noteOn'` so visual listeners get
  the sample-accurate moment, not a reconciler approximation.
- Frame-clock peg auto-refreshes every 5 s (2 ms drift gate) and force-resets
  on `AppState` resume.
- Past-atFrame drop threshold: 500 ms (silence over wrong).
- `synth_clear_scheduled` preserves `atFrame=-1` fire-ASAP commands.
- `tsf_channel_set_volume(9, 0.0f)` silences the synth's audible drum track
  during the WAV-parallel migration; fire callback still fires for visual sync.

### Drone "dead-on" refactor

- Every pitch change (instrument, semitone offset, A4 calibration) issues a
  full `noteOff` + `noteOn` + A4-only `pitchBend` re-anchor sequence.
- No frequency chase, no audible glide, no state drift between UI and synth.
- `useDrone` volume noteOn throttled at 50 ms gate to suppress rapid-fire
  redundant events.

### Scheduler hygiene (v1.3.4 fixes landed in this release)

- `useMetronome`: `clearTimeout` prefix in `schedule()`; `noteOff` drain on
  stop; `setBeatInstrument` / `setSubdivisionVoice` reschedule; `start
  (preservePhase)`.
- `loadProfile` on MetroScreen batched atomically.
- `prefs.ts`: debounce retry-with-backoff + `_writeInFlight` serialization.
- `synth.cpp`: drum channel pinned to ch 9, RAII `RenderActiveGuard`,
  shutdown spin-wait (refuse-to-close-on-timeout — leak rather than UAF).

### Visual sync

- `PendulumDisplay`, `PulseDisplay`, `FlashDisplay`: driven from
  `bus.on('noteOn')` fire events instead of pulse-prop, eliminating the
  1-frame reconciler lag.
- `LedRowDisplay`: competing tweens stopped before starting new ones.

### Polish across 13 audit-wave lenses (~120 bug fixes total)

Key areas:
- **Silence over wrong**: past-atFrame drop, late-command rejection.
- **Animation smoothness**: native driver adoption, stable durations, no
  competing tweens.
- **Display sizes**: Pixel 9 Pro + 360 dp phone overflow fixes; `LedRow`
  responsive sizing; `PitchPipes` column grid; `IntonationTable` percentage
  columns.
- **Transient state**: `loadProfile` batch; `useDeck` mute-leak paths;
  native start/stop races closed.
- **Empty / loading / error states**: all four screens handle all three
  explicitly.
- **Microinteractions**: press feedback, haptics, disabled states, toast
  durations.
- **Long-session stability**: `bucketAccumsRef` cap, memory growth, wake-lock
  hygiene, file-system teardown.
- **Audio routing**: `AudioFocus` listener, `AudioCapture` sample-rate
  fallback for BT SCO, route-change recovery.
- **Theme hydration flash**: eliminated cold-launch flicker.
- **YIN state reset on instrument switch**.
- **`useMetronome` ref-sync** at `setBeatInstrument` / `setTimeSig` /
  `setSubdivisionVoice` / `loadProfile`.
- **`useAudioEngine` median fix**: even-length array off-by-one was
  mis-reporting intonation by 2–10 cents.

### Tests

- `midiBus.test.ts`: 29 cases covering channel reservation, synchrony
  contract, WAV fallback, forensic-log events.
- `useMidiBus.test.ts`: 376-line suite.
- `renderCount.test.tsx`: render-count CI assertions (SetupScreen fires zero
  re-renders on synthetic audio-buffer event; MetroScreen fires zero on
  non-metro-state update).
- `storage.test.ts`: prefs round-trip.

---

## [1.3.2] — prior release

Baseline for the v1.4 audit campaign. See git tag `7d44a81`.

---

## [1.3] — earlier

v1.3 council decisions, metro redesign, and state-machine scrub documented in
`docs/v1.3-council-decisions.md`, `docs/v1.3-metro-redesign.md`, and
`docs/v1.3-state-machine-scrub.md`.
