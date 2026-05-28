/**
 * useMidiBusCore — pure-JS factory underneath `useMidiBus`.
 *
 * Split out into its own module file (no native imports) so the Node test
 * runner can exercise the core's contracts (synchronous listener invocation,
 * channel reservation, master mute, channel-role map) without pulling in
 * `@local/raw-audio-output`. The React hook in `useMidiBus.ts` is a thin
 * lifecycle wrapper that injects the real synth singleton here.
 *
 * Architectural invariants (council-locked, see docs/v1.3-council-decisions.md):
 *
 *   U21 — Listener invocation is SYNCHRONOUS in the same JS call stack as
 *         the noteOn/Off/programChange/pitchBend that triggered the event.
 *         No microtask, no setTimeout, no EventEmitter-with-defer. Tested.
 *
 *   U23 — Channel-claim conflicts are SILENT to the user. The second
 *         caller receives `null` from reserve() and the bus emits a
 *         forensic-log entry via `log.w('Bus', 'channel-claim-denied', ...)`.
 *         No throw, no toast.
 *
 *   G13 — The bus owns the v1.1 WAV click players for synth warm-up.
 *         Drum-channel noteOns route to WAV until either `synth.isReady()`
 *         returns true OR the warm-up timeout expires. After that, all
 *         drum noteOns route to TSF (or stay on WAV if the timeout won).
 *         This concern is internal to the bus — consumers never see it.
 *
 * v1.4 additions:
 *   - SynthPort extended with optional noteOnAt, getCurrentFrame,
 *     addCommandFiredListener for the frame-clock peg path.
 *   - ChannelHandle gains noteOnAt(midi, vel, atMs, tick?) for scheduled
 *     notes; math: atFrame = originFrame + round((atMs - originMs) * sr / 1000).
 *   - createMidiBusCore gains frameClockOriginMs / originFrame internal state
 *     and an auto-repeg setInterval (every 5 s by default; 0 disables).
 *   - The bus subscribes ONCE to synth.addCommandFiredListener and re-emits
 *     fire events; 'noteOn' fire events reach bus 'noteOn' listeners; 'noteOff'
 *     fires reach 'noteOff'. The tick discriminator is threaded through.
 *   - createMidiBus (Sauron's lightweight factory) exported alongside
 *     createMidiBusCore for the new useMidiBus.ts shape and midiBus.test.ts.
 *   - vel127To01 helper exported for tests.
 *   - SchedTick, FiredPayload, FiredEvent, MidiBus exported for tests and the
 *     new useMetronome integration.
 */

// NOTE: We do NOT statically import `./log` here. The Node test runner
// strips types and resolves ESM siblings literally, and `./log` transitively
// imports `@react-native-async-storage/async-storage` which has no
// Node-resolvable main. The `useMidiBus.ts` hook wires the real logger via
// the `logger` option; tests can pass nothing and get a silent no-op.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Output route the metronome + visuals compensate for. The authoritative value
 * is the user's `metroOutputRoute` preference (a React prop on useMetronome);
 * App.tsx plumbs it into the bus via `setOutputRoute` so the bus can supply a
 * per-route latency GUESS at cold start, before a real measurement exists.
 */
export type MetroOutputRoute = 'speaker' | 'wired' | 'bluetooth';

// v1.4.x #167 — per-route base latency (ms), the COLD-START fallback for output
// compensation before AudioTrack.getTimestamp yields a real reading. Speaker is
// the workhorse default; wired is the cleanest path; Bluetooth A2DP buffering is
// generally awful (we surface a warning on the METRO screen). SINGLE SOURCE OF
// TRUTH: the bus reads this inside getCompensationLatencyMs()'s fallback, and
// useMetronome re-exports routeLatencyMs for back-compat — neither keeps its own
// copy, so the audio and visual fallbacks can never diverge.
const ROUTE_LATENCY_MS: Record<MetroOutputRoute, number> = {
  speaker:   25,
  wired:     5,
  bluetooth: 200,
};

/** Cold-start per-route latency guess (ms); speaker default for any unknown route. */
export function routeLatencyMs(route: MetroOutputRoute): number {
  return ROUTE_LATENCY_MS[route] ?? 25;
}

/** GM-respecting channel roles. Drums MUST stay 9 (GM channel 10). */
export type ChannelRole =
  | 'drone'
  | 'pipes'
  | 'drums'
  | 'aux1'
  | 'aux2'
  | 'aux3'
  | 'aux4';

/**
 * MIDI channel assignment by role.
 * - drone → 0 (melodic, sustained reference)
 * - pipes → 1 (melodic, pitch-pipe pad)
 * - drums → 9 (GM percussion — non-negotiable)
 * - aux1..aux4 → 10..13 (reserved for future consumers)
 */
export const CHANNEL_OF_ROLE: Record<ChannelRole, number> = {
  drone: 0,
  pipes: 1,
  drums: 9,
  aux1: 10,
  aux2: 11,
  aux3: 12,
  aux4: 13,
};

export type BusEventKind =
  | 'noteOn'
  | 'noteOff'
  | 'programChange'
  | 'pitchBend'
  | 'underrun';

/** Emitted to listeners on every dispatched MIDI op (synchronous, see U21). */
export interface BusEvent {
  /** Role of the channel that emitted the event. */
  channel: ChannelRole;
  /** Note number, present for noteOn/noteOff. */
  midi?: number;
  /** 0..127 velocity, present for noteOn. */
  velocity?: number;
  /** GM patch 0..127, present for programChange. */
  program?: number;
  /** Bend in semitones, present for pitchBend. */
  semitones?: number;
  /**
   * v1.3.2 — tick discriminator for percussive consumers (metronome).
   * Present on noteOn events emitted via `ChannelHandle.noteOn(midi, vel, tick)`
   * — see council §18 / G14 forward-compat. Absent on every other op and
   * absent on noteOns from callers that don't pass a tick kind (e.g. drone,
   * pipes). Consumers filtering on `tick === 'beat'` treat `undefined` as
   * non-discriminating; consumers filtering on `tick === 'sub'` likewise.
   * PerBeatRow's listener uses this to skip sub-tick noteOns so its bar-
   * position counter doesn't double-step at 8th/16th/triplet subdivisions.
   */
  tick?: 'beat' | 'sub';
}

export interface ChannelHandle {
  readonly role: ChannelRole;
  /** Set GM patch (0..127) on the channel. */
  setProgram(program: number): void;
  /**
   * Start a note. `velocity` is 0..127 (MIDI convention).
   *
   * v1.3.2 — optional `tick` discriminator is forwarded into the emitted
   * BusEvent. Percussive consumers (metronome → PerBeatRow) use it to tell
   * downbeats from sub-ticks without inferring from midi number. Callers
   * that don't care omit the arg; the BusEvent emits with `tick: undefined`.
   * Does NOT affect synth routing — only event payload.
   */
  noteOn(midi: number, velocity: number, tick?: 'beat' | 'sub'): void;
  /** Release a note. */
  noteOff(midi: number): void;
  /** Bend pitch on the channel, clamped to ±12 semitones. */
  pitchBend(semitones: number): void;
  /** Stop every note currently sounding on this channel. */
  allNotesOff(): void;
  /** Drop the channel reservation. Future reserve(role) may re-acquire. */
  release(): void;
  /**
   * v1.4 — Scheduled noteOn. `atMs` is a Date.now()-units target wall-clock.
   * The bus converts to a render-frame index using its internal frame-clock peg
   * and forwards to synth.noteOnAt. If the synth port does not support
   * noteOnAt, this is a silent no-op (ports without the method are still valid
   * for the existing reservation system). `tick` is an optional scheduler-intent
   * discriminator threaded through the native fire event.
   */
  noteOnAt(midi: number, velocity: number, atMs: number, tick?: 'beat' | 'sub'): void;
}

