/**
 * Public type surface for @local/raw-audio-output.
 *
 * The Expo module exposes a TinySoundFont-backed General MIDI synthesiser
 * over an AudioTrack render thread. Channels 0-15, MIDI notes 0-127, GM
 * patches 0-127 (bank 0 only).
 */

/** Fires once when the SF2 has loaded and the synth is initialised. */
export interface SynthReadyEvent {
  ok: boolean;
  /** Present when ok=false. Human-readable diagnostic. */
  error?: string;
}

/** Fires when AudioTrack.write returns short — the audio buffer underran. */
export interface SynthUnderrunEvent {
  /**
   * Frames the system actually accepted on the short write.
   * Compare against the renderer's framesPerRender (1024) to gauge severity.
   */
  framesAccepted: number;
}

/** Fires on a fatal AudioTrack error — render thread has stopped. */
export interface SynthErrorEvent {
  reason: string;
}

/**
 * v1.4.x P3 — fires when the audio output route changes mid-playback
 * (headphone / Bluetooth / USB plug or unplug). A route change can briefly
 * pause the AudioTrack, freezing the render-frame counter and staling the
 * frame-clock peg; the bus force-repegs on this event so subsequent scheduled
 * notes anchor to the live clock again.
 */
export interface SynthRouteChangedEvent {
  /** "added" or "removed" — which kind of device-list change triggered it. */
  kind: string;
}

/**
 * Fires when Android AudioManager delivers an audio-focus change to the synth.
 * The native OnAudioFocusChangeListener maps all loss variants
 * (AUDIOFOCUS_LOSS, AUDIOFOCUS_LOSS_TRANSIENT, AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
 * to 'audioFocusLost', and AUDIOFOCUS_GAIN to 'audioFocusGained'.
 * `type` carries the raw Android focusChange integer for diagnostics.
 */
export interface SynthAudioFocusEvent {
  /** Raw Android AudioManager focusChange constant. */
  type: number;
}

/**
 * Fires from the audio render thread (relayed via a Kotlin coroutine
 * dispatcher) at the moment a queued command is applied to TSF. NoteOn
 * is the typical interesting case — listeners use it to sync visual
 * state to the EXACT render quantum the audio fires in, not to the
 * (jittery) JS-thread enqueue moment.
 *
 * `kind`:
 *   1 = NoteOn
 *   2 = NoteOff
 *   3 = ProgramChange (midi field carries the program number)
 *   4 = PitchBend     (velocity field carries the semitone value)
 *   5 = AllNotesOff
 *   6 = SetMasterGain
 *
 * `tickKind`:
 *   0 = unspecified (legacy ASAP path / noteOn callers)
 *   1 = beat        (scheduler's beat-tick intent)
 *   2 = sub         (scheduler's sub-division tick intent)
 *
 * `atFrame`:
 *   The absolute frame index in the synth's monotonic clock at which the
 *   command was scheduled to apply. -1 if it was a fire-ASAP command.
 *   For listeners pegging visuals back to wall-clock, combine with the
 *   frame-clock peg established at init.
 */
export interface SynthCommandFiredEvent {
  kind: number;
  tickKind: number;
  channel: number;
  midi: number;
  velocity: number;
  atFrame: number;
}

/**
 * #64 Phase-1 — snapshot of the audio-output clock anchor (the ~1 Hz
 * AudioTrack.getTimestamp read; no new HAL call). All counters are sampled in
 * one render-loop iteration so the heard-time projection
 *   heard(atFrame) = nanoTime + (atFrame − gFrame + latFrames) / rate
 * lives in one consistent frame space. `nanoTime` is the SINGLE-ARG
 * getTimestamp overload = CLOCK_MONOTONIC (TIMEBASE_MONOTONIC). `valid` is
 * false until the stream is warm.
 */
export interface SynthAudioTimestamp {
  valid: boolean;
  /** CLOCK_MONOTONIC ns the DAC presented `framePosition`. */
  nanoTime?: number;
  /** AudioTimestamp.framePosition — play/presentation index (track-relative). */
  framePosition?: number;
  /** g_frame_position render-frame counter (the space `atFrame` lives in). */
  gFrame?: number;
  /** framesWritten − framePosition = buffer depth D (frames). */
  latFrames?: number;
  /** Device-native output rate (Hz). */
  rate?: number;
  /** Discontinuity generation; a change ⟹ frame-space reset (flush/underrun/route). */
  gen?: number;
}

