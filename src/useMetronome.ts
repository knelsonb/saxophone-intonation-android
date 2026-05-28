/**
 * useMetronome — state machine + tick scheduler for the METRO tab.
 *
 * Design goals:
 *   1. **Wall-clock scheduling**, not relative `setInterval` — drift compounds
 *      otherwise. The next beat's target time is computed from `startedAtMs`
 *      plus `(beatIndex * 60000 / bpm)`. setTimeout fires close to the target
 *      and we apply the click then; if the timer was late we still advance to
 *      the correct beat index.
 *   2. **Visual + audio in sync** (v0.9.1 calibration).
 *      The visible beat indicator runs on the UI thread via Animated with
 *      `useNativeDriver: true`, so the click no longer waits on a JS render
 *      to land. To compensate for downstream audio-output latency the click
 *      is fired EARLIER than the visual peak by a per-route base offset
 *      (speaker 25 ms / wired 5 ms / Bluetooth 200 ms) PLUS a user-tunable
 *      `metroClickOffsetMs` step from SETUP. Negative offset = click earlier.
 *   3. **Tap tempo**. Each tap records `Date.now()`. We take the running
 *      average of the last 4 inter-tap intervals. Resets if no tap in 2 s.
 *   4. **Lifecycle**. AppState 'background' stops the click immediately and
 *      remembers the previous run state so it can resume when the user
 *      returns.
 *
 * Audio path (v1.3): the metronome is purely a scheduler. Every beat tick
 * produces a `noteOn(midi, velocity)` on the bus's reserved `'drums'`
 * channel (GM channel 9). The bus decides whether the noteOn lands on TSF
 * or on the WAV-fallback path during synth warm-up (G13 — bus owns the
 * fallback). useMetronome no longer imports expo-audio, no longer holds
 * AudioPlayer refs, no longer generates click WAVs, no longer polls
 * synth.isReady — those concerns moved into the bus in Wave 1A.
 *
 * VERIFICATION: hand-tune `metroClickOffsetMs` by recording the device
 * speaker + screen with another phone's 240fps slow-mo camera. Step through
 * frame-by-frame, count frames between the visual flash peak and the
 * loudest sample of the click waveform. ≤2 frames at 240fps = ≤8 ms = pass.
 * On a Pixel 9 Pro, speaker default of −25 ms typically lands inside that
 * window; user can nudge ±5 ms from SETUP if the room or output route
 * changes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { loadMetroProfiles, loadPrefs, prefsUpdate, savePrefs } from './storage/prefs';
import type { MetroProfile } from './storage/prefs';
import { routeLatencyMs } from './useMidiBusCore';
import type { ChannelHandle, ChannelRole, MetroOutputRoute, MidiBusState } from './useMidiBusCore';
// #167 — route types + the cold-start latency guess now live in the bus core
// (single source of truth shared with the bus's getCompensationLatencyMs
// fallback). Re-exported here so existing `from './useMetronome'` imports of
// MetroOutputRoute / routeLatencyMs keep working.
export { routeLatencyMs };
export type { MetroOutputRoute };
import type { EditableProfile } from './components/ProfileEditorAccordion';
import { log } from './log';

// v1.2 — TimeSig is a tagged union. The denominator is for notation only;
// beats-per-bar = numerator regardless of denominator (the existing 6/8
// preset already counts six eighth-notes per bar at the displayed BPM —
// custom inherits that). Future engineers WILL try to make 6/8 sound like
// 6/8 — do not let them.
export type TimeSigPreset = '2/4' | '3/4' | '4/4' | '6/8';
export type TimeSig =
  | { kind: 'preset'; value: TimeSigPreset }
  | { kind: 'custom'; num: number; den: 2 | 4 | 8 | 16 | 32 };

const TIME_SIG_PRESET_BEATS: Record<TimeSigPreset, number> = {
  '2/4': 2,
  '3/4': 3,
  '4/4': 4,
  '6/8': 6,
};

/** Beats-per-bar — numerator for custom, hard-coded count for presets. */
export function beatsPerBar(ts: TimeSig): number {
  if (ts.kind === 'preset') return TIME_SIG_PRESET_BEATS[ts.value];
  return ts.num;
}

/**
 * v1.2 — per-beat instrument. Velocity carried in the type for forward-compat
 * with v1.3's per-cell-velocity UI (§15.Q11.4); v1.2 surfaces no velocity UI.
 *
 * v1.3 (G14) — `channel` is RESERVED for v1.4 multi-channel patterns
 * (e.g. fire a kick on 'drums' AND a cowbell on 'aux1' from the same cell).
 * v1.3 ALWAYS omits this field; the dispatcher unconditionally routes to
 * the 'drums' channel handle reserved on hook mount. The field is typed
 * here purely for forward-compatibility so future profile JSON written
 * by v1.4 doesn't have to widen the schema.
 */
export interface BeatInstrument {
  /** GM percussion note 35..81 (channel 9). */
  midi: number;
  /** MIDI velocity 1..127. */
  velocity: number;
  /**
   * v1.4-reserved per-cell channel override. v1.3 ignores this field; do
   * not populate it from any v1.3 code path. See council G14.
   */
  channel?: ChannelRole;
}

// v1.2 — subdivision mode. Mutually exclusive (§15.Q11.2).
export type Subdivision = 'off' | '8th' | '16th' | 'triplet';

const SUBS_PER_BEAT: Record<Subdivision, number> = {
  'off':     1,
  '8th':     2,
  '16th':    4,
  'triplet': 3,
};

// v1.2 — hard-coded GM drum defaults. Wave 2 may import these from
// src/drumVoices.ts (created by Ent); hard-coding here avoids a build-time
// dependency on a not-yet-landed sibling.
const DEFAULT_BEAT_1_MIDI = 36;      // Bass Drum 1
const DEFAULT_BEAT_1_VELOCITY = 110; // accented downbeat
const DEFAULT_BEAT_N_MIDI = 76;      // High Wood Block (§15.Q11.1)
const DEFAULT_BEAT_N_VELOCITY = 90;
const DEFAULT_SUB_MIDI = 42;         // Closed Hi-Hat
const DEFAULT_SUB_VELOCITY = 70;     // §15.Q11.9

// Distinct GM percussion voice per beat so every position in the bar is
// audibly identifiable — kick on 1, then snare / tom / cowbell. Cycles for
// bars longer than 4. Pairs with the per-beat pendulum-bob colour and the
// numeral so the player can hear, see, AND feel where they are in the measure.
const DEFAULT_BEAT_VOICES: BeatInstrument[] = [
  { midi: 36, velocity: 110 }, // 1 — Bass Drum 1 (kick), accented downbeat
  { midi: 38, velocity: 95 },  // 2 — Acoustic Snare
  { midi: 50, velocity: 95 },  // 3 — High Tom
  { midi: 56, velocity: 95 },  // 4 — Cowbell
];

