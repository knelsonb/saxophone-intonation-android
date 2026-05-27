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

  // ---- Event subscription ----
  addReadyListener(cb: (e: SynthReadyEvent) => void): { remove(): void };
  addUnderrunListener(cb: (e: SynthUnderrunEvent) => void): { remove(): void };
  addErrorListener(cb: (e: SynthErrorEvent) => void): { remove(): void };
}