/**
 * #64 Phase-1 — one per-downbeat sub-ms-sync shadow record. Fires only while
 * the shadow probe is armed (startShadowProbe). The measurement drives NO view
 * and does not touch the #167 pendulum PLL.
 */
export interface SynthShadowBeatEvent {
  /** Projected HEARD time of this downbeat (CLOCK_MONOTONIC ns) — ground truth. */
  beatHeardNanos: number;
  /** Untrimmed drift residual (ns), cumulative-K so it does not wrap. Slope = DAC drift, detrended noise = floor. */
  rawSkewNs: number;
  /** §2.1 per-downbeat slow-skew-trimmed residual (ns) — the as-designed control law's floor. */
  residualNs: number;
  /** 60e9 / bpm. */
  periodNanos: number;
  /** The scheduled beat frame (g_frame_position space). */
  atFrame: number;
  /** Anchor discontinuity generation at this beat. */
  gen: number;
  /** Vsyncs observed since the previous beat (≈ period/8.33ms at 120Hz). */
  vsyncFrames: number;
  /** Of those, intervals >10ms — an ARR demotion (panel left 120Hz) tell. */
  vsyncSlow: number;
  /** true = re-anchor beat (first beat / post-discontinuity) — exclude from the steady floor. */
  reset: boolean;
}

export interface RawAudioOutput {
  /**
   * Copy the bundled SF2 from assets to cache and load it into TSF.
   * Idempotent. Resolves true once the synth is ready, false on failure.
   * Also fires the `ready` event with { ok, error? } on first completion.
   */
  prepareAsync(): Promise<boolean>;

  /** Boot AudioTrack + render thread. Returns true if the worker is running. */
  start(): boolean;

  /** Tear down AudioTrack + render thread. SF2 stays loaded. */
  stop(): boolean;

  /**
   * Start a note. `channel` 0-15, `midi` 0-127, `velocity` 0.0-1.0.
   * Calling before prepareAsync resolves is safe — it just produces silence.
   */
  noteOn(channel: number, midi: number, velocity: number): void;

  /** Release a note. */
  noteOff(channel: number, midi: number): void;

  /** Set the GM patch (0-127) on a channel. Bank is always 0. */
  programChange(channel: number, program: number): void;

  /** Bend pitch on a channel by `semitones` (-12.0 .. +12.0). */
  pitchBend(channel: number, semitones: number): void;

  /** Stop all currently-sounding notes on a channel. */
  allNotesOff(channel: number): void;

  /**
   * Linear master gain. 1.0 = unity. 2.0 = +6 dB above unity (useful for
   * pushing the drone louder than the OS media-stream cap on quiet phones).
   */
  setMasterGain(gain: number): void;

  /** True once prepareAsync has completed successfully. */
  isReady(): boolean;

  /**
   * Device-native output sample rate (Hz) the synth + AudioTrack actually run
   * at (queried from the device, not hard-coded). The MIDI bus pegs its frame
   * clock at this rate so scheduled atFrame math matches the render thread.
   */
  getSampleRate(): number;

  /**
   * Latest measured write->hear latency in ms (AudioTrack.getTimestamp,
   * warm-gated, ~1 Hz). -1 until a valid reading exists. The bus holds this
   * with a deadband + debounce, so the raw value's jitter never reaches the
   * animation — consumers read the HELD value, not this directly.
   */
  getOutputLatencyMs(): number;

  /**
   * v1.4.x P1 — mirror a JS forensic-log line into Android's native log so it
   * surfaces in `adb logcat` on release builds (where RN does not pipe console
   * output). `level` is one of "debug" | "info" | "warn" | "error".
   */
  nativeLog(level: string, tag: string, msg: string): void;

  /**
   * v1.4.x P4 — pin the Activity window to the display's highest refresh rate
   * (enable=true) so the LTPO panel doesn't down-switch (120→80→60) mid-
   * animation and judder the metronome sweep; pass false to release back to the
   * system's adaptive default. Call true on foreground, false on background.
   */
  setHighRefreshRate(enable: boolean): void;

  // ---- v1.4 — scheduled-command surface ----

  /**
   * Scheduled noteOn. `atFrame` is the absolute render-frame index at which
   * the synth applies the noteOn. Buffer-granular: a command with atFrame
   * inside the current render buffer applies at the START of that buffer
   * (~23 ms at 1024 frames @ 44.1 kHz). Sub-buffer accuracy is out of scope.
   *
   * `tickKind` is round-tripped to the `commandFired` event so listeners can
   * correlate which scheduler intent (0=none, 1=beat, 2=sub) the fire
   * belongs to.
   */
  noteOnAt(channel: number, midi: number, velocity: number, atFrame: number, tickKind: number): void;