export interface MidiBusState {
  /** True once `synth.prepareAsync()` has resolved successfully. */
  readonly ready: boolean;
  /**
   * Reserve a channel by role. Returns null if the role is already
   * claimed (U23: caller is responsible for handling null by silently
   * falling back; the bus emits a forensic-log event but never surfaces
   * a user-visible error).
   */
  reserve(role: ChannelRole): ChannelHandle | null;
  /**
   * Global mute. Implemented as `synth.setMasterGain(0)` while muted;
   * unmute restores the most-recent `setMasterGain` target. Used by
   * useDeck during recording so every channel goes silent atomically.
   */
  setMasterMute(muted: boolean): void;
  /**
   * Update the stored master-gain target (1.0 = unity). Takes effect
   * immediately unless the bus is currently master-muted, in which case
   * the new target is applied on unmute.
   */
  setMasterGain(gain: number): void;
  /**
   * Subscribe to bus events.
   *
   * IMPORTANT (U21): listeners are invoked SYNCHRONOUSLY in the same JS
   * call stack as the noteOn/Off/programChange/pitchBend call that
   * triggered them — there is NO microtask, NO setTimeout, NO event-queue
   * defer. A visual UI flash bound to 'noteOn' will paint on the same
   * frame the synth received the note, with zero drift behind the audio.
   *
   * Listeners are called in subscription order. Throwing from a listener
   * is logged (`log.e('Bus', 'listener-throw', ...)`) and does NOT
   * prevent subsequent listeners from running.
   *
   * Returns an unsubscribe function.
   */
  on(event: BusEventKind, listener: (e: BusEvent) => void): () => void;
  /**
   * v1.4 — Drop ALL pending scheduled commands (top-level, not per-channel).
   * Called from stop paths BEFORE allNotesOff() so future-scheduled noteOns
   * can't tail-fire after user-requested silence. Idempotent. Silent no-op
   * if the underlying synth port doesn't support scheduled queues.
   */
  clearScheduled(): void;
  /**
   * v1.4 — Read the synth's monotonic render-frame counter. Used by the
   * scheduler to gate past-atFrame skips (Belt 2). Returns 0 before the
   * first render — callers MUST treat 0 as "synth not yet rendering" and
   * skip scheduling rather than computing against zero.
   */
  getCurrentFrame(): number;
  /**
   * v1.4 — Convert wall-clock ms → absolute frame index using the current
   * peg. Returns NaN if the bus has not yet been pegged (synth not started).
   * Callers MUST handle NaN by silent-skip + log (silence-over-wrong axiom).
   */
  atMsToAtFrame(atMs: number): number;
  /**
   * v1.4 wave-3 — Force a fresh frame-clock peg. The normal auto-repeg
   * (every 5 s) tracks steady clock drift but rejects re-pegs whose implied
   * shift exceeds REPEG_DRIFT_THRESHOLD_MS (50 ms — a process-pause-sized
   * jump). At known-good discontinuities (AppState background → foreground
   * resume) the renderer paused while wall-clock advanced — the drift is huge
   * but legitimate.
   * Call `repegFrameClock({ force: true })` to bypass the drift gate AND
   * pair with `clearScheduled()` to drop any stale future-scheduled commands.
   * No-op if the underlying synth port doesn't support frame counters.
   */
  repegFrameClock(opts?: { force?: boolean }): void;
  /**
   * v1.4.x #167 — the EFFECTIVE output-latency compensation (ms). The bus
   * measures the real write->hear latency on triggers (start / route change /
   * recovery) and via a low-rate watchdog, holds it with a 30 ms deadband + 5 s
   * debounce so the value is piecewise-constant (no per-frame jitter). When a
   * measurement exists it returns the held value; UNTIL then it returns the
   * per-route cold-start GUESS (routeLatencyMs of the route set via
   * setOutputRoute) — so it is ALWAYS a usable positive latency, never 0.
   * BOTH consumers (useMetronome scheduling AND the pendulum phase-lead) read
   * this one number, so audio and visuals compensate by the SAME amount in
   * every state — the single source of truth for "how late is the heard click".
   * Optional so legacy mocks omit it. O(1): two ref reads + a map lookup.
   */
  getCompensationLatencyMs?(): number;
  /**
   * v1.4.x #167 — tell the bus which output route the user selected, so its
   * cold-start latency guess matches the real path (speaker/wired/BT). The
   * authoritative value is the `metroOutputRoute` preference; App.tsx pushes it
   * here whenever it changes. Stored in a ref (NOT the build-once interface memo
   * dep) so a route change never churns the bus identity. Optional for mocks.
   */
  setOutputRoute?(route: MetroOutputRoute): void;
}

// ---------------------------------------------------------------------------
// Synth port (dependency-injected so the core is testable)
// ---------------------------------------------------------------------------

/**
 * The minimal slice of `@local/raw-audio-output` the bus uses. Defined as
 * an interface so the Node test runner can pass a mock without pulling in
 * the native module.
 *
 * v1.4 additions are optional (?) so existing SynthPort mocks in tests
 * continue to satisfy the interface without adding stub implementations.
 */
export interface SynthPort {
  prepareAsync(): Promise<boolean>;
  start(): boolean;
  noteOn(channel: number, midi: number, velocity: number): void;
  noteOff(channel: number, midi: number): void;
  programChange(channel: number, program: number): void;
  pitchBend(channel: number, semitones: number): void;
  allNotesOff(channel: number): void;
  setMasterGain(gain: number): void;
  isReady(): boolean;
  addReadyListener(cb: (e: { ok: boolean; error?: string }) => void): { remove(): void };
  addUnderrunListener?(cb: (e: { framesAccepted: number }) => void): { remove(): void };
  // v1.4 — scheduled-command surface. Optional so legacy mocks remain valid.
  noteOnAt?(channel: number, midi: number, velocity: number, atFrame: number, tickKind: number): void;
  getCurrentFrame?(): number;
  /** Device-native output sample rate (Hz). Used to peg the frame clock at the
   * SAME rate the render thread advances g_frame_position. Optional so legacy
   * mocks remain valid (they fall back to the configured default). */
  getSampleRate?(): number;
  /** Latest MEASURED write->hear latency (ms); -1 until warm. The bus holds
   * this with a deadband/debounce — consumers read getCompensationLatencyMs. */
  getOutputLatencyMs?(): number;
  addCommandFiredListener?(cb: (e: FiredPayload) => void): { remove(): void };
  /**
   * v1.4 — Drop all pending scheduled commands. Called from stop paths to
   * prevent tail-firing after user-requested silence. Optional so legacy
   * mocks remain valid; ports without it are a silent no-op on bus.clearScheduled.
   */
  clearScheduled?(): void;
}

