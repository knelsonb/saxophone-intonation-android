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
}