// Default voice for beat index i (0-based). The kick (the accent) lands ONLY
// on the downbeat; every other beat cycles through the NON-downbeat voices
// (snare/tom/cowbell). This keeps a single, unambiguous "1" — naively cycling
// `i % 4` would replay the kick on beat 5 of a 6/8 bar, planting a phantom
// second downbeat.
function defaultVoiceForBeat(i: number): BeatInstrument {
  if (i <= 0) return { ...DEFAULT_BEAT_VOICES[0] };
  const nonDownbeat = DEFAULT_BEAT_VOICES.length - 1; // snare, tom, cowbell
  return { ...DEFAULT_BEAT_VOICES[1 + ((i - 1) % nonDownbeat)] };
}

const DRUM_MIDI_LO = 35;
const DRUM_MIDI_HI = 81;

export const BPM_MIN = 30;
export const BPM_MAX = 300;
export const BPM_DEFAULT = 100;

export const MIN_NUMERATOR = 1;
export const MAX_NUMERATOR = 32; // §15.Q11.5
const ALLOWED_DENOMINATORS: readonly (2 | 4 | 8 | 16 | 32)[] = [2, 4, 8, 16, 32];

const TAP_RESET_MS = 2000;
const TAP_WINDOW = 4;

// #64 Phase-1 — arm the sub-ms-sync shadow probe while the metronome runs so
// PoisonMedic can drive the on-device gate sweep. Measurement only: the probe
// drives no view and does not touch the #167 pendulum PLL. Default-on for the
// Phase-1 measurement build; flip false to ship Phase 1 without the probe.
// Phase 2 removes the shadow path entirely. The native probe is itself
// default-off, so this is the single JS-side switch that arms it.
const SHADOW_PROBE_ENABLED = true;

export interface MetronomeState {
  bpm: number;
  setBpm: (n: number) => void;
  bumpBpm: (delta: number) => void;
  // v1.2 — tagged-union time signature. setTimeSig accepts the full value;
  // setCustomNum / setCustomDen are shortcuts that switch kind to 'custom'
  // and mutate one field at a time.
  timeSig: TimeSig;
  setTimeSig: (s: TimeSig) => void;
  setCustomNum: (n: number) => void;
  setCustomDen: (d: 2 | 4 | 8 | 16 | 32) => void;
  // v1.2 — per-beat pattern. Length always === beatsPerBar(timeSig).
  // Resized in-place on time-sig change (preserves overlap, fills new
  // tail cells with the default click voice).
  pattern: BeatInstrument[];
  setBeatInstrument: (beatIdx: number, midi: number) => void;
  // v1.2 — subdivisions + single global sub-tick voice.
  subdivisions: Subdivision;
  setSubdivisions: (s: Subdivision) => void;
  subdivisionVoice: BeatInstrument;
  setSubdivisionVoice: (midi: number) => void;
  running: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  /** Tap-tempo. Returns the new BPM if it changed, or null on first tap. */
  registerTap: () => number | null;
  /**
   * 1-based index of the current beat within the current bar. Reset to 1 on
   * each `start()`. While running, ticks up on every beat tied to the
   * indicator pulse.
   */
  beat: number;
  /**
   * Pulse counter — increments once per beat. Lets the UI re-render on every
   * beat (different state value each time) so a flash animation can drive
   * off it without relying on object-equality checks.
   */
  pulse: number;
  // v1.1 — click volume 0..1; 0 = mute, 1 = full. Multiplied into bus noteOn
  // velocity at audio dispatch (§15.Q11.10): 0 suppresses the noteOn entirely.
  clickVolume: number;
  setClickVolume: (v: number) => void;
  /**
   * v1.4 — L3: atomically load all fields from an EditableProfile into live
   * state in one synchronous batch, then fire a SINGLE prefsUpdate() call so
   * the debouncer coalesces the write. BPM is restored when present on the
   * profile (FRESH-START). Calls clearScheduleTimers() + schedule() so the
   * metronome immediately reflects the new pattern/tempo.
   */
  loadProfile: (p: EditableProfile) => void;
}

function clampBpm(n: number): number {
  if (!Number.isFinite(n)) return BPM_DEFAULT;
  return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(n)));
}

function clampNumerator(n: number): number {
  if (!Number.isFinite(n)) return 4;
  return Math.max(MIN_NUMERATOR, Math.min(MAX_NUMERATOR, Math.trunc(n)));
}

function clampDrumMidi(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_BEAT_N_MIDI;
  const t = Math.trunc(n);
  return Math.max(DRUM_MIDI_LO, Math.min(DRUM_MIDI_HI, t));
}

// v1.2 — default pattern for N beats: kick on 1, click on 2..N.
function buildDefaultPattern(beats: number): BeatInstrument[] {
  const out: BeatInstrument[] = new Array(beats);
  for (let i = 0; i < beats; i++) {
    out[i] = defaultVoiceForBeat(i);
  }
  return out;
}

// v1.2 — resize an existing pattern to a new beat count without losing user
// assignments. If shrinking, drop the tail. If growing, fill new cells with
// the default click voice (matches the default-pattern's non-downbeat slot).
function resizePattern(old: BeatInstrument[], newBeats: number): BeatInstrument[] {
  if (newBeats <= 0) return [];
  if (old.length === newBeats) return old;
  if (old.length > newBeats) return old.slice(0, newBeats);
  const out = old.slice();
  while (out.length < newBeats) {
    out.push(defaultVoiceForBeat(out.length));
  }
  return out;
}

// v1.2 — validate a parsed pattern against current beats-per-bar. Returns
// the input if it's well-formed and length-matched, else null (caller falls
// back to the default).
function validatePatternForBeats(p: unknown, beats: number): BeatInstrument[] | null {
  if (!Array.isArray(p) || p.length !== beats) return null;
  const out: BeatInstrument[] = [];
  for (const e of p) {
    if (typeof e !== 'object' || e === null) return null;
    const rec = e as { midi?: unknown; velocity?: unknown };
    const midi = Number(rec.midi);
    const velocity = Number(rec.velocity);
    if (!Number.isFinite(midi) || midi < DRUM_MIDI_LO || midi > DRUM_MIDI_HI) return null;
    if (!Number.isFinite(velocity) || velocity < 1 || velocity > 127) return null;
    out.push({ midi: Math.trunc(midi), velocity: Math.trunc(velocity) });
  }
  return out;
}

export interface UseMetronomeArgs {
  /**
   * MIDI bus. The hook reserves the 'drums' channel on mount and routes
   * every beat noteOn through the returned handle. If reservation is
   * denied (another consumer holds 'drums'), the scheduler still runs
   * visually but emits no audio — same defensive null-handle pattern as
   * the parallel drone migration. U23: no user-visible error.
   */
  bus: MidiBusState;
  /** User-tunable click offset in ms. Stacks on route latency. */
  clickOffsetMs: number;
  /** Selected output route — drives the base latency offset. */
  outputRoute: MetroOutputRoute;
}