/**
 * Optional WAV-fallback port for the drum channel (G13).
 *
 * The bus calls `playClick(accent)` for every drum noteOn until either the
 * synth reports ready OR the warm-up timeout expires. Once ready/expired,
 * the port is no longer consulted. If `null` is provided, drum noteOns
 * during warm-up are dropped silently and logged.
 */
export interface DrumFallbackPort {
  /** Play one click. `accent` true → downbeat sample, false → normal. */
  playClick(accent: boolean): void;
  /** Tear down any audio resources. Called on bus dispose. */
  dispose(): void;
}

/**
 * Forensic-log port. Production wires `src/log.ts`; tests pass a no-op or
 * a capturing stub. Defined here so the core has no static dependency on
 * the AsyncStorage-backed logger module.
 */
export interface BusLogger {
  d(tag: string, msg: string, ...args: unknown[]): void;
  w(tag: string, msg: string, ...args: unknown[]): void;
  e(tag: string, msg: string, ...args: unknown[]): void;
}

/** Default logger — no-ops. The hook installs the real `log` instance. */
const NOOP_LOGGER: BusLogger = {
  d() {
    /* noop */
  },
  w() {
    /* noop */
  },
  e() {
    /* noop */
  },
};

// ---------------------------------------------------------------------------
// v1.4 — Scheduled-command types (also used by createMidiBus)
// ---------------------------------------------------------------------------

/** Tick discriminator threaded through scheduled commands. */
export type SchedTick = 'beat' | 'sub' | 'none';

function tickToInt(tick: SchedTick): number {
  switch (tick) {
    case 'beat': return 1;
    case 'sub':  return 2;
    default:     return 0;
  }
}

function intToTick(n: number): SchedTick {
  switch (n) {
    case 1: return 'beat';
    case 2: return 'sub';
    default: return 'none';
  }
}

/** Raw shape of the native commandFired event. */
export interface FiredPayload {
  kind: number;
  tickKind: number;
  channel: number;
  midi: number;
  velocity: number;
  atFrame: number;
}

/** Bus-level normalised fire event surfaced to addFiredListener subscribers. */
export interface FiredEvent {
  kind: 'noteOn' | 'noteOff' | 'programChange' | 'pitchBend' | 'allNotesOff' | 'setMasterGain';
  tick: SchedTick;
  channel: number;
  midi: number;
  /** 0..1 for NoteOn; 0 for NoteOff; semitones for PitchBend; program for ProgramChange. */
  velocity: number;
  /** Absolute frame the command applied at, or -1 for fire-ASAP commands. */
  atFrame: number;
}

function kindIntToString(k: number): FiredEvent['kind'] {
  switch (k) {
    case 1: return 'noteOn';
    case 2: return 'noteOff';
    case 3: return 'programChange';
    case 4: return 'pitchBend';
    case 5: return 'allNotesOff';
    default: return 'setMasterGain';
  }
}

/**
 * Convert MIDI velocity (0..127) to TSF's 0..1 range. Clamp + linear scale.
 * Exported for tests.
 */
export function vel127To01(v127: number): number {
  if (!Number.isFinite(v127)) return 0;
  if (v127 <= 0) return 0;
  if (v127 >= 127) return 1;
  return v127 / 127;
}

// ---------------------------------------------------------------------------
// v1.4 — createMidiBus: lightweight channel-by-number bus (Sauron's factory)
// ---------------------------------------------------------------------------
// Exported alongside createMidiBusCore so useMidiBus.ts (Sauron's version)
// and midiBus.test.ts can use it. Does NOT use channel roles, channel
// reservation, master mute, or the warm-up WAV fallback path — those concerns
// live in createMidiBusCore. createMidiBus is the thin scheduling layer.

/**
 * Minimal synth surface required by createMidiBus. Narrower than SynthPort
 * so tests can pass a lightweight mock without implementing prepareAsync,
 * start, addReadyListener etc. (those are createMidiBusCore concerns).
 */
export interface MidiBusSynthPort {
  noteOn(channel: number, midi: number, velocity: number): void;
  noteOff(channel: number, midi: number): void;
  programChange(channel: number, program: number): void;
  pitchBend(channel: number, semitones: number): void;
  allNotesOff(channel: number): void;
  noteOnAt?(channel: number, midi: number, velocity: number, atFrame: number, tickKind: number): void;
  getCurrentFrame?(): number;
  addCommandFiredListener?(cb: (e: FiredPayload) => void): { remove(): void };
  /** v1.4 — drop all pending scheduled commands (immediate + deferred). */
  clearScheduled?(): void;
}

/**
 * Per-channel handle for the createMidiBus factory. Different from
 * the role-based ChannelHandle used by createMidiBusCore.
 */
export interface BusChannelHandle {
  readonly channel: number;
  noteOn(midi: number, velocity127: number): void;
  noteOff(midi: number): void;
  programChange(program: number): void;
  pitchBend(semitones: number): void;
  allNotesOff(): void;
  /**
   * Scheduled noteOn. `atMs` is a Date.now()-units target. `tick` is a
   * scheduler-intent discriminator the bus round-trips back through the
   * native fire-event so listeners can correlate.
   */
  noteOnAt(midi: number, velocity127: number, atMs: number, tick?: SchedTick): void;
}

export interface MidiBus {
  /** Get (or implicitly create) the handle for a channel. */
  channel(ch: number): BusChannelHandle;
  /** Force a wall-clock ↔ frame-clock re-peg. Idempotent. */
  repeg(): void;
  /** Convert wall-clock ms → absolute frame index using the current peg. */
  atMsToAtFrame(atMs: number): number;
  /** Subscribe to fire events (post-apply, audio-thread accurate). */
  addFiredListener(cb: (e: FiredEvent) => void): () => void;
  /**
   * v1.4 — Drop ALL pending scheduled commands (top-level, not per-channel).
   * Called from stop paths to prevent tail-firing after user-requested
   * silence. Routes through to synth.clearScheduled if the port supports it;
   * otherwise a silent no-op.
   * // v1.4-followup: per-channel cancel if a future consumer needs it.
   */
  clearScheduled(): void;
  /** Tear down listeners + timers. */
  dispose(): void;
}

interface BusConfig {
  synth: MidiBusSynthPort;
  sampleRate: number;
  /** Default 5000 ms. Pass 0 to disable auto re-peg (tests). */
  repegIntervalMs?: number;
  /** Pluggable now() — defaults to Date.now. Tests inject. */
  now?: () => number;
}