  /**
   * Monotonic render-frame counter. Increments by `framesPerRender` (1024)
   * on every successful render. Returns 0 before the first render. JS uses
   * this paired with Date.now() to peg a wall-clock → frame-clock mapping
   * for `noteOnAt` scheduling.
   */
  getCurrentFrame(): number;

  /**
   * v1.4 — Drop ALL pending scheduled commands (immediate + deferred). Call
   * from stop paths to prevent tail-firing after user-requested silence.
   *
   * Without this, a stop() that only issues allNotesOff() still leaves any
   * future-scheduled noteOns (e.g. the metronome's ~150 ms heartbeat-ahead
   * queue) sitting in the native command queue; they apply on the next
   * render quantum AFTER the user pressed stop and produce ghost clicks.
   *
   * Idempotent. Safe to call before prepareAsync resolves.
   */
  clearScheduled(): void;

  // ---- #64 Phase-1 — sub-ms sync instrumentation (measurement only) ----

  /** CLOCK_MONOTONIC nanoseconds (System.nanoTime). For the JS clock-identity co-log. */
  getMonotonicNanos(): number;

  /** Snapshot of the cached audio-clock anchor (the ~1 Hz getTimestamp read). */
  getAudioTimestamp(): SynthAudioTimestamp;

  /**
   * Set the frameTimeNanos→photon compositor+scanout constant. Cancels out of
   * the shadow residual (measurement-irrelevant in Phase 1); stored for the
   * gate-1 log + Phase-2 actuation. Default ~12.5e6 (1.5 frame @120Hz).
   */
  setDisplayPipelineNanos(ns: number): void;

  /**
   * Arm the shadow probe (idempotent — never stacks a second Choreographer
   * chain). Default-off: a normal practice session that never calls this pays
   * zero per-vsync cost.
   */
  startShadowProbe(): void;

  /** Disarm the shadow probe; removes the same Choreographer callback (paired teardown). */
  stopShadowProbe(): void;

  /**
   * Per-downbeat anchor for the shadow measurement. `beatFrame` is the #167
   * atFrame (g_frame_position space); `periodNanos` = 60e9/bpm. No-op unless the
   * probe is armed. Emits one `shadowBeat` per downbeat. Does NOT drive a view
   * or touch the #167 PLL.
   */
  setBeatAnchor(beatFrame: number, periodNanos: number): void;

  // ---- Event subscription ----
  addReadyListener(cb: (e: SynthReadyEvent) => void): { remove(): void };
  addUnderrunListener(cb: (e: SynthUnderrunEvent) => void): { remove(): void };
  addErrorListener(cb: (e: SynthErrorEvent) => void): { remove(): void };
  /**
   * Subscribe to the per-command fire event. The callback runs on the JS
   * thread (the native bridge marshals from the audio render thread via a
   * Kotlin dispatcher). Suitable for driving visual state that must match
   * the audio fire moment.
   */
  addCommandFiredListener(cb: (e: SynthCommandFiredEvent) => void): { remove(): void };
  /**
   * v1.4.x P3 — subscribe to audio output route changes. The bus uses this to
   * force-repeg the frame clock after a plug/unplug so scheduled notes keep
   * landing beat-perfect instead of dropping against a stale peg.
   */
  addRouteChangeListener(cb: (e: SynthRouteChangedEvent) => void): { remove(): void };
  /**
   * #64 Phase-1 — subscribe to per-downbeat shadow-measurement records. Fires
   * only while the probe is armed (startShadowProbe). The bus rings these as
   * BEAT_OFFSET forensic records for the sub-ms-sync gate read.
   */
  addShadowBeatListener(cb: (e: SynthShadowBeatEvent) => void): { remove(): void };
  /**
   * Subscribe to audio-focus changes delivered by Android AudioManager.
   * 'audioFocusLost' fires on any focus-loss variant (call, alarm, media app).
   * 'audioFocusGained' fires when focus is returned to this app.
   * The bus uses this to mute/unmute the synth so output is silent during
   * interruptions (silence-over-wrong: safe silence beats wrong output).
   */
  addAudioFocusListener(
    event: 'audioFocusLost' | 'audioFocusGained',
    cb: (e: SynthAudioFocusEvent) => void,
  ): { remove(): void };
}