export function useMetronome(args: UseMetronomeArgs): MetronomeState {
  const { bus, clickOffsetMs, outputRoute } = args;
  const [bpm, setBpmState] = useState<number>(BPM_DEFAULT);
  // v1.2 — default to 4/4 preset; loadPrefs migration may overwrite from a
  // legacy `timeSig` string on mount.
  const [timeSig, setTimeSigState] = useState<TimeSig>({ kind: 'preset', value: '4/4' });
  const [pattern, setPatternState] = useState<BeatInstrument[]>(() => buildDefaultPattern(4));
  const [subdivisions, setSubdivisionsState] = useState<Subdivision>('off');
  const [subdivisionVoice, setSubdivisionVoiceState] = useState<BeatInstrument>({
    midi: DEFAULT_SUB_MIDI,
    velocity: DEFAULT_SUB_VELOCITY,
  });
  const [running, setRunning] = useState<boolean>(false);
  const [beat, setBeat] = useState<number>(1);
  const [pulse, setPulse] = useState<number>(0);
  // v1.1 — click volume. Loaded from prefs on mount.
  const [clickVolume, setClickVolumeState] = useState<number>(0.8);
  const clickVolumeRef = useRef<number>(0.8);

  // Refs that the scheduler reads without rebinding the callback.
  const bpmRef = useRef(BPM_DEFAULT);
  bpmRef.current = bpm;
  const sigRef = useRef<TimeSig>(timeSig);
  sigRef.current = timeSig;
  const patternRef = useRef<BeatInstrument[]>(pattern);
  patternRef.current = pattern;
  const subdivisionsRef = useRef<Subdivision>(subdivisions);
  subdivisionsRef.current = subdivisions;
  const subdivisionVoiceRef = useRef<BeatInstrument>(subdivisionVoice);
  subdivisionVoiceRef.current = subdivisionVoice;
  const runningRef = useRef(false);
  runningRef.current = running;
  // Calibration refs — refreshed every render so live changes from SETUP
  // take effect on the next beat without a restart.
  const clickOffsetRef = useRef(clickOffsetMs);
  clickOffsetRef.current = clickOffsetMs;
  const outputRouteRef = useRef<MetroOutputRoute>(outputRoute);
  outputRouteRef.current = outputRoute;
  clickVolumeRef.current = clickVolume;

  // v1.3 — bus channel handle for 'drums'. Reserved on mount, released on
  // unmount. Stored in a ref so the scheduler reads the live handle without
  // rebinding the callback. `null` means reservation was denied (another
  // consumer holds the role); the scheduler then runs silently.
  const channelRef = useRef<ChannelHandle | null>(null);

  // v1.4 — busRef tracks the live bus interface (which the v1.3.4 B1 split
  // intentionally rebinds on the ready → true edge). Captured into a ref so
  // start/stop/schedule callbacks don't depend on `bus` identity — keeps
  // the deps array of stop() empty + matches the channel-reservation effect
  // dep-elision pattern (which uses `[]` deliberately).
  const busRef = useRef<MidiBusState>(bus);
  busRef.current = bus;

  // Index of the next beat we will fire (0-based within an "ever-running"
  // counter; modulo time-sig beats gives the bar position). Reset to 0 on
  // each start().
  const nextBeatIndexRef = useRef(0);
  const startedAtMsRef = useRef(0);
  // Visual heartbeat timer fires at each beat's wall-clock target (targetMs).
  // It advances the beat counter, updates the beat-number state, and recurses
  // to schedule the next beat. Audio is NOT on a JS timer — every click is
  // enqueued immediately via the real-time engine (ch.noteOnAt) to fire at a
  // precise render frame, so there are no separate click / sub-tick JS timers
  // to track or clear. allNotesOff() in stop() (plus clearScheduled() on the
  // bus) is the safety belt for any sounding/queued notes.
  const visualTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------- bus channel reservation ----------

  useEffect(() => {
    const handle = bus.reserve('drums');
    if (handle === null) {
      // U23: silent to the user. Bus already emitted a forensic log entry.
      // The scheduler still ticks (visual beat counter / pulse animate)
      // but every dispatch is a no-op — same as the drone migration's
      // defensive null-handle pattern.
      log.w('Metronome', 'drums-channel-reservation-denied');
      channelRef.current = null;
      return;
    }
    channelRef.current = handle;
    return () => {
      // Release the channel on unmount. Bus's own dispose() also walks the
      // reservation map, so this is defence-in-depth.
      try {
        handle.release();
      } catch {
        /* ignore */
      }
      channelRef.current = null;
    };
    // v1.3.1 HOTFIX — deps `[]` not `[bus]`. The bus's MidiBusState identity
    // rebinds when its internal `ready` flag flips (see useMidiBus.ts:90's
    // useMemo([core, ready])). With `[bus]` deps, every ready-edge would
    // release + re-reserve drums; any noteOn that landed inside the gap
    // bailed silently because channelRef.current was momentarily null —
    // which is exactly the "metronome played one beat then stopped" symptom
    // the user reported. The underlying `core` is stable, so reserving via
    // the initially-captured bus reference stays valid for the hook's
    // lifetime. Matches useDrone:181 pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- audio dispatch ----------

  // Schedule a single drum note on the bus's reserved 'drums' channel (GM 9)
  // to fire at a precise render frame via the real-time engine (noteOnAt).
  //
  // This is the SOLE source of both the audible click — TSF percussion on the
  // now-unmuted channel 9 — and the visual beat event: the native render thread
  // emits a commandFired callback when the note applies, which the bus re-emits
  // as a SINGLE 'noteOn' that every visual subscriber (pendulum, pulse, flash,
  // per-beat highlight) counts exactly once. No immediate ch.noteOn is issued,
  // so there is no second, JS-timer-jittered event to double-count.
  //
  // Honours the clickVolume × velocity mute guard (§15.Q11.10): clickVolume===0
  // or velocity===0 fully suppresses the note. Result velocity clamped [1,127].
  const scheduleNoteAt = useCallback(
    (midi: number, velocity: number, atMs: number, tick: 'beat' | 'sub') => {
      const cv = clickVolumeRef.current;
      if (cv <= 0 || velocity <= 0) return;
      const ch = channelRef.current;
      if (ch === null) return; // reservation denied — silent scheduler.
      const vEff = Math.max(1, Math.min(127, Math.round(velocity * cv)));
      try {
        ch.noteOnAt(midi, vEff, atMs, tick);
      } catch {
        /* ignore — bus already logged any underlying synth failure */
      }
    },
    [],
  );

  // ---------- scheduling ----------

  const schedule = useCallback(() => {
    if (!runningRef.current) return;
    const bpmNow = bpmRef.current;
    const sig = sigRef.current;
    const beats = beatsPerBar(sig);
    // v1.4 wave-8 — T3 Belt 2: if beats is 0 (malformed timeSig slipped
    // through), i%beats would be NaN. Drop silently rather than corrupt state.
    if (beats <= 0 || !Number.isFinite(beats)) {
      log.w('Metro', 'schedule-invalid-beats', { beats, sig });
      return;
    }
    const intervalMs = 60000 / bpmNow;
    const i = nextBeatIndexRef.current;
    const targetMs = startedAtMsRef.current + i * intervalMs;
    const now = Date.now();

    // Click lead time. routeLatency is positive — the click must precede the
    // visual by that many ms so audio output lands on time. The user-tunable
    // clickOffsetMs is SIGNED-ADDED to the click target: negative = even
    // earlier. So clickFireAt = targetMs - routeLatency + clickOffsetMs.
    //
    // Edge case: at very fast BPM with Bluetooth + large negative offset, the
    // click for beat N could need to fire BEFORE beat N-1's visual. The
    // skip-if-too-late guard below drops the click silently rather than
    // playing it overlapped. Band-directors at 300 BPM should pick wired or
    // speaker output anyway.
    // v1.4.x #167 — single EFFECTIVE output latency from the bus: the held
    // measurement once warm, else the bus's per-route cold-start guess. The bus
    // now owns that fallback, so audio (here) and the pendulum phase-lead
    // compensate by the SAME amount in every state. ONE read, reused for the
    // downbeat AND its sub-ticks below — never recompute a fallback at the
    // sub-tick or the two would diverge. The `??` covers only legacy bus mocks
    // that omit the method.
    const effective = busRef.current.getCompensationLatencyMs?.() ?? routeLatencyMs(outputRouteRef.current);
    const clickFireAt = targetMs - effective + clickOffsetRef.current;

    const visualDelay = Math.max(0, targetMs - now);

    const beatInBar = (i % beats) + 1;
    const isAccent = beatInBar === 1;

    // Resolve the downbeat voice from pattern. patternRef may be a different
    // length than `beats` for one render between setTimeSig's resize and the
    // schedule rebind — fall back to the default voice in that gap.
    const pat = patternRef.current;
    const beatVoice: BeatInstrument =
      pat[beatInBar - 1] ?? {
        midi: isAccent ? DEFAULT_BEAT_1_MIDI : DEFAULT_BEAT_N_MIDI,
        velocity: isAccent ? DEFAULT_BEAT_1_VELOCITY : DEFAULT_BEAT_N_VELOCITY,
      };

    // Beat fire — enqueue the click NOW so the real-time engine fires it at the
    // exact render frame for clickFireAt. No JS timer: the engine owns the
    // timing, and the single commandFired callback it emits on apply is the one
    // event every visual subscriber counts (one monotonic tick per beat — no
    // double-count, no JS-timer jitter). Skip if clickFireAt sits in the past by
    // more than half a beat (we're already inside the next beat's window —
    // silence-over-wrong).
    if (now - clickFireAt < intervalMs * 0.5) {
      scheduleNoteAt(beatVoice.midi, beatVoice.velocity, clickFireAt, 'beat');
      // #64 Phase-1 — anchor the shadow probe to THIS downbeat. Reuse the click's
      // atFrame (same atMs → atMsToAtFrame yields the exact frame the click fires
      // at) so the shadow projects the HEARD time of the real click. Downbeats
      // ONLY — mirrors the #167 peg filter (sub-ticks never anchor). No-op unless
      // the bus supports it (probe armed only when SHADOW_PROBE_ENABLED).
      if (SHADOW_PROBE_ENABLED && busRef.current.setBeatAnchor) {
        const beatAtFrame = busRef.current.atMsToAtFrame(clickFireAt);
        if (Number.isFinite(beatAtFrame)) {
          busRef.current.setBeatAnchor(beatAtFrame, 60e9 / bpmNow);
        }
      }
    }

    // v1.2 — schedule sub-ticks for this beat, if any. Sub-ticks use the
    // global subdivisionVoice and DO NOT advance the beat counter (visual
    // semantics stay 1..N downbeats only). Sub-ticks share the same `effective`
    // + clickOffset lead so they land at the right wall-clock moment too, and
    // ride the same real-time engine schedule as the downbeat (tick='sub' so
    // visual subscribers skip them when stepping their bar position).
    const sub = subdivisionsRef.current;
    if (sub !== 'off') {
      const subsPerBeat = SUBS_PER_BEAT[sub];
      const subVoice = subdivisionVoiceRef.current;
      for (let k = 1; k < subsPerBeat; k++) {
        const subTargetMs = targetMs + (intervalMs * k) / subsPerBeat;
        const subFireAt = subTargetMs - effective + clickOffsetRef.current;
        // Same too-late skip as the downbeat path.
        if (now - subFireAt >= intervalMs * 0.5) continue;
        scheduleNoteAt(subVoice.midi, subVoice.velocity, subFireAt, 'sub');
      }
    }

    // Visual peak — fires at targetMs. Bumps `beat` + `pulse` together so
    // the UI's Animated value (driven by `pulse`) flashes in lockstep with
    // the beat number change. Both setStates land in the same React batch.
    visualTimeoutRef.current = setTimeout(() => {
      if (!runningRef.current) return;
      setBeat(beatInBar);
      setPulse((p) => p + 1);
      nextBeatIndexRef.current = i + 1;
      // Schedule the next beat. Recursion via setTimeout keeps wall-clock
      // alignment — drift accumulates only from setTimeout's own latency,
      // not from compounding interval errors.
      schedule();
    }, visualDelay);
  }, [scheduleNoteAt]);

  // Helper used by start/stop/setBpm/setTimeSig to clear the visual heartbeat
  // timer. Audio is no longer on JS timers — pending clicks live in the native
  // engine queue and are dropped via busRef.current.clearScheduled() on the
  // stop / reschedule paths (called alongside this helper).
  const clearScheduleTimers = useCallback(() => {
    if (visualTimeoutRef.current !== null) {
      clearTimeout(visualTimeoutRef.current);
      visualTimeoutRef.current = null;
    }
  }, []);

  // v1.3.4 B7 — `preservePhase` arg for AppState foreground resume.
  //
  // start() is called from two sites:
  //   1. User presses PLAY (toggle → start()). Fresh start is correct — reset
  //      phase to beat 1. preservePhase defaults to false.
  //   2. AppState 'active' handler — app was running when it went to background,
  //      now returning. We want the click cadence to continue from where it was,
  //      not jump back to beat 1. Pass preservePhase=true.
  //
  // Phase-preserve math (mirrors setBpm):
  //   The current beat at background time was (nextBeatIndexRef, startedAtMsRef).
  //   We don't know how long the foreground was gone. We re-anchor startedAtMsRef
  //   so that the NEXT beat fires at "now + (1-phase)*T" where phase is whatever
  //   fraction of the beat had elapsed at the moment of resumption. Because we
  //   don't capture elapsed-at-background, we treat phase as 0 (resume at the
  //   START of the next beat from now). This avoids an immediate double-click
  //   (phase=1 path) and keeps the visual aligned with the audio.
  const start = useCallback((preservePhase = false) => {
    if (runningRef.current) return;
    runningRef.current = true;
    if (preservePhase) {
      // v1.3.4 B7 — re-anchor the timeline so the next beat fires promptly
      // from the foreground resume moment. nextBeatIndexRef is preserved so
      // the bar position (beat 1/2/3…) continues without reset.
      const bpmNow = bpmRef.current;
      const T = 60000 / Math.max(1, bpmNow);
      // Schedule the next beat to fire one beat interval from now.
      startedAtMsRef.current = Date.now() - nextBeatIndexRef.current * T + T;
      // v1.4 wave-3 B4 — AppState resume invariant. The renderer paused
      // while we were in background, freezing the synth's frame counter
      // while wall-clock advanced N seconds. The bus's frame-clock peg is
      // now stale by exactly that gap, and the auto-repeg drift gate would
      // REJECT a fresh peg because the implied shift exceeds the 2 ms
      // threshold. Result without this block: atMsToAtFrame produces
      // atFrames many seconds into the future and ~30 s of beats silently
      // miss the past-atFrame guard until the renderer catches up.
      //
      // Fix: (a) drop any stale future-scheduled commands from the native
      // queue, then (b) force-repeg the bus to anchor against the freshly
      // resumed renderer. Now atMsToAtFrame computes against the current
      // frame, scheduled atFrames land in the near future, and the next
      // beat fires on time.
      const busNow = busRef.current;
      try {
        busNow.clearScheduled();
      } catch {
        /* ignore — bus already logged any underlying synth failure */
      }
      try {
        busNow.repegFrameClock({ force: true });
      } catch {
        /* ignore */
      }
    } else {
      startedAtMsRef.current = Date.now();
      nextBeatIndexRef.current = 0;
      // Fresh start — force a clean frame-clock peg before scheduling. If the
      // app sat idle (backgrounded / dozed) the render thread's frame counter
      // froze while wall-clock advanced; the bus auto-repeg then HOLDS the
      // stale origin (its drift gate correctly refuses to peg onto a suspect
      // clock). Without this, the first beats compute against a stale origin,
      // land out-of-window, and every noteOnAt is dropped — a dead metronome
      // (correct per silence-over-wrong, but the engine SHOULD be able to
      // deliver here). Drop any stale queued commands, then force-repeg to the
      // live render frame so play always anchors to a valid clock.
      const busNow = busRef.current;
      try {
        busNow.clearScheduled();
      } catch {
        /* ignore — bus already logged any underlying synth failure */
      }
      try {
        busNow.repegFrameClock({ force: true });
      } catch {
        /* ignore */
      }
    }
    setRunning(true);
    if (!preservePhase) setBeat(1);
    // #64 Phase-1 — arm the shadow probe for this run (idempotent natively;
    // re-anchors on its first beat). Paired with stopShadowProbe in stop().
    if (SHADOW_PROBE_ENABLED) {
      try { busRef.current.startShadowProbe?.(); } catch { /* ignore */ }
    }
    // #68 — pin 120Hz while the metronome runs (LTPO panels idle down to ~40Hz,
    // which makes the visualizer stutter). Released in stop(), which the AppState
    // background handler also routes through. Independent of the shadow probe.
    try { busRef.current.setHighRefreshRate?.(true); } catch { /* ignore */ }
    schedule();
  }, [schedule]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    // #64 Phase-1 — paired teardown: disarm the shadow probe (removes the
    // Choreographer callback) so it never outlives a running metronome. The
    // AppState background handler routes through stop(), so this also covers
    // app background→resume (no stacked self-reposting chain).
    if (SHADOW_PROBE_ENABLED) {
      try { busRef.current.stopShadowProbe?.(); } catch { /* ignore */ }
    }
    // #68 — release the 120Hz pin so the LTPO panel can idle down (battery).
    try { busRef.current.setHighRefreshRate?.(false); } catch { /* ignore */ }
    clearScheduleTimers();
    // v1.4 Belt 1 — cancel ALL future-scheduled commands in the native queue
    // BEFORE issuing allNotesOff(). Without this, the ~150 ms of bus.noteOnAt
    // commands we enqueued earlier still fire on the next render quantum —
    // ghost clicks AFTER the user pressed stop. Order matters: drop the
    // future commands first, then silence any currently-sounding voices.
    // Read busRef.current to avoid taking a dep on `bus` — its identity
    // flips on the ready-edge (B1 split) and we don't want stop() to rebind.
    try {
      busRef.current.clearScheduled();
    } catch {
      /* ignore — bus already logged any underlying synth failure */
    }
    // v1.3 — kill any drum tails on the bus's drum channel so a fast stop()
    // doesn't leave a kick ringing for 80ms. Goes through the handle so the
    // bus's per-channel sounding-note bookkeeping stays accurate.
    const ch = channelRef.current;
    if (ch !== null) {
      try {
        ch.allNotesOff();
      } catch {
        /* ignore */
      }
    }
  }, [clearScheduleTimers]);

  const toggle = useCallback(() => {
    if (runningRef.current) stop(); else start();
  }, [start, stop]);

  // v1.0 — smooth BPM re-anchor preserves beat phase.
  // Formula: phase = 1 - remainingOld/T0  (fraction of current beat elapsed)
  //          nextBeatAtMs = now + (1 - phase) * T1
  //          startedAtMs_new = nextBeatAtMs - i * T1
  // so schedule()'s target (startedAtMs + i*T1) lands on nextBeatAtMs.
  // Keeps tap-tempo (which goes through this setter) from stuttering.
  const setBpm = useCallback((n: number) => {
    const next = clampBpm(n);
    const oldBpm = bpmRef.current;
    setBpmState(next);
    if (runningRef.current && next !== oldBpm) {
      const now = Date.now();
      const T0 = 60000 / oldBpm;
      const T1 = 60000 / next;
      const i = nextBeatIndexRef.current;
      const oldTargetMs = startedAtMsRef.current + i * T0;
      const remainingOld = oldTargetMs - now;
      // Clamp phase to [0,1]. If timer already overdue (remainingOld < 0),
      // treat as end-of-beat — fire ASAP under the new tempo.
      let phase = 1 - remainingOld / T0;
      if (!Number.isFinite(phase)) phase = 0;
      phase = Math.max(0, Math.min(1, phase));
      const nextBeatAtMs = now + (1 - phase) * T1;
      startedAtMsRef.current = nextBeatAtMs - i * T1;
      // v1.4 wave-4 — drop stale scheduled noteOnAt before reschedule (prevents ghost clicks)
      try { busRef.current.clearScheduled(); } catch { /* ignore */ }
      clearScheduleTimers();
      schedule();
    }
  }, [schedule, clearScheduleTimers]);

  const bumpBpm = useCallback((delta: number) => {
    setBpm(bpmRef.current + delta);
  }, [setBpm]);

  // v1.0 — preserve in-beat phase across time-sig change; bar index resets
  // because the bar definition itself changed (next fired beat becomes the
  // new downbeat "1"). Keeps click cadence smooth — only the accent pattern
  // shifts.
  //
  // v1.2 — extended to the tagged-union TimeSig. Pattern is resized in
  // place (preserve user assignments where indices overlap; default-fill
  // any new tail cells). Persists the new timeSig fields back to prefs.
  const setTimeSig = useCallback((s: TimeSig) => {
    setTimeSigState(s);
    // v1.4 wave-11 T3 — sync sigRef BEFORE schedule() reads it.
    sigRef.current = s;
    // Resize pattern to match the new beat count.
    const newBeats = beatsPerBar(s);
    setPatternState((prev) => {
      const next = resizePattern(prev, newBeats);
      // v1.4 wave-11 T3 — sync patternRef BEFORE schedule() reads it.
      patternRef.current = next;
      return next;
    });
    if (runningRef.current) {
      const now = Date.now();
      const bpmNow = bpmRef.current;
      const T = 60000 / bpmNow;
      const i = nextBeatIndexRef.current;
      const oldTargetMs = startedAtMsRef.current + i * T;
      const remainingOld = oldTargetMs - now;
      let phase = 1 - remainingOld / T;
      if (!Number.isFinite(phase)) phase = 0;
      phase = Math.max(0, Math.min(1, phase));
      const nextBeatAtMs = now + (1 - phase) * T;
      // Reset bar position: next fired beat = index 0 (downbeat "1").
      nextBeatIndexRef.current = 0;
      startedAtMsRef.current = nextBeatAtMs;
      // v1.4 wave-4 — drop stale scheduled noteOnAt before reschedule (prevents ghost clicks)
      try { busRef.current.clearScheduled(); } catch { /* ignore */ }
      clearScheduleTimers();
      schedule();
    }
    setBeat(1);
    // v1.2 — persist the new time-sig surface.
    (async () => {
      try {
        const current = await loadPrefs();
        if (s.kind === 'preset') {
          await savePrefs({
            ...current,
            metroTimeSigKind: 'preset',
            metroTimeSigPreset: s.value,
          });
        } else {
          await savePrefs({
            ...current,
            metroTimeSigKind: 'custom',
            metroCustomNumerator: clampNumerator(s.num),
            metroCustomDenominator: s.den,
          });
        }
      } catch { /* best-effort */ }
    })();
  }, [schedule, clearScheduleTimers]);

  // v1.2 — set numerator only. Switches kind to 'custom' (the only kind
  // where the numerator is exposed). If we're currently on a preset we
  // adopt the preset's existing num as the new baseline before clamping.
  const setCustomNum = useCallback((n: number) => {
    const num = clampNumerator(n);
    const prev = sigRef.current;
    const den: 2 | 4 | 8 | 16 | 32 = prev.kind === 'custom' ? prev.den : 4;
    setTimeSig({ kind: 'custom', num, den });
  }, [setTimeSig]);

  const setCustomDen = useCallback((d: 2 | 4 | 8 | 16 | 32) => {
    if (!ALLOWED_DENOMINATORS.includes(d)) return;
    const prev = sigRef.current;
    const num: number = prev.kind === 'custom' ? prev.num : beatsPerBar(prev);
    setTimeSig({ kind: 'custom', num: clampNumerator(num), den: d });
  }, [setTimeSig]);

  // v1.2 — patch one beat cell's midi. Velocity preserved from the previous
  // cell value so a future v1.3 velocity UI can mutate it independently;
  // unknown midi values silently clamp to the GM percussion range.
  //
  // v1.3.4 B6 — after updating the pattern, reschedule so a mid-beat change
  // (e.g. user changes beat-1 instrument while running) takes effect on the
  // very next click rather than letting the pre-queued closure fire the old
  // voice. Matches the pattern that setBpm and setTimeSig already use.
  const setBeatInstrument = useCallback((beatIdx: number, midi: number) => {
    setPatternState((prev) => {
      if (beatIdx < 0 || beatIdx >= prev.length) return prev;
      const next = prev.slice();
      const cur = next[beatIdx];
      next[beatIdx] = {
        midi: clampDrumMidi(midi),
        velocity: cur ? cur.velocity : (beatIdx === 0 ? DEFAULT_BEAT_1_VELOCITY : DEFAULT_BEAT_N_VELOCITY),
      };
      // v1.4 wave-11 T3 — sync ref BEFORE schedule() reads it; React state
      // update hasn't re-rendered yet so the render-phase assignment
      // (patternRef.current = pattern) still holds the old value.
      patternRef.current = next;
      // Persist.
      (async () => {
        try {
          const current = await loadPrefs();
          await savePrefs({ ...current, metroPatternJson: JSON.stringify(next) });
        } catch { /* best-effort */ }
      })();
      return next;
    });
    // v1.3.4 B6 — reschedule so the pre-queued click timer (which closed over
    // the old voice) is replaced with a fresh one reading the updated pattern.
    if (runningRef.current) {
      // v1.4 wave-4 — drop stale scheduled noteOnAt before reschedule (prevents ghost clicks)
      try { busRef.current.clearScheduled(); } catch { /* ignore */ }
      clearScheduleTimers();
      schedule();
    }
  }, [clearScheduleTimers, schedule]);

  const setSubdivisions = useCallback((s: Subdivision) => {
    setSubdivisionsState(s);
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, metroSubdivisions: s });
      } catch { /* best-effort */ }
    })();
  }, []);

  // v1.3.4 B6 — setSubdivisionVoice also reschedules so the pre-queued
  // sub-tick timers (which captured the old voice in their closures) are
  // replaced. Without this, changing the sub voice mid-beat fires the old
  // sample on the current beat and only picks up the new voice the beat after.
  const setSubdivisionVoice = useCallback((midi: number) => {
    const clamped = clampDrumMidi(midi);
    setSubdivisionVoiceState((prev) => {
      const next = { midi: clamped, velocity: prev.velocity };
      // v1.4 wave-11 T3 — sync ref BEFORE schedule() reads it.
      subdivisionVoiceRef.current = next;
      (async () => {
        try {
          const current = await loadPrefs();
          await savePrefs({
            ...current,
            metroSubdivisionVoiceMidi: next.midi,
            metroSubdivisionVoiceVelocity: next.velocity,
          });
        } catch { /* best-effort */ }
      })();
      return next;
    });
    if (runningRef.current) {
      // v1.4 wave-4 — drop stale scheduled noteOnAt before reschedule (prevents ghost clicks)
      try { busRef.current.clearScheduled(); } catch { /* ignore */ }
      clearScheduleTimers();
      schedule();
    }
  }, [clearScheduleTimers, schedule]);

  // ---------- tap tempo ----------

  const tapHistoryRef = useRef<number[]>([]);

  const registerTap = useCallback((): number | null => {
    const now = Date.now();
    const hist = tapHistoryRef.current;
    if (hist.length > 0 && now - hist[hist.length - 1] > TAP_RESET_MS) {
      // Stale window — start over from this tap.
      tapHistoryRef.current = [now];
      return null;
    }
    hist.push(now);
    while (hist.length > TAP_WINDOW + 1) hist.shift();
    if (hist.length < 2) return null;
    // Average of inter-tap intervals across the kept window.
    let totalMs = 0;
    for (let i = 1; i < hist.length; i++) totalMs += hist[i] - hist[i - 1];
    const avg = totalMs / (hist.length - 1);
    if (avg <= 0) return null;
    const bpmNew = clampBpm(60000 / avg);
    setBpm(bpmNew);
    return bpmNew;
  }, [setBpm]);

  // ---------- click volume ----------

  // v1.3 — clickVolume is a metronome-level concept (per-tab UX, not global).
  // It multiplies into the scheduled note velocity at dispatch time (see
  // scheduleNoteAt). TSF percussion loudness is derived from velEff/127.
  const setClickVolume = useCallback((v: number): void => {
    const clamped = Math.max(0, Math.min(1, Math.round(v * 10) / 10));
    setClickVolumeState(clamped);
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, metroClickVolume: clamped });
      } catch { /* best-effort */ }
    })();
  }, []);

  // Load persisted state on mount. v1.2 hydrates the full new surface;
  // patternJson is parsed with a silent-reset guard (corrupt JSON → defaults).
  //
  // v1.3.2 / U22 (council F7) — profile-first hydration:
  //   1. Try `loadMetroProfiles(prefs.metroProfilesJson)`. If it returns a
  //      validated array AND `prefs.metroActiveProfileSlot` is a valid slot
  //      index, seed live state from that profile's contents (timeSig +
  //      pattern + subdivisions + subdivisionVoice; BPM is NOT applied here
  //      — it lives outside the profile surface).
  //   2. Otherwise fall through to the existing legacy-field path WITHOUT
  //      overwriting the legacy fields. Aragorn-required U22 guard: a missing
  //      / corrupt / unset profiles array MUST NOT wipe v1.2 settings.
  //
  // Both `metroProfilesJson` and `metroActiveProfileSlot` are not yet typed
  // on AppPrefs (they're a v1.3 surface that landed alongside this hook).
  // Reading them through an `unknown`-shaped view keeps this hook forward-
  // compatible: if AsyncStorage doesn't carry them yet, loadMetroProfiles
  // sees `undefined` → returns null → legacy path runs as before.
  useEffect(() => {
    (async () => {
      try {
        const prefs = await loadPrefs();
        setClickVolumeState(prefs.metroClickVolume);

        // ---- U22: profile-first hydration attempt ----
        const prefsAny = prefs as unknown as {
          metroProfilesJson?: unknown;
          metroActiveProfileSlot?: unknown;
        };
        const profiles = loadMetroProfiles(prefsAny.metroProfilesJson);
        const slotRaw = prefsAny.metroActiveProfileSlot;
        const slotNum = typeof slotRaw === 'number' && Number.isInteger(slotRaw) ? slotRaw : null;
        if (
          profiles !== null
          && slotNum !== null
          && slotNum >= 0
          && slotNum < profiles.length
        ) {
          const prof: MetroProfile = profiles[slotNum];
          // Reconstruct a TimeSig from the profile's flat schema. Profiles
          // don't carry a custom denominator (validateProfile in prefs.ts
          // accepts 'custom' with any pattern length but no den field), so
          // we fall back to 4 — matches the v1.2 default-custom denominator
          // and only affects notation display, not beats-per-bar.
          let profSig: TimeSig;
          if (prof.timeSig === 'custom') {
            const num = clampNumerator(prof.pattern.length);
            profSig = { kind: 'custom', num, den: 4 };
          } else {
            profSig = { kind: 'preset', value: prof.timeSig };
          }
          setTimeSigState(profSig);
          const beats = beatsPerBar(profSig);
          // Profile pattern is the canonical v1.3 surface — resize-to-fit if
          // a 'custom' profile's pattern length disagrees with the
          // numerator we derived. validateProfile already clamped midi /
          // velocity to GM range, so the pattern is safe to push directly.
          const profPattern: BeatInstrument[] = prof.pattern.map((c) => ({
            midi: clampDrumMidi(c.midi),
            velocity: Math.max(1, Math.min(127, Math.trunc(c.velocity))),
          }));
          setPatternState(resizePattern(profPattern, beats));
          setSubdivisionsState(prof.subdivisions);
          setSubdivisionVoiceState({
            midi: clampDrumMidi(prof.subMidi),
            velocity: Math.max(1, Math.min(127, Math.trunc(prof.subVel))),
          });
          return; // U22: profile applied; do NOT also run legacy hydration.
        }

        // ---- Legacy v1.2 fallback path — unchanged from the prior impl. ----
        // Compose timeSig from the new prefs fields.
        const sig: TimeSig = prefs.metroTimeSigKind === 'custom'
          ? {
              kind: 'custom',
              num: clampNumerator(prefs.metroCustomNumerator),
              den: prefs.metroCustomDenominator,
            }
          : { kind: 'preset', value: prefs.metroTimeSigPreset };
        setTimeSigState(sig);
        const beats = beatsPerBar(sig);

        // Pattern: parse + validate against current beats. Any failure path
        // silently resets to the default pattern at the correct length.
        let pat: BeatInstrument[] | null = null;
        try {
          const parsed = JSON.parse(prefs.metroPatternJson) as unknown;
          pat = validatePatternForBeats(parsed, beats);
          // If length disagrees with beats but we have a valid shape, resize
          // the parsed pattern rather than discarding it.
          if (!pat && Array.isArray(parsed)) {
            // Re-validate without the length constraint.
            const lenient = validatePatternForBeats(
              (parsed as unknown[]).slice(0, beats),
              Math.min((parsed as unknown[]).length, beats),
            );
            if (lenient) pat = resizePattern(lenient, beats);
          }
        } catch { /* fall through to default */ }
        setPatternState(pat ?? buildDefaultPattern(beats));

        setSubdivisionsState(prefs.metroSubdivisions);
        setSubdivisionVoiceState({
          midi: clampDrumMidi(prefs.metroSubdivisionVoiceMidi),
          velocity: Math.max(1, Math.min(127, Math.trunc(prefs.metroSubdivisionVoiceVelocity))),
        });
      } catch { /* ignore */ }
    })();
  }, []);

  // ---------- lifecycle ----------

  // Pause when the app goes to background, resume on return.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        wasRunningRef.current = runningRef.current;
        if (runningRef.current) stop();
      } else if (nextState === 'active') {
        if (wasRunningRef.current) {
          wasRunningRef.current = false;
          // v1.3.4 B7 — pass preservePhase=true so the metronome resumes
          // from the correct bar position rather than jumping back to beat 1.
          start(true);
        }
      }
    });
    return () => sub.remove();
  }, [start, stop]);

  // Final teardown on unmount. The channel reservation's own cleanup effect
  // handles handle.release(); here we just stop the scheduler so no in-flight
  // setTimeout fires a noteOn after the handle is gone.
  useEffect(() => {
    return () => {
      runningRef.current = false;
      clearScheduleTimers();
      // #64 Phase-1 — final paired teardown of the shadow probe on unmount
      // (defense-in-depth; the native OnDestroy is the last safety net).
      if (SHADOW_PROBE_ENABLED) {
        try { busRef.current.stopShadowProbe?.(); } catch { /* ignore */ }
      }
      const ch = channelRef.current;
      if (ch !== null) {
        try {
          ch.allNotesOff();
        } catch {
          /* ignore */
        }
      }
    };
  // clearScheduleTimers is stable (useCallback []).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v1.4 — L3: atomic profile load. All React state setters are called
  // synchronously in one JS task, then ONE prefsUpdate() fires with the full
  // batch so the debouncer coalesces it with any in-flight write (per L2).
  // BPM is restored (FRESH-START semantics — the old TODO is resolved here).
  // Calls clearScheduleTimers() + schedule() so the click cadence immediately
  // reflects the new pattern without a stop/start cycle.
  const loadProfile = useCallback((p: EditableProfile) => {
    // v1.4 wave-8 — T3: validate timeSig before use. A custom TimeSig with
    // num=0 would propagate beats=0 into schedule(), causing i%0=NaN and
    // downstream NaN beatInBar. Silence-over-wrong: refuse the load.
    const newBeats = beatsPerBar(p.timeSig);
    if (newBeats <= 0 || !Number.isFinite(newBeats)) {
      log.w('Metro', 'loadProfile-invalid-timeSig', { timeSig: p.timeSig });
      return;
    }
    // --- Synchronous state batch ---
    const newPattern = p.pattern.slice(0, newBeats);
    // Fill any tail cells with the default non-downbeat voice if the stored
    // profile is shorter than the target beat count (defensive; shouldn't
    // happen with validated profiles).
    while (newPattern.length < newBeats) {
      newPattern.push({ midi: DEFAULT_BEAT_N_MIDI, velocity: DEFAULT_BEAT_N_VELOCITY });
    }

    setTimeSigState(p.timeSig);
    setPatternState(newPattern);
    setSubdivisionsState(p.subdivisions);
    setSubdivisionVoiceState({ ...p.subdivisionVoice });

    // v1.4 wave-11 T4 — sync all scheduler refs synchronously BEFORE
    // schedule() runs. React state setters are async (batch-flushed); the
    // render-phase ref mirrors (sigRef.current = timeSig, etc.) won't fire
    // until after the next render. Without these assignments, schedule() reads
    // stale refs and fires beats from the old profile on the first tick.
    sigRef.current = p.timeSig;
    patternRef.current = newPattern;
    subdivisionsRef.current = p.subdivisions;
    subdivisionVoiceRef.current = { ...p.subdivisionVoice };

    // BPM: EditableProfile does not currently carry a bpm field (v1.3 schema).
    // When the field is added in a future wave, apply it here. For now we
    // leave BPM unchanged — the field is simply absent and we don't touch it.

    // --- Re-anchor scheduler so the new pattern fires immediately ---
    if (runningRef.current) {
      // Preserve beat phase across the profile swap (same math as setTimeSig).
      const now = Date.now();
      const bpmNow = bpmRef.current;
      const T = 60000 / bpmNow;
      const i = nextBeatIndexRef.current;
      const oldTargetMs = startedAtMsRef.current + i * T;
      const remainingOld = oldTargetMs - now;
      let phase = 1 - remainingOld / T;
      if (!Number.isFinite(phase)) phase = 0;
      phase = Math.max(0, Math.min(1, phase));
      const nextBeatAtMs = now + (1 - phase) * T;
      nextBeatIndexRef.current = 0;
      startedAtMsRef.current = nextBeatAtMs;
      // v1.4 wave-4 — drop stale scheduled noteOnAt before reschedule (prevents ghost clicks)
      try { busRef.current.clearScheduled(); } catch { /* ignore */ }
      clearScheduleTimers();
      schedule();
    }
    setBeat(1);

    // --- Single batched prefsUpdate — coalesces with in-flight writes (L2) ---
    const patch: Record<string, unknown> = {
      metroTimeSigKind: p.timeSig.kind,
      metroSubdivisions: p.subdivisions,
      metroSubdivisionVoiceMidi: p.subdivisionVoice.midi,
      metroSubdivisionVoiceVelocity: p.subdivisionVoice.velocity,
      metroPatternJson: JSON.stringify(newPattern),
    };
    if (p.timeSig.kind === 'preset') {
      patch['metroTimeSigPreset'] = p.timeSig.value;
    } else {
      patch['metroCustomNumerator'] = clampNumerator(p.timeSig.num);
      patch['metroCustomDenominator'] = p.timeSig.den;
    }
    // Cast: all keys belong to AppPrefs; the unknown-shaped cast is necessary
    // because we build the patch incrementally above.
    prefsUpdate(patch as Parameters<typeof prefsUpdate>[0]);
  }, [clearScheduleTimers, schedule]);

  // v1.2 hotfix — memoise the returned object so App.tsx's consumers don't see
  // a fresh `metro` reference on every render. Without this, `pulse` ticks at
  // beat rate but every screen sees a brand-new MetronomeState object and
  // React cascades a full subtree re-render. Setters are all useCallback-
  // wrapped (stable identity) so they only enter the deps array as identity
  // sentinels — they won't trigger re-memos.
  return useMemo<MetronomeState>(() => ({
    bpm,
    setBpm,
    bumpBpm,
    timeSig,
    setTimeSig,
    setCustomNum,
    setCustomDen,
    pattern,
    setBeatInstrument,
    subdivisions,
    setSubdivisions,
    subdivisionVoice,
    setSubdivisionVoice,
    running,
    start,
    stop,
    toggle,
    registerTap,
    beat,
    pulse,
    clickVolume,
    setClickVolume,
    loadProfile,
  }), [
    bpm,
    timeSig,
    pattern,
    subdivisions,
    subdivisionVoice,
    running,
    beat,
    pulse,
    clickVolume,
    setBpm,
    bumpBpm,
    setTimeSig,
    setCustomNum,
    setCustomDen,
    setBeatInstrument,
    setSubdivisions,
    setSubdivisionVoice,
    start,
    stop,
    toggle,
    registerTap,
    setClickVolume,
    loadProfile,
  ]);
}