export function createMidiBus(cfg: BusConfig): MidiBus {
  const { synth, sampleRate } = cfg;
  const now = cfg.now ?? (() => Date.now());
  const repegIntervalMs = cfg.repegIntervalMs ?? 5000;

  // Frame-clock peg. originMs is in Date.now() units; originFrame is the
  // synth's render-frame counter at the same wall-clock instant. The pair
  // defines a linear map atMs → atFrame.
  let originMs = 0;
  let originFrame = 0;
  let pegged = false;

  // Reject a re-peg only when the implied shift looks like a real
  // discontinuity (a process pause / audio-thread stall), NOT steady clock
  // drift. The audio DAC crystal and the system wall clock genuinely diverge
  // (observed ~1300 ppm on a Pixel 9 Pro → ~6.5 ms per 5 s repeg interval);
  // that drift is LEGITIMATE and must be TRACKED, or the peg goes permanently
  // stale and scheduling error accumulates without bound (we saw 38 ms over
  // 30 s when the old 2 ms gate rejected every re-peg). 50 ms comfortably
  // accepts steady drift and small GC hitches while still catching genuine
  // multi-hundred-ms suspensions — those are also covered by the force-repeg on
  // AppState resume / metronome start.
  const REPEG_DRIFT_THRESHOLD_MS = 50;

  function repeg(): void {
    // We sample synth.getCurrentFrame() and now() as close together as we
    // can. There's an unavoidable JS-thread gap between the two reads, but
    // it's deterministic at single-digit microseconds on V8/Hermes and
    // dwarfed by the 23 ms render quantum we're already buffer-granular to.
    const f = synth.getCurrentFrame ? synth.getCurrentFrame() : 0;
    const t = now();
    // P5/Aragorn — never RE-anchor to frame 0 (a counter reset), and never
    // commit a backward wall-clock step (non-monotonic Date.now). Either would
    // corrupt the origin pair; hold the prior peg. (The FIRST peg at frame 0 is
    // legitimate — a cold start before the renderer has ticked — so only guard
    // once already pegged.)
    if (pegged && f <= 0) return;
    if (pegged && t < originMs) return;
    // First-time peg has nothing to compare against — accept unconditionally.
    if (!pegged) {
      originFrame = f;
      originMs = t;
      pegged = true;
      return;
    }
    // v1.4 — drift gate. Project the OLD peg forward to the new wall-clock
    // moment; reject if the implied frame shift exceeds the threshold.
    // Silence-over-wrong: hold the prior peg, drop scheduling math for one
    // re-peg interval rather than snap onto a suspect new origin.
    const projectedOldFrame = originFrame + Math.round(((t - originMs) * sampleRate) / 1000);
    const frameDelta = f - projectedOldFrame;
    const msDelta = Math.abs((frameDelta * 1000) / sampleRate);
    if (msDelta > REPEG_DRIFT_THRESHOLD_MS) {
      // No logger plumbed through createMidiBus; intentionally silent here.
      // createMidiBusCore (role bus) has the same gate WITH log.w plumbing.
      // // v1.4-followup: add an optional logger arg to createMidiBus.
      return;
    }
    originFrame = f;
    originMs = t;
  }

  function atMsToAtFrame(atMs: number): number {
    if (!pegged) repeg();
    // v1.4 — if peg still failed (no getCurrentFrame at all), return NaN.
    // The frame=0 case is intentionally NOT guarded here — small past-delta
    // commands are handled by the C++ 500 ms threshold (apply-time) rather
    // than blocking at schedule time. Blocking here would prevent legitimate
    // scheduling during the brief window when synth has pegged but not yet
    // rendered a buffer.
    if (!pegged) return Number.NaN;
    const deltaMs = atMs - originMs;
    // Math.round to avoid the fractional-frame DC bias on very small deltas.
    return originFrame + Math.round((deltaMs * sampleRate) / 1000);
  }

  // ---- Channel handles ----

  const handles = new Map<number, BusChannelHandle>();

  function makeHandle(ch: number): BusChannelHandle {
    return {
      channel: ch,
      noteOn(midi, velocity127) {
        synth.noteOn(ch, midi, vel127To01(velocity127));
      },
      noteOff(midi) {
        synth.noteOff(ch, midi);
      },
      programChange(program) {
        synth.programChange(ch, program);
      },
      pitchBend(semitones) {
        synth.pitchBend(ch, semitones);
      },
      allNotesOff() {
        synth.allNotesOff(ch);
      },
      noteOnAt(midi, velocity127, atMs, tick) {
        if (!synth.noteOnAt) return; // v1.4-followup: log if port lacks method.
        const atFrame = atMsToAtFrame(atMs);
        // v1.4 wave-6 — silence-over-wrong: atMsToAtFrame returns NaN when the
        // frame clock isn't pegged yet. Passing NaN to native code is undefined
        // behaviour; skip silently (no logger plumbed through createMidiBus).
        if (!Number.isFinite(atFrame)) return;
        synth.noteOnAt(ch, midi, vel127To01(velocity127), atFrame, tickToInt(tick ?? 'none'));
      },
    };
  }

  function channel(ch: number): BusChannelHandle {
    let h = handles.get(ch);
    if (!h) {
      h = makeHandle(ch);
      handles.set(ch, h);
    }
    return h;
  }

  // ---- Fire event re-emission ----

  const firedListeners = new Set<(e: FiredEvent) => void>();

  let synthFiredSub: { remove(): void } | null = null;
  if (synth.addCommandFiredListener) {
    synthFiredSub = synth.addCommandFiredListener((raw: FiredPayload) => {
      const evt: FiredEvent = {
        kind: kindIntToString(raw.kind),
        tick: intToTick(raw.tickKind),
        channel: raw.channel,
        midi: raw.midi,
        velocity: raw.velocity,
        atFrame: raw.atFrame,
      };
      // Dispatch in a try-per-listener loop so one throwing subscriber doesn't
      // block downstream subscribers.
      for (const cb of firedListeners) {
        try { cb(evt); } catch { /* swallow */ }
      }
    });
  }

  function addFiredListener(cb: (e: FiredEvent) => void): () => void {
    firedListeners.add(cb);
    return () => { firedListeners.delete(cb); };
  }

  // ---- Auto re-peg timer ----

  let repegTimer: ReturnType<typeof setInterval> | null = null;
  if (repegIntervalMs > 0) {
    // Initial peg right away so the first scheduling call has valid math.
    repeg();
    repegTimer = setInterval(repeg, repegIntervalMs);
  }

  function clearScheduled(): void {
    // v1.4 — top-level cancel. Routes to the native queue-drop if the port
    // supports it. Silent no-op on legacy ports (without the method) — the
    // stop path that called this still proceeds to allNotesOff() so any
    // already-sounding voices stop; the only thing lost on a legacy port is
    // the future-scheduled drop, which legacy ports can't enqueue anyway.
    if (!synth.clearScheduled) return;
    try { synth.clearScheduled(); } catch { /* swallow — caller is a stop path */ }
  }

  function dispose(): void {
    try { synthFiredSub?.remove(); } catch { /* ignore */ }
    if (repegTimer !== null) {
      clearInterval(repegTimer);
      repegTimer = null;
    }
    firedListeners.clear();
    handles.clear();
  }

  return {
    channel,
    repeg,
    atMsToAtFrame,
    addFiredListener,
    clearScheduled,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// createMidiBusCore options
// ---------------------------------------------------------------------------

export interface MidiBusCoreOptions {
  /** Synth surface. Production wires `@local/raw-audio-output` here. */
  synth: SynthPort;
  /** Optional WAV fallback for drums during synth warm-up. */
  drumFallback?: DrumFallbackPort | null;
  /**
   * Warm-up timeout in ms. After this elapses, drum noteOns route to
   * TSF (or stay on the WAV path if it's still the only thing available).
   * Default 8000 ms — approximately 4 bars at 120 BPM, per G13.
   */
  warmupTimeoutMs?: number;
  /** Initial master-gain target (1.0 = unity). Default 1.0. */
  initialMasterGain?: number;
  /** Hook to notify React when `ready` flips true. */
  onReadyChange?: (ready: boolean) => void;
  /** Forensic logger. Default is a no-op (test ergonomics). */
  logger?: BusLogger;
  /**
   * v1.4 — sample rate for frame-clock peg math. Defaults to 44100.
   * Must match the native module's SAMPLE_RATE constant.
   */
  sampleRate?: number;
  /**
   * v1.4 — auto-repeg interval in ms. Default 5000; pass 0 to disable.
   * The bus pegs on construction (if the synth port supports getCurrentFrame)
   * and then re-pegs every repegIntervalMs to bound wall-clock drift.
   */
  repegIntervalMs?: number;
  /** v1.4 — pluggable now(). Defaults to Date.now. Tests inject. */
  now?: () => number;
}

/** Internal interface exposed for hook composition + tests. */
export interface MidiBusCore extends MidiBusState {
  /** Tear down all reservations, stop all notes, clear listeners, dispose fallback. */
  dispose(): void;
  /** Read-only synchronous accessor — useful for tests that don't render. */
  isReady(): boolean;
}

// ---------------------------------------------------------------------------
// Core factory (pure JS — no React, no native imports)
// ---------------------------------------------------------------------------

type Listener = (e: BusEvent) => void;

const DEFAULT_WARMUP_TIMEOUT_MS = 8000;

function clampBend(semitones: number): number {
  if (!Number.isFinite(semitones)) return 0;
  if (semitones > 12) return 12;
  if (semitones < -12) return -12;
  return semitones;
}

function clampMidi(midi: number): number {
  if (!Number.isFinite(midi)) return 0;
  if (midi < 0) return 0;
  if (midi > 127) return 127;
  return Math.round(midi);
}

function clampVelocity127(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 127) return 127;
  return v;
}

function clampProgram(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 127) return 127;
  return Math.round(p);
}

/**
 * Pure factory that returns a `MidiBusCore`. The React hook in useMidiBus
 * wraps this with a state setter for `ready` reactivity and mount/unmount.
 */
export function createMidiBusCore(opts: MidiBusCoreOptions): MidiBusCore {
  const synthPort = opts.synth;
  const drumFallback: DrumFallbackPort | null = opts.drumFallback ?? null;
  const warmupTimeoutMs = opts.warmupTimeoutMs ?? DEFAULT_WARMUP_TIMEOUT_MS;
  const onReadyChange = opts.onReadyChange;
  const log: BusLogger = opts.logger ?? NOOP_LOGGER;

  // v1.4 — frame-clock peg state. Only active when the synth port exposes
  // getCurrentFrame and noteOnAt (optional methods added in v1.4).
  const sampleRate = opts.sampleRate ?? 44100;
  const repegIntervalMs = opts.repegIntervalMs ?? 5000;
  const nowFn = opts.now ?? (() => Date.now());
  let frameOriginMs = 0;
  let frameOriginFrame = 0;
  let frameClockPegged = false;
  let repegTimer: ReturnType<typeof setInterval> | null = null;

  // Reject a re-peg only when the implied shift looks like a real
  // discontinuity (a process pause / audio-thread stall), NOT steady clock
  // drift. The audio DAC crystal and the system wall clock genuinely diverge
  // (observed ~1300 ppm on a Pixel 9 Pro → ~6.5 ms per 5 s repeg interval);
  // that drift is LEGITIMATE and must be TRACKED, or the peg goes permanently
  // stale and scheduling error accumulates without bound (we saw 38 ms over
  // 30 s when the old 2 ms gate rejected every re-peg). 50 ms comfortably
  // accepts steady drift and small GC hitches while still catching genuine
  // multi-hundred-ms suspensions — those are also covered by the force-repeg on
  // AppState resume / metronome start.
  const REPEG_DRIFT_THRESHOLD_MS = 50;

  function repegFrameClock(opts?: { force?: boolean }): void {
    if (!synthPort.getCurrentFrame) return;
    // v1.4 wave-6 — guard against synth disposed mid-call; if it throws, hold
    // the prior peg and wait for the next auto-repeg tick.
    let newFrame: number;
    try {
      newFrame = synthPort.getCurrentFrame();
    } catch (err) {
      log.w('Bus', 'repeg-getCurrentFrame-threw', { err: String(err) });
      return;
    }
    const newMs = nowFn();
    // P5/Aragorn — never RE-anchor to frame 0: a mid-session counter reset would
    // map wall-clock onto a counter about to jump from 0, producing wrong
    // atFrames. Hold the prior peg instead. The FIRST peg at frame 0 is
    // legitimate (cold start before the renderer ticks; atMsToAtFrame's
    // frame-zero guard returns NaN until it advances), so only guard once
    // already pegged.
    if (frameClockPegged && newFrame <= 0) {
      log.w('Bus', 'repeg-skipped-frame-zero');
      return;
    }
    // P5/Aragorn — Date.now() is non-monotonic (NTP step, DST, manual change).
    // If wall-clock went BACKWARD relative to the current origin, do not commit
    // a backward peg (even on force) — hold the prior peg; the next forward tick
    // re-pegs cleanly. Prevents a clock step from corrupting the origin pair.
    if (frameClockPegged && newMs < frameOriginMs) {
      log.w('Bus', 'repeg-skipped-clock-backward', { newMs, oldMs: frameOriginMs });
      return;
    }
    // First-time peg has nothing to compare against — accept unconditionally.
    if (!frameClockPegged) {
      frameOriginFrame = newFrame;
      frameOriginMs = newMs;
      frameClockPegged = true;
      return;
    }
    // v1.4 wave-3 — force=true bypasses the drift gate. Used at known-good
    // discontinuities (AppState background → foreground resume) where the
    // renderer paused while wall-clock kept moving; the implied drift is huge
    // but legitimate, and the prior peg is exactly what needs to be replaced.
    if (opts?.force) {
      frameOriginFrame = newFrame;
      frameOriginMs = newMs;
      return;
    }
    // v1.4 — drift gate. Compute what atFrame=newFrame would have been
    // under the OLD peg, and reject the re-peg if the implied shift exceeds
    // REPEG_DRIFT_THRESHOLD_MS. Silence-over-wrong: hold the prior peg, log,
    // wait for the next attempt.
    const projectedOldFrame = frameOriginFrame + Math.round(((newMs - frameOriginMs) * sampleRate) / 1000);
    const frameDelta = newFrame - projectedOldFrame;
    const msDelta = Math.abs((frameDelta * 1000) / sampleRate);
    if (msDelta > REPEG_DRIFT_THRESHOLD_MS) {
      log.w('Bus', 'repeg-drift-rejected', {
        msDelta: Math.round(msDelta * 100) / 100,
        thresholdMs: REPEG_DRIFT_THRESHOLD_MS,
        newFrame,
        newMs,
        oldFrame: frameOriginFrame,
        oldMs: frameOriginMs,
      });
      return;
    }
    frameOriginFrame = newFrame;
    frameOriginMs = newMs;
  }

  function atMsToAtFrame(atMs: number): number {
    if (!frameClockPegged) repegFrameClock();
    // v1.4 — silence-over-wrong: if we still don't have a peg (e.g. synth
    // port has no getCurrentFrame, or it returned 0 before render started),
    // signal "not computable" with NaN. Callers must skip the noteOnAt.
    if (!frameClockPegged) return Number.NaN;
    // v1.4 wave-6 — getCurrentFrame() can throw if synth was disposed between
    // the frameClockPegged check above and this call. Treat as frame=0
    // (unpegged / not-yet-rendering) → silence-over-wrong: return NaN.
    let currentFrame: number;
    try {
      currentFrame = synthPort.getCurrentFrame ? synthPort.getCurrentFrame() : 0;
    } catch (err) {
      log.w('Bus', 'atMsToAtFrame-getCurrentFrame-threw', { err: String(err) });
      return Number.NaN;
    }
    if (frameOriginFrame === 0 && currentFrame === 0) {
      // Synth not yet rendering — frame clock is frozen at 0. Computing
      // against zero would generate atFrames in the past once the renderer
      // catches up, which the C++ apply-time guard would drop anyway. Skip
      // at the JS site so the log entry is clean.
      log.w('Bus', 'atMsToAtFrame-frame-zero', { atMs });
      return Number.NaN;
    }
    const deltaMs = atMs - frameOriginMs;
    return frameOriginFrame + Math.round((deltaMs * sampleRate) / 1000);
  }

  // Perform initial peg and arm the auto-repeg interval now.
  // repeg() on construction: if getCurrentFrame is not yet available (synth
  // not ready), this is a no-op and frameClockPegged stays false. On the
  // first actual noteOnAt call atMsToAtFrame will repeg lazily.
  if (repegIntervalMs > 0 && synthPort.getCurrentFrame) {
    repegFrameClock();
    repegTimer = setInterval(repegFrameClock, repegIntervalMs);
  }

  // Reservation map: role → handle (or undefined if free).
  const reservations = new Map<ChannelRole, ChannelHandle>();

  // Listener map: synchronous Set per event kind.
  const listeners: Record<BusEventKind, Set<Listener>> = {
    noteOn: new Set(),
    noteOff: new Set(),
    programChange: new Set(),
    pitchBend: new Set(),
    underrun: new Set(),
  };

  // Master gain target. Mutated by setMasterGain; written through to synth.
  let masterGainTarget = opts.initialMasterGain ?? 1.0;
  let masterMuted = false;

  // Ready latch + warm-up window.
  // v1.4 wave-7 — T1: wrap isReady() in case the native port throws during
  // factory construction. Default to false (not ready) so callers see a safe
  // initial state and the warm-up path can recover normally.
  // v1.4 wave-10 T3 — single-shot guard: log the FIRST drum noteOn that routes
  // to WAV fallback so future logcat sessions can confirm the fallback path was
  // taken. No user-facing change.
  let wavFallbackLoggedOnce = false;
  let ready: boolean;
  try {
    ready = synthPort.isReady();
  } catch (err) {
    log.w('Bus', 'isReady-threw-at-init', { err: String(err) });
    ready = false;
  }
  let warmupExpired = false;
  let warmupTimer: ReturnType<typeof setTimeout> | null = null;

  // Track per-channel sounding notes so release() can be precise.
  const soundingByChannel = new Map<number, Set<number>>();

  function recordNoteOn(channel: number, midi: number): void {
    let set = soundingByChannel.get(channel);
    if (!set) {
      set = new Set();
      soundingByChannel.set(channel, set);
    }
    set.add(midi);
  }
  function recordNoteOff(channel: number, midi: number): void {
    const set = soundingByChannel.get(channel);
    if (set) set.delete(midi);
  }

  // Apply master gain to the synth, honouring mute.
  function applyMasterGain(): void {
    try {
      synthPort.setMasterGain(masterMuted ? 0 : masterGainTarget);
    } catch (err) {
      log.e('Bus', 'setMasterGain-threw', { err: String(err) });
    }
  }
  // Establish initial gain immediately so a consumer who reserves before
  // prepareAsync resolves still hears their notes at the configured level.
  applyMasterGain();

  // Synchronous listener emit. Throws in user code are caught and logged.
  function emit(kind: BusEventKind, ev: BusEvent): void {
    const set = listeners[kind];
    if (set.size === 0) return;
    // Snapshot to allow listeners to unsubscribe inside their own callback.
    const snapshot = Array.from(set);
    for (const fn of snapshot) {
      try {
        fn(ev);
      } catch (err) {
        log.e('Bus', 'listener-throw', { kind, err: String(err) });
      }
    }
  }

  // ---- ready latch wiring ----
  function markReady(): void {
    if (ready) return;
    ready = true;
    if (warmupTimer !== null) {
      clearTimeout(warmupTimer);
      warmupTimer = null;
    }
    // v1.4 — perform initial frame-clock peg now that the synth is live.
    // The auto-repeg interval is already armed (or disabled). We do a one-
    // shot repeg here so the very first noteOnAt call has valid math even
    // if repegIntervalMs is large.
    repegFrameClock();
    log.d('Bus', 'synth-ready');
    if (onReadyChange) {
      try {
        onReadyChange(true);
      } catch (err) {
        log.e('Bus', 'onReadyChange-threw', { err: String(err) });
      }
    }
  }

  // Kick off prepareAsync. If it resolves true, latch ready immediately;
  // otherwise rely on the ready event (some implementations report via the
  // listener path even when the promise rejects).
  let prepareSettled = false;
  synthPort
    .prepareAsync()
    .then((ok) => {
      prepareSettled = true;
      if (ok) {
        try {
          synthPort.start();
        } catch (err) {
          log.e('Bus', 'start-threw', { err: String(err) });
        }
        markReady();
      } else {
        log.w('Bus', 'prepareAsync-returned-false');
      }
    })
    .catch((err: unknown) => {
      prepareSettled = true;
      log.e('Bus', 'prepareAsync-threw', { err: String(err) });
    });

  const readySub = synthPort.addReadyListener((e) => {
    if (e.ok) markReady();
    else log.w('Bus', 'ready-event-not-ok', { error: e.error });
  });

  // Underrun forwarding for the diagnostic channel.
  const underrunSub = synthPort.addUnderrunListener?.((e) => {
    log.w('Bus', 'underrun', { framesAccepted: e.framesAccepted });
    // Synchronous emit on the 'underrun' channel. We pick a synthetic
    // role so the event still typechecks; consumers filter on kind.
    emit('underrun', { channel: 'drone' });
  });

  // v1.4 — subscribe ONCE to commandFired events and re-emit through bus
  // listeners. NoteOn fire events re-emit on the 'noteOn' listener set so
  // any bus subscriber on 'noteOn' receives both immediate and scheduled
  // fires. NoteOff similarly re-emits on 'noteOff'. The tick discriminator
  // is forwarded via the BusEvent.tick field.
  const firedSub = synthPort.addCommandFiredListener?.((raw: FiredPayload) => {
    if (raw.kind === 1) {
      // NoteOn fire. Map back to role for the BusEvent. Best-effort: find
      // the reserved role for this channel. Falls back to 'drone' (synthetic)
      // if the channel is not currently reserved — this is intentional; the
      // fired event is audio-thread accurate and its channel field gives the
      // raw MIDI channel anyway.
      // v1.4 wave-7 — T2: validate velocity before conversion. Native can send
      // NaN or Infinity; propagating those to listeners violates the
      // silence-over-wrong contract. Mirror the guards already on lines ~353
      // and ~677. Drop the event entirely on bad velocity — don't emit silence.
      // v1.4 wave-9 — T2: guard upper bound too; > 1 would cause
      // Math.round(raw.velocity * 127) to exceed 127 (contract violation).
      if (!Number.isFinite(raw.velocity) || raw.velocity < 0 || raw.velocity > 1) {
        log.w('Bus', 'commandFired-velocity-invalid', { raw });
        return;
      }
      const role = resolveRole(raw.channel);
      emit('noteOn', {
        channel: role,
        midi: raw.midi,
        velocity: Math.round(raw.velocity * 127),
        tick: intToTick(raw.tickKind) === 'none' ? undefined : (intToTick(raw.tickKind) as 'beat' | 'sub'),
      });
    } else if (raw.kind === 2) {
      // NoteOff fire.
      const role = resolveRole(raw.channel);
      emit('noteOff', { channel: role, midi: raw.midi });
    }
    // Other kinds (programChange, pitchBend, etc.) are not re-emitted on bus
    // listeners — those are ASAP commands and already have synchronous U21
    // coverage from the direct call path. // v1.4-followup: if any consumer
    // needs to correlate programChange fire timing, extend here.
  });

  // Helper: resolve MIDI channel number → ChannelRole. Returns 'drone' as a
  // synthetic fallback for unregistered channels.
  function resolveRole(ch: number): ChannelRole {
    for (const [role, handle] of reservations.entries()) {
      if (CHANNEL_OF_ROLE[role] === ch) return role;
    }
    return 'drone';
  }

  // Warm-up timeout: after this many ms, force the warmup window closed
  // regardless of ready state so drum traffic stops trying WAV.
  warmupTimer = setTimeout(() => {
    warmupExpired = true;
    warmupTimer = null;
    if (!ready) {
      log.w('Bus', 'warmup-timeout', { ms: warmupTimeoutMs });
    }
  }, warmupTimeoutMs);

  // Build a channel handle bound to a role.
  function makeHandle(role: ChannelRole): ChannelHandle {
    const ch = CHANNEL_OF_ROLE[role];
    let released = false;

    const handle: ChannelHandle = {
      role,

      setProgram(program: number) {
        if (released) {
          log.w('Bus', 'setProgram-after-release', { role });
          return;
        }
        const p = clampProgram(program);
        try {
          synthPort.programChange(ch, p);
        } catch (err) {
          log.e('Bus', 'programChange-threw', { role, err: String(err) });
        }
        log.d('Bus', 'programChange', { role, ch, program: p });
        emit('programChange', { channel: role, program: p });
      },

      noteOn(midi: number, velocity: number, tick?: 'beat' | 'sub') {
        if (released) {
          log.w('Bus', 'noteOn-after-release', { role, midi });
          return;
        }
        const m = clampMidi(midi);
        const v127 = clampVelocity127(velocity);

        // G13 — drum-channel routing during warm-up.
        if (role === 'drums' && !ready && !warmupExpired) {
          if (drumFallback) {
            // Velocity threshold for accent: GM convention treats >=100 as accent.
            const accent = v127 >= 100;
            try {
              drumFallback.playClick(accent);
            } catch (err) {
              log.e('Bus', 'drumFallback-threw', { err: String(err) });
            }
            // v1.4 wave-10 T3 — one-shot forensic entry so logcat for future
            // tablet sessions shows whether the WAV fallback path was ever hit.
            // No user-facing change; purely a debugging aid.
            if (!wavFallbackLoggedOnce) {
              wavFallbackLoggedOnce = true;
              log.w('Bus', 'wav-fallback-activated — SF2 not ready at first drum noteOn; routing to WAV click');
            }
            log.d('Bus', 'noteOn-wav', { midi: m, velocity: v127 });
          } else {
            log.w('Bus', 'noteOn-dropped-warmup', { role, midi: m });
          }
          // Still emit the event so UI listeners (beat flash) tick on the
          // same call stack as the click — U21 synchrony is preserved
          // regardless of TSF vs WAV routing.
          emit('noteOn', { channel: role, midi: m, velocity: v127, tick });
          return;
        }

        // Synth path. velocity 0..127 → 0..1.
        const v01 = v127 / 127;
        try {
          synthPort.noteOn(ch, m, v01);
        } catch (err) {
          log.e('Bus', 'noteOn-threw', { role, err: String(err) });
        }
        recordNoteOn(ch, m);
        // No per-note log here — this is the audio hot path (per beat + sub).
        // A debug log every note crosses the JS→native/AsyncStorage bridge and
        // taxes the timing thread; warnings/errors above carry the diagnostics.
        emit('noteOn', { channel: role, midi: m, velocity: v127, tick });
      },

      noteOff(midi: number) {
        if (released) {
          log.w('Bus', 'noteOff-after-release', { role, midi });
          return;
        }
        const m = clampMidi(midi);
        try {
          synthPort.noteOff(ch, m);
        } catch (err) {
          log.e('Bus', 'noteOff-threw', { role, err: String(err) });
        }
        recordNoteOff(ch, m);
        log.d('Bus', 'noteOff', { role, ch, midi: m });
        emit('noteOff', { channel: role, midi: m });
      },

      pitchBend(semitones: number) {
        if (released) {
          log.w('Bus', 'pitchBend-after-release', { role });
          return;
        }
        const s = clampBend(semitones);
        try {
          synthPort.pitchBend(ch, s);
        } catch (err) {
          log.e('Bus', 'pitchBend-threw', { role, err: String(err) });
        }
        log.d('Bus', 'pitchBend', { role, ch, semitones: s });
        emit('pitchBend', { channel: role, semitones: s });
      },

      allNotesOff() {
        if (released) {
          log.w('Bus', 'allNotesOff-after-release', { role });
          return;
        }
        try {
          synthPort.allNotesOff(ch);
        } catch (err) {
          log.e('Bus', 'allNotesOff-threw', { role, err: String(err) });
        }
        soundingByChannel.delete(ch);
        log.d('Bus', 'allNotesOff', { role, ch });
      },

      // v1.4 — scheduled noteOn through the frame-clock peg.
      noteOnAt(midi: number, velocity: number, atMs: number, tick?: 'beat' | 'sub') {
        if (released) {
          log.w('Bus', 'noteOnAt-after-release', { role, midi });
          return;
        }
        if (!synthPort.noteOnAt) {
          // Synth port doesn't support scheduled noteOn; no-op with a note.
          log.w('Bus', 'noteOnAt-unsupported', { role });
          return;
        }
        // v1.4 wave-8 — T1: silence-over-wrong: if the synth port reports
        // not-ready we drop rather than queue. The timing window is gone by
        // the time ready flips; firing late is worse than firing not at all.
        // Wrap isReady() in try/catch — if it throws the port is in an
        // undefined state; drop the schedule entirely (same policy as init).
        if (synthPort.isReady) {
          let portReady = true;
          try {
            portReady = synthPort.isReady();
          } catch (err) {
            log.w('Bus', 'isReady-threw-at-noteOnAt', { role, err: String(err) });
            return; // drop the schedule — synth port is in undefined state
          }
          if (!portReady) {
            log.w('Bus', 'noteOnAt-not-ready', { role, midi });
            return;
          }
        }
        const m = clampMidi(midi);
        const v127 = clampVelocity127(velocity);
        const v01 = v127 / 127;
        const atFrame = atMsToAtFrame(atMs);
        // v1.4 — atMsToAtFrame returns NaN when the frame clock isn't pegged
        // (synth not rendering / getCurrentFrame returns 0). Silence-over-wrong:
        // don't compute against zero, just skip.
        if (!Number.isFinite(atFrame)) {
          log.w('Bus', 'noteOnAt-frame-unavailable', { role, midi: m, atMs });
          return;
        }
        const tickKind = tick === 'beat' ? 1 : tick === 'sub' ? 2 : 0;
        try {
          synthPort.noteOnAt(ch, m, v01, atFrame, tickKind);
        } catch (err) {
          log.e('Bus', 'noteOnAt-threw', { role, err: String(err) });
        }
        // No per-note log — audio hot path (per beat + sub). See noteOn above.
      },

      release() {
        if (released) return;
        released = true;
        // Stop every currently sounding note on this channel first so
        // teardown is precise (no orphaned tails on another consumer's
        // future reserve()).
        try {
          synthPort.allNotesOff(ch);
        } catch (err) {
          log.e('Bus', 'allNotesOff-on-release-threw', { role, err: String(err) });
        }
        soundingByChannel.delete(ch);
        reservations.delete(role);
        log.d('Bus', 'channel-released', { role, ch });
      },
    };
    return handle;
  }

  // ------------- public bus API -------------
  const core: MidiBusCore = {
    get ready() {
      return ready;
    },

    isReady(): boolean {
      return ready;
    },

    reserve(role: ChannelRole): ChannelHandle | null {
      if (reservations.has(role)) {
        // U23 — silent to user; forensic log only.
        log.w('Bus', 'channel-claim-denied', {
          role,
          ch: CHANNEL_OF_ROLE[role],
        });
        return null;
      }
      const handle = makeHandle(role);
      reservations.set(role, handle);
      log.d('Bus', 'channel-reserved', { role, ch: CHANNEL_OF_ROLE[role] });
      return handle;
    },

    setMasterMute(muted: boolean): void {
      if (masterMuted === muted) return;
      masterMuted = muted;
      log.d('Bus', 'master-mute', { muted });
      applyMasterGain();
    },

    setMasterGain(gain: number): void {
      const g = Number.isFinite(gain) && gain >= 0 ? gain : 0;
      masterGainTarget = g;
      log.d('Bus', 'master-gain', { gain: g, muted: masterMuted });
      applyMasterGain();
    },

    on(event: BusEventKind, listener: Listener): () => void {
      const set = listeners[event];
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },

    // v1.4 — Belt 1. Drop all pending scheduled commands. Routes to the
    // synth port's clearScheduled (Kotlin → C++ → drops g_queue). Silent
    // no-op if the port pre-dates v1.4 and doesn't expose the method.
    clearScheduled(): void {
      if (!synthPort.clearScheduled) {
        log.d('Bus', 'clearScheduled-unsupported');
        return;
      }
      try {
        synthPort.clearScheduled();
      } catch (err) {
        log.e('Bus', 'clearScheduled-threw', { err: String(err) });
      }
      log.d('Bus', 'clearScheduled');
    },

    // v1.4 — Belt 2 surface. Returns 0 when the synth isn't rendering.
    getCurrentFrame(): number {
      if (!synthPort.getCurrentFrame) return 0;
      try { return synthPort.getCurrentFrame(); } catch { return 0; }
    },

    // v1.4 — Belt 2 surface. NaN when the bus has no peg (synth not started).
    atMsToAtFrame(atMs: number): number {
      return atMsToAtFrame(atMs);
    },

    // v1.4 wave-3 — force-repeg surface, used by AppState resume paths.
    repegFrameClock(opts?: { force?: boolean }): void {
      repegFrameClock(opts);
    },

    dispose(): void {
      // v1.4 — clear repeg timer before anything else.
      if (repegTimer !== null) {
        clearInterval(repegTimer);
        repegTimer = null;
      }
      // Tear down warm-up timer.
      if (warmupTimer !== null) {
        clearTimeout(warmupTimer);
        warmupTimer = null;
      }
      // Release every reservation (allNotesOff happens inside release()).
      for (const role of Array.from(reservations.keys())) {
        const h = reservations.get(role);
        if (h) {
          try {
            h.release();
          } catch (err) {
            log.e('Bus', 'release-on-dispose-threw', { role, err: String(err) });
          }
        }
      }
      // Mute the synth on the way out so any in-flight tails fade.
      try {
        synthPort.setMasterGain(0);
      } catch (err) {
        log.e('Bus', 'dispose-setMasterGain-threw', { err: String(err) });
      }
      // Drop listeners.
      for (const kind of Object.keys(listeners) as BusEventKind[]) {
        listeners[kind].clear();
      }
      // Remove synth event subscriptions.
      try {
        readySub.remove();
      } catch {
        /* ignore */
      }
      try {
        underrunSub?.remove();
      } catch {
        /* ignore */
      }
      // v1.4 — remove commandFired subscription.
      try {
        firedSub?.remove();
      } catch {
        /* ignore */
      }
      // Dispose fallback (drops AudioPlayer instances etc.).
      if (drumFallback) {
        try {
          drumFallback.dispose();
        } catch (err) {
          log.e('Bus', 'fallback-dispose-threw', { err: String(err) });
        }
      }
      log.d('Bus', 'disposed', { prepareSettled });
    },
  };

  return core;
}
