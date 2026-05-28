import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { AudioModule, useAudioStream } from 'expo-audio';
import type { AudioStreamBuffer } from 'expo-audio';

import { yinPitch } from './yin';
import {
  FILTER_PRESETS,
  newFilterState,
  processFrame,
  resetFilterState,
} from './filterModes';
import type { FilterMode, FilterState } from './filterModes';
import type { ThemeName } from './theme';
import { transpMap } from './instruments';
import { loadPrefs, savePrefs } from './storage/prefs';
import type { AppPrefs } from './storage/prefs';
import {
  initMeasurementsDb,
  startRun,
  insertMeasurement,
} from './storage/measurements';
import { useRawAudioInput } from '../modules/raw-audio-input';
import type { RawAudioBuffer } from '../modules/raw-audio-input';

// ---------------------------------------------------------------------------
// save-on-background: refHz lives in App.tsx as useState (Frodo's territory).
// The engine exposes savePrefsNow(extra?) so App.tsx can pass { refHz } when
// it handles AppState changes, or call it on demand (e.g. on picker close).
// The engine's own AppState listener fires as a backstop and writes refHz
// from its internal a4HzRef (same value in practice — a4Hz === refHz while
// App.tsx keeps them in sync). This avoids a second AppState listener in
// App.tsx for the common case while still letting Frodo override if needed.
// ---------------------------------------------------------------------------

// Hoisted at module level so the hooks inside useAudioEngine do not recreate
// the underlying stream instances on every render.
const STREAM_OPTIONS = {
  sampleRate: 44100,
  channels: 1,
  encoding: 'float32' as const,
} satisfies { sampleRate: number; channels: number; encoding: 'float32' | 'int16' };

const HIFI_OPTIONS = {
  sampleRate: 48000,
  bufferDurationMs: 25,
  preferredSource: 'unprocessed' as const,
};

const RING_BUFFER_CAPACITY = 4096;
// Full audio-rate pitch detection (40 Hz at 25ms buffers @ 48 kHz). The
// FFT-based YIN in yin.ts is O(N log N) so this is well within budget on
// a Pixel 9 Pro; the naive O(N × tmax) implementation used to saturate the
// JS thread at this cadence (~70× more work per call). Keeping the filter
// hop at the audio-buffer rate preserves the desktop's tuned hysteresis
// behavior in filterModes.ts.
const BUFFERS_PER_YIN_CALL = 1;

const GAIN_DISPLAY_MAP = {
  low:  { floor: -60, ceil:   0 },
  high: { floor: -60, ceil: -20 },
} as const;

const SILENT_BUFFER_THRESHOLD = 8;

// ---------------------------------------------------------------------------
// Drone chase guard (v0.9.1).
//
// Problem: when the drone plays out the speaker, the mic picks it up. YIN can
// lock onto the drone's own pitch and the engine ends up chasing its own
// output. We can't simply vote-exclude the drone's MIDI from the incumbent
// pool, because a user genuinely playing that same pitch (e.g. drone-on-Eb,
// user-on-Eb in unison) would never be recognised and the drone would stick.
//
// Strategy — conditional duck-on-suspicion:
//   • Always vote-exclude the drone's current MIDI from the standard
//     incumbent voting (it never wins by mic-leakage alone).
//   • Track a separate counter of consecutive frames whose top vote MATCHES
//     the drone-MIDI. After SUSPICION_THRESHOLD_FRAMES of agreement, briefly
//     duck the drone (DUCK_MS at DUCK_DEPTH amplitude). The user only hears
//     a soft breath, not a chop.
//   • Enter a POST-DUCK confirmation window (DUCK_MS + ~120 ms). During
//     this window, votes for drone-MIDI ARE counted toward the standard
//     candidate — if YIN still reports drone-pitch after the duck cleared
//     the room, the user really is in unison and the incumbent moves
//     there. If the post-duck frames disagree, the counter resets and we
//     go back to vote-exclusion.
// ---------------------------------------------------------------------------

const SUSPICION_THRESHOLD_FRAMES = 3;
const DUCK_MS = 80;
const DUCK_DEPTH = 0.3; // active player drops to 30 % of target volume during the duck.

// Display-tick decoupling — audio callbacks at 40 Hz write into these rings;
// a requestAnimationFrame tick (~60–120 Hz on Pixel 9 Pro) reads a window-
// sized slice and setStates the smoothed values. RESPONSE controls the
// window size so FAST/NORMAL/SLOW affect the readout cadence the user sees,
// not just the filter's internal state-machine timing.
// Moving-average windows expressed in MILLISECONDS, not sample counts. Sample-
// based windows leak the audio buffer's chunk size into the user-facing
// "RESPONSE" knob — if we ever change buffer duration (or fall back to a
// different audio source with a different cadence) the response speed silently
// shifts. Time-based stays honest: SLOW always means ~200 ms of integration
// regardless of source.
//
// At the current 25 ms buffer cadence (raw-audio-input default) these resolve
// to 1 / 2 / 8 samples. The ring is sized to handle worst-case (200 ms ÷ 5 ms
// buffer = 40 samples → round up to 64 for headroom).
const DISPLAY_RING_SIZE = 64;
const DISPLAY_WINDOW_MS_BY_MODE: Record<FilterMode, number> = {
  fast:    10,
  normal:  50,
  slow:   200,
};

// v1.0.1 — module-level sort comparator; avoids a fresh closure object each RAF tick.
const _compareAsc = (a: number, b: number) => a - b;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type GainMode = 'low' | 'high';
export type EngineStatus =
  | 'waiting-for-mic'
  | 'mic-denied'
  | 'warming-up'
  | 'listening'
  | 'stream-failed';
export type { FilterMode };
export type DisplayMode = 'griff' | 'klingend';

// Forward declared just below — eases circular references in derived types.
export interface AudioEngineState {
  status: EngineStatus;
  /** Sounding frequency in Hz, post-processed through the active filter mode. */
  freqHz: number | null;
  rmsDb: number;
  meterFill: number;
  gainMode: GainMode;
  setGainMode: (m: GainMode) => void;
  // v0.2.1 diagnostics
  yinCallCount: number;
  rawFreqHz: number | null;
  // v0.3.0 filter mode
  filterMode: FilterMode;
  setFilterMode: (m: FilterMode) => void;
  // v0.3.0 instrument selection
  instrumentKey: string;
  setInstrumentKey: (k: string) => void;
  displayMode: DisplayMode;
  setDisplayMode: (m: DisplayMode) => void;
  // v0.3.0 PCM-zero AA detection
  micSilenced: boolean;
  // v0.4.0 new fields
  allowOutOfRange: boolean;
  setAllowOutOfRange: (v: boolean) => void;
  /** false until loadPrefs() resolves on mount — suppress flash of default state */
  prefsLoaded: boolean;
  nickname: string;
  setNickname: (n: string) => void;
  /**
   * Persist current prefs immediately. App.tsx should call this with
   * { refHz: currentRefHz } on AppState 'background' (or any time it wants
   * to flush). The engine's own AppState listener also calls this as a
   * backstop, writing refHz from a4Hz (the two are kept equal by convention).
   */
  savePrefsNow: (extra?: Partial<AppPrefs>) => Promise<void>;
  // v0.6.0 hi-fi audio source
  hiFiMode: boolean;
  setHiFiMode: (v: boolean) => Promise<void>;
  /** true when raw-audio-input module is currently active (hiFiMode=true AND capable). */
  hiFiActive: boolean;
  /** Human-readable audio source label for the diagnostic/settings UI. */
  audioSourceLabel: string;
  /** Reason string when status === 'stream-failed', else null. */
  streamErrorReason: string | null;
  /** Re-request RECORD_AUDIO permission. Use to recover from 'mic-denied'. */
  retryPermission: () => Promise<void>;
  /** Re-open the audio stream after a 'stream-failed' transition. */
  retryStream: () => void;
  // v0.6.4 LIVE / COLLECT mode toggle.
  // peakLock=true → LIVE: continuous tuner. Big arc + note letter + cents.
  // peakLock=false → COLLECT: bucket samples per rounded note; show stats.
  // Both use the same smoothed freq from the display tick — COLLECT just
  // rounds, accumulates, and displays bucket statistics.
  peakLock: boolean;
  setPeakLock: (v: boolean) => void;
  /** User noise gate in dBFS. Range [-80, -10]; default -45. */
  lowCutDb: number;
  setLowCutDb: (db: number) => void;
  /** Active COLLECT bucket (null until a stable pitch is detected). */
  activeBucket: BucketStats | null;
  /** Drop the active bucket — call from the "Clear" button in COLLECT. */
  clearActiveBucket: () => void;
  /** Tap-to-log: explicitly insert the current reading into the active bucket. */
  logCurrentReading: () => LogResult | null;
  /**
   * Remove the most-recently-added sample from the active bucket. Returns the
   * dropped sample's cents, or null if there was nothing to drop. Powers the
   * 6-second ghost UNDO that appears after each manual log.
   */
  undoLastLog: () => number | null;
  // v0.7.0 session model.
  /** True while a session is running. Engine auto-logs sustained pitches. */
  sessionActive: boolean;
  /** ms timestamp when the session started, or null if inactive. */
  sessionStartedAtMs: number | null;
  /** Toggle the session on/off. Starting a new session does NOT clear buckets. */
  setSessionActive: (v: boolean) => void;
  // v0.7.0 quality-gate diagnostics — debug-only. UI should surface these
  // only when the gear-sheet "Show debug overlay" toggle is on.
  /** Count of frames the quality gate rejected since engine start. */
  droppedFrameCount: number;
  /** Last reason a frame was dropped, or null when nothing has been dropped. */
  lastDropReason: QualityRejection;
  // v0.8.0 theme picker. Default 'dark' (the workhorse). 'night' is true
  // AMOLED with optional darken/warmth filters. 'light' is high-contrast white.
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
  /** Multiplicative screen-darken applied when theme === 'night'. 0.4–1.0. */
  nightDarken: number;
  setNightDarken: (v: number) => void;
  /** Warmth tint applied when theme === 'night'. -1 (cool) to +1 (warm). */
  nightWarmth: number;
  setNightWarmth: (v: number) => void;
  /**
   * The current incumbent rounded MIDI — the note the engine has "locked
   * onto" via the hysteresis voting in the RAF tick. Null when no pitch is
   * stable. Updated on every display tick; consumers like the DRONE hook
   * subscribe to it for pitch tracking with the same stability the visible
   * note readout uses (no per-buffer flicker).
   *
   * This is concert-pitch (sounding) MIDI — the same value the displayed
   * note letter is derived from when displayMode === 'klingend'. For
   * displayMode 'griff', App.tsx subtracts the instrument transpose to
   * arrive at the fingered note; the drone tracks sounding pitch so the
   * reference tone matches what the room actually hears.
   */
  incumbentMidi: number | null;
  /** v0.9.0 — picked visual style for the TUNER tab. */
  tunerStyle: 'arc' | 'strobe' | 'led';
  setTunerStyle: (s: 'arc' | 'strobe' | 'led') => void;
  /** v0.9.0 — picked visual style for the METRO tab. */
  metroStyle: 'pulse' | 'pendulum' | 'flash';
  setMetroStyle: (s: 'pulse' | 'pendulum' | 'flash') => void;
  /** v0.9.0 — picked visual style for the DECK tab. */
  deckStyle: 'reels' | 'vu' | 'waveform';
  setDeckStyle: (s: 'reels' | 'vu' | 'waveform') => void;
  /**
   * v0.9.1 metronome calibration — user-tunable click offset in ms. Negative
   * pulls the click earlier (sound arrives sooner). Stacks on top of the
   * per-route base latency. Range [-50, +50], default 0.
   */
  metroClickOffsetMs: number;
  setMetroClickOffsetMs: (ms: number) => void;
  /** v0.9.1 user-declared current audio output route. */
  metroOutputRoute: 'speaker' | 'wired' | 'bluetooth';
  setMetroOutputRoute: (r: 'speaker' | 'wired' | 'bluetooth') => void;
  /** #A4-S1 — canonical A4 reference (Hz), engine-owned. Drives display/drone/
   *  pitch-pipes (re-render) AND the record path (ref mirror) from one source. */
  a4Hz: number;
  setA4Hz: (hz: number) => void;
  // v0.9.1 — drone-chase guard wiring. Drone hook writes its current MIDI
  // here so the engine's vote loop can exclude it from incumbent voting;
  // engine calls back into the drone's duck function when the suspicion
  // counter trips. See SUSPICION_THRESHOLD_FRAMES / DUCK_MS / DUCK_DEPTH at
  // the top of this file for the design narrative.
  /** Set the drone's currently-sounding MIDI (after offset). Null when drone off. */
  setDroneCurrentMidi: (midi: number | null) => void;
  /** Register the drone's duck handler. Pass null on unmount/cleanup. */
  installDroneDuckHandler: (fn: ((ms: number) => void) | null) => void;
}

export interface BucketStats {
  /** Fingered MIDI for this bucket. */
  midiFing: number;
  /** Concert MIDI (sounding). */
  midiSound: number;
  /** Sample count. */
  n: number;
  /** Mean cents off target. */
  meanCents: number;
  /** Population std dev of cents. */
  stdCents: number;
  /** Min / max cents in bucket. */
  rangeMin: number;
  rangeMax: number;
  /** Last up-to-5 cents readings (oldest first). */
  last5: number[];
}

export interface LogResult {
  midiFing: number;
  midiSound: number;
  cents: number;
  n: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeRmsDb(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  const meanSquare = sum / samples.length;
  const db = meanSquare > 0 ? 10 * Math.log10(meanSquare) : -160;
  return Math.max(-160, Math.min(0, db));
}

function dbToMeterFill(db: number, mode: GainMode): number {
  const { floor, ceil } = GAIN_DISPLAY_MAP[mode];
  const norm = (db - floor) / (ceil - floor);
  return Math.max(0, Math.min(1, norm));
}

// Hz → nearest MIDI note number (equal temperament, A4 = a4Hz).
function hzToMidi(hz: number, a4Hz: number): number {
  return Math.round(12 * Math.log2(hz / a4Hz) + 69);
}

// Cents of `freqHz` above the nominal pitch of the integer MIDI `refMidi`.
function exactCentsFromHz(freqHz: number, a4Hz: number, refMidi: number): number {
  const exactMidi = 69 + 12 * Math.log2(freqHz / a4Hz);
  return (exactMidi - refMidi) * 100;
}

// In-memory accumulator for the COLLECT-mode bucket. Public-facing
// BucketStats are computed from this on demand (cheap — capped at 200).
interface BucketAccum {
  midiFing: number;
  midiSound: number;
  samples: number[];
}

const BUCKET_SAMPLE_CAP = 200;

// Session auto-log: when sessionActive is true and the user holds the same
// rounded fingered MIDI for this long, we auto-insert one sample. After a
// log we require another full streak before logging again — sustaining a
// single note for 5 seconds produces one log per SESSION_AUTO_LOG_MS, not
// "every audio buffer that happens to be stable."
const SESSION_AUTO_LOG_MS = 600;

// ---------------------------------------------------------------------------
// COLLECT-mode quality gate.
//
// The auto-accumulation path used to push every YIN-valid frame into the
// bucket. That includes attack transients, releases, slides, and vibrato
// peaks — frames the intonation literature explicitly excludes from
// steady-state pitch estimates. The gate below filters those out before
// the cents value reaches bucketAddSample.
//
// Filters (all on by default; intended to stack):
//
// 1. Transient rejection (df/dt) — Reject when |Δcents|/Δt > 30 ¢/100ms.
//    Catches attack glides, release dips, intentional slides. Cf. Aubio's
//    onset/note-segmentation work; the 30 ¢/100ms threshold sits between
//    "stable vibrato extent" (~20¢ in 200ms = 10¢/100ms) and "audible
//    portamento" (~50¢/100ms).
//
// 2. YIN confidence — Drop frames where confidence (CMND, aperiodicity)
//    exceeds 0.15. Independent of the per-mode yinThreshold that gates
//    `processFrame`; this gate protects the BUCKET, not the filter state
//    machine. Reference: de Cheveigné & Kawahara 2002.
//
// 3. RMS envelope stability — Reject when the std-dev of recent RMS
//    (~125 ms window) exceeds 3 dB. Excludes attack swells and decays;
//    the steady-state region of a saxophone note has RMS variation
//    well under 2 dB for a normal player. Cf. Klapuri & Davy on
//    50–150 ms steady-state regions.
//
// 4. Steady-state confirmation — Require 3 consecutive frames where the
//    exact (non-rounded) MIDI is within ±15¢ of the current rounded MIDI
//    before accumulation starts on a fresh note. Resets when the rounded
//    MIDI changes.
//
// 5. Minimum note duration — Don't accumulate the first 200 ms after a
//    note onset (~8 audio buffers @ 25 ms). Friberg/Bresin (KTH rule
//    system) treat the first 50–100 ms as articulation, not pitch — we
//    extend to 200 ms because saxophone tongue articulations on
//    UNPROCESSED capture often show 100–150 ms of upward slide before
//    settling.
//
// Tap-to-log shortcut: explicit user taps override #4 and #5 (the player
// declared intent) but still respect #1 and #2 (a fingerslip with a
// transient or low-confidence frame would lock in noise; user almost
// always wants this guarded).
// ---------------------------------------------------------------------------

const QG_TRANSIENT_CENTS_PER_MS = 0.3;         // 30¢ / 100ms
const QG_YIN_CONFIDENCE_MAX     = 0.15;
const QG_RMS_RING_SIZE          = 5;           // ~125ms @ 25ms buffers
const QG_RMS_STD_MAX_DB         = 3;
const QG_STEADY_FRAMES          = 3;
const QG_STEADY_CENTS_WINDOW    = 15;
const QG_MIN_ONSET_MS           = 200;

export type QualityRejection =
  | 'transient'
  | 'confidence'
  | 'envelope'
  | 'steady-state'
  | 'onset-hold'
  | null;

interface QualityHistory {
  lastCents:        number | null;
  lastCentsTimeMs:  number;
  lastRoundedMidi:  number | null;
  steadyStreak:     number;
  onsetMs:          number;
  rmsRing:          Float64Array;
  rmsRingHead:      number;
  rmsRingCount:     number;
}

function newQualityHistory(): QualityHistory {
  return {
    lastCents:       null,
    lastCentsTimeMs: 0,
    lastRoundedMidi: null,
    steadyStreak:    0,
    onsetMs:         0,
    rmsRing:         new Float64Array(QG_RMS_RING_SIZE),
    rmsRingHead:     0,
    rmsRingCount:    0,
  };
}

function rmsRingStdDb(h: QualityHistory): number {
  if (h.rmsRingCount < 2) return 0;
  const n = h.rmsRingCount;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += h.rmsRing[i];
  const mean = sum / n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = h.rmsRing[i] - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / n);
}

interface QualityInput {
  nowMs:          number;
  freqHz:         number;
  exactMidi:      number;        // continuous MIDI (e.g. 62.13)
  roundedMidi:    number;
  centsFromRound: number;
  confidence:    number;
  db:            number;
}

interface QualityDecision {
  accept: boolean;
  reason: QualityRejection;
}

/**
 * Evaluate the quality gate for a single frame, updating history in-place.
 * `historyOnly=true` runs the bookkeeping side-effects (rms ring, onset,
 * steady streak) WITHOUT returning a decision — used to keep history fresh
 * when the caller bypasses some filters (e.g. tap-to-log skips #4/#5).
 */
function evaluateQualityGate(
  h: QualityHistory,
  input: QualityInput,
  opts: { skipSteadyAndOnset?: boolean },
): QualityDecision {
  // Always update the RMS ring — even on rejection, it tracks the envelope.
  h.rmsRing[h.rmsRingHead] = input.db;
  h.rmsRingHead = (h.rmsRingHead + 1) % QG_RMS_RING_SIZE;
  if (h.rmsRingCount < QG_RMS_RING_SIZE) h.rmsRingCount += 1;

  // Track onset: when the rounded MIDI changes, reset the onset clock and
  // the steady-state streak. (#4, #5 both anchor here.)
  if (h.lastRoundedMidi !== input.roundedMidi) {
    h.lastRoundedMidi = input.roundedMidi;
    h.onsetMs = input.nowMs;
    h.steadyStreak = 0;
  }

  // #1 Transient (df/dt). Only when we have a previous cents.
  // Use the absolute MIDI delta (in cents) so an octave jump or a different
  // rounded MIDI counts as a huge transient — that's intended, attacks often
  // cross note boundaries.
  if (h.lastCents !== null) {
    const dtMs = Math.max(1, input.nowMs - h.lastCentsTimeMs);
    // Convert previous "absolute" cents to a baseline. We compare via the
    // exact MIDI domain to avoid the +50/-50 wrap that bare `centsFromRound`
    // would cause when crossing a note boundary.
    // Δcents in continuous MIDI = (exactMidi - prevExactMidi) * 100.
    // We stored prevExactMidi as h.lastCents (already scaled).
    const deltaCents = Math.abs(input.exactMidi * 100 - h.lastCents);
    const rate = deltaCents / dtMs;
    if (rate > QG_TRANSIENT_CENTS_PER_MS) {
      // Still bump lastCents so the NEXT frame compares against this one,
      // not against an old frame across the transient.
      h.lastCents = input.exactMidi * 100;
      h.lastCentsTimeMs = input.nowMs;
      return { accept: false, reason: 'transient' };
    }
  }
  h.lastCents = input.exactMidi * 100;
  h.lastCentsTimeMs = input.nowMs;

  // #2 YIN confidence (CMND aperiodicity).
  if (input.confidence > QG_YIN_CONFIDENCE_MAX) {
    h.steadyStreak = 0;
    return { accept: false, reason: 'confidence' };
  }

  // #3 RMS envelope stability.
  const envStd = rmsRingStdDb(h);
  if (envStd > QG_RMS_STD_MAX_DB) {
    return { accept: false, reason: 'envelope' };
  }

  // #4 Steady-state confirmation (skipped on explicit tap-to-log).
  // Increment streak when |centsFromRound| is within window; reset otherwise.
  if (Math.abs(input.centsFromRound) <= QG_STEADY_CENTS_WINDOW) {
    h.steadyStreak += 1;
  } else {
    h.steadyStreak = 0;
  }
  if (!opts.skipSteadyAndOnset && h.steadyStreak < QG_STEADY_FRAMES) {
    return { accept: false, reason: 'steady-state' };
  }

  // #5 Minimum note duration (skipped on tap-to-log).
  if (!opts.skipSteadyAndOnset && input.nowMs - h.onsetMs < QG_MIN_ONSET_MS) {
    return { accept: false, reason: 'onset-hold' };
  }

  return { accept: true, reason: null };
}

function newBucketAccum(midiFing: number, midiSound: number): BucketAccum {
  return { midiFing, midiSound, samples: [] };
}

function bucketAddSample(accum: BucketAccum, cents: number): void {
  accum.samples.push(cents);
  if (accum.samples.length > BUCKET_SAMPLE_CAP) accum.samples.shift();
}

// v1.4 wave-12 — shared eviction helper used by all three bucket-insert call
// sites (tap-to-log, COLLECT auto-accum, session auto-log). Returns the accum
// for midiFing, creating it if absent and evicting the oldest entry when the
// Map would exceed MAX_BUCKETS. Saxophone range is ~50 distinct fingerings;
// 200 is generous for any real session.
const MAX_BUCKETS = 200;
function getOrCreateBucketAccum(
  map: Map<number, BucketAccum>,
  midiFing: number,
  midiSound: number,
): BucketAccum {
  let accum = map.get(midiFing);
  if (!accum) {
    if (map.size >= MAX_BUCKETS) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) map.delete(oldestKey);
    }
    accum = newBucketAccum(midiFing, midiSound);
    map.set(midiFing, accum);
  }
  return accum;
}

function computeBucketStats(accum: BucketAccum): BucketStats {
  const samples = accum.samples;
  const n = samples.length;
  if (n === 0) {
    return {
      midiFing:  accum.midiFing,
      midiSound: accum.midiSound,
      n:         0,
      meanCents: 0,
      stdCents:  0,
      rangeMin:  0,
      rangeMax:  0,
      last5:     [],
    };
  }
  let sum = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = samples[i];
    sum += c;
    sumSq += c * c;
    if (c < min) min = c;
    if (c > max) max = c;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  const std = Number.isFinite(variance) ? Math.sqrt(variance) : 0;
  const last5 = samples.slice(Math.max(0, n - 5));
  return {
    midiFing:  accum.midiFing,
    midiSound: accum.midiSound,
    n,
    meanCents: mean,
    stdCents:  std,
    rangeMin:  min,
    rangeMax:  max,
    last5,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAudioEngine(): AudioEngineState {
  const [status, setStatus] = useState<EngineStatus>('waiting-for-mic');
  const [freqHz, setFreqHz] = useState<number | null>(null);
  const [rmsDb, setRmsDb] = useState<number>(-160);
  const [meterFill, setMeterFill] = useState<number>(0);
  const [gainMode, setGainModeState] = useState<GainMode>('low');
  const [yinCallCount, setYinCallCount] = useState<number>(0);
  const [rawFreqHz, setRawFreqHz] = useState<number | null>(null);
  const [filterMode, setFilterModeState] = useState<FilterMode>('normal');
  const [instrumentKey, setInstrumentKeyState] = useState<string>('bb_tenor');
  const [displayMode, setDisplayModeState] = useState<DisplayMode>('griff');
  const [micSilenced, setMicSilenced] = useState<boolean>(false);
  // v0.4.0
  const [allowOutOfRange, setAllowOutOfRangeState] = useState<boolean>(true);
  const [prefsLoaded, setPrefsLoaded] = useState<boolean>(false);
  const [nickname, setNicknameState] = useState<string>('');
  // v0.6.0 (v0.6.2: default false — see prefs.ts comment)
  const [hiFiMode, setHiFiModeState] = useState<boolean>(false);
  const [hiFiActive, setHiFiActive] = useState<boolean>(false);
  const [audioSourceLabel, setAudioSourceLabel] = useState<string>('');
  const [streamErrorReason, setStreamErrorReason] = useState<string | null>(null);
  const [peakLock, setPeakLockState] = useState<boolean>(true);
  const [lowCutDb, setLowCutDbState] = useState<number>(-45);
  const [theme, setThemeState] = useState<ThemeName>('dark');
  const [nightDarken, setNightDarkenState] = useState<number>(1.0);
  const [nightWarmth, setNightWarmthState] = useState<number>(0);
  // Mirror of incumbentMidiRef for React consumers (drone). Updated only on
  // value change so it doesn't churn React state every RAF frame.
  const [incumbentMidi, setIncumbentMidi] = useState<number | null>(null);
  // v0.9.0 visualisation-style prefs.
  const [tunerStyle, setTunerStyleState] = useState<'arc' | 'strobe' | 'led'>('arc');
  const [metroStyle, setMetroStyleState] = useState<'pulse' | 'pendulum' | 'flash'>('pulse');
  const [deckStyle, setDeckStyleState] = useState<'reels' | 'vu' | 'waveform'>('reels');
  const [metroClickOffsetMs, setMetroClickOffsetMsState] = useState<number>(0);
  const [metroOutputRoute, setMetroOutputRouteState] = useState<'speaker' | 'wired' | 'bluetooth'>('speaker');
  // v0.7.0 session state.
  const [sessionActive, setSessionActiveState] = useState<boolean>(false);
  const [sessionStartedAtMs, setSessionStartedAtMs] = useState<number | null>(null);
  // v0.7.0 quality gate diagnostics.
  const [droppedFrameCount, setDroppedFrameCount] = useState<number>(0);
  const [lastDropReason, setLastDropReason] = useState<QualityRejection>(null);

  // #A4-S1 — canonical A4 reference, ENGINE-OWNED (was an App.tsx useState that
  // never propagated to the record path → logged cents stale at 440). Two faces
  // of one value: reactive STATE so display/drone/pitch-pipes re-render, plus a
  // ref mirror so the onBuffer/record hot path reads it synchronously without a
  // render gap (the filterModeRef pattern). App.tsx refHz is now a read-through.
  const [a4Hz, setA4HzState] = useState<number>(440);
  const a4HzRef = useRef<number>(440);
  a4HzRef.current = a4Hz; // per-render mirror for the audio/record hot path

  // Stable setters.
  const setGainMode = useCallback((m: GainMode) => setGainModeState(m), []);
  const setFilterMode = useCallback((m: FilterMode) => {
    setFilterModeState(m);
    if (filterStateRef.current) {
      resetFilterState(filterStateRef.current);
    }
  // filterStateRef is a stable ref.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setInstrumentKey = useCallback((k: string) => setInstrumentKeyState(k), []);
  const setDisplayMode = useCallback((m: DisplayMode) => setDisplayModeState(m), []);
  const setAllowOutOfRange = useCallback((v: boolean) => setAllowOutOfRangeState(v), []);
  const setNickname = useCallback((n: string) => setNicknameState(n), []);

  // Refs that callbacks read without recreating closures.
  const gainModeRef = useRef<GainMode>('low');
  gainModeRef.current = gainMode;

  const freqHzRef = useRef<number | null>(null);
  freqHzRef.current = freqHz;

  const filterModeRef = useRef<FilterMode>('normal');
  filterModeRef.current = filterMode;

  const instrumentKeyRef = useRef<string>('bb_tenor');
  instrumentKeyRef.current = instrumentKey;

  const displayModeRef = useRef<DisplayMode>('griff');
  displayModeRef.current = displayMode;

  const allowOutOfRangeRef = useRef<boolean>(true);
  allowOutOfRangeRef.current = allowOutOfRange;

  const gainModeStateRef = useRef<GainMode>('low');
  gainModeStateRef.current = gainMode;

  const filterModeStateRef = useRef<FilterMode>('normal');
  filterModeStateRef.current = filterMode;

  const nicknameRef = useRef<string>('');
  nicknameRef.current = nickname;

  const hiFiModeRef = useRef<boolean>(false);
  hiFiModeRef.current = hiFiMode;

  const peakLockRef = useRef<boolean>(true);
  peakLockRef.current = peakLock;

  const lowCutDbRef = useRef<number>(-45);
  lowCutDbRef.current = lowCutDb;

  const rmsDbRef = useRef<number>(-160);
  rmsDbRef.current = rmsDb;

  // Watchdog: last time a buffer arrived in onBuffer. Used by the no-buffer
  // demotion effect to flip 'listening' → 'warming-up' if the JS-thread
  // buffer pump stalls for > 1s. 0 = no buffer seen yet this session.
  const lastBufferAtMs = useRef<number>(0);

  const sessionActiveRef = useRef<boolean>(false);
  sessionActiveRef.current = sessionActive;

  // Session auto-log state: track how long we've been on the same rounded
  // fingered note. When the streak crosses SESSION_AUTO_LOG_MS, we drop one
  // sample into the bucket and immediately reset the streak so we don't
  // spam the bucket with hundreds of samples on a single sustained note.
  const sessionLastMidiRef = useRef<number | null>(null);
  const sessionStreakStartMsRef = useRef<number | null>(null);
  const sessionLastAutoLogMsRef = useRef<number>(0);

  // Last incumbent MIDI we published to React state. Lets the tick guard the
  // setIncumbentMidi call so we only re-render when the locked note changes.
  const incumbentMidiPublishedRef = useRef<number | null>(null);

  // ---------------------------------------------------------------------------
  // Drone chase guard wiring (v0.9.1).
  //
  // The drone hook owns the actual playback. To prevent the engine from
  // chasing the drone via mic leakage we need two thin channels:
  //
  //   • droneCurrentMidiRef — read by the engine's vote loop. The drone hook
  //     writes the live "now sounding" MIDI (incumbent + offset) here on every
  //     transition. Null when drone off. A ref (not state) so the vote loop
  //     never re-renders on drone changes — those happen at audio cadence.
  //
  //   • droneRequestDuckRef — function callable by the engine. The drone hook
  //     installs an implementation on mount; engine invokes it when the
  //     suspicion counter trips. The hook then runs its own brief duck
  //     envelope via the two-slot crossfade infrastructure.
  //
  // droneSuspicionFramesRef tracks the in-flight counter. Reset whenever the
  // top vote disagrees with the drone-MIDI, or after a duck fires.
  // ---------------------------------------------------------------------------
  const droneCurrentMidiRef = useRef<number | null>(null);
  const droneRequestDuckRef = useRef<((ms: number) => void) | null>(null);
  const droneSuspicionFramesRef = useRef<number>(0);
  // Wall-clock time of the last duck request — gate so we don't fire dozens
  // of overlapping ducks if YIN keeps reporting drone-pitch frame after frame
  // while a duck is still in flight.
  const droneLastDuckMsRef = useRef<number>(0);

  // Quality-gate history — opaque struct mutated in-place by evaluateQualityGate.
  // One instance for the whole engine lifetime; persists across mode toggles.
  const qualityHistoryRef = useRef<QualityHistory>(newQualityHistory());
  // Mirror count for the debug overlay (state-bound version of the throwaway
  // counter we bump in onBuffer). Updated at audio rate but it's just an int
  // setState; no perf concern.
  const droppedFrameCountRef = useRef<number>(0);

  // Reentry guard.
  const stopping = useRef(false);

  // Ring buffer.
  const ring = useRef<Float32Array | null>(null);
  const ringFilled = useRef(0);
  const bufferCount = useRef(0);
  const analysisBlock = useRef<Float32Array | null>(null);

  // Filter state.
  const filterStateRef = useRef<FilterState | null>(null);

  // Last accepted stable pitch for octave-jump guard.
  const lastStablePitch = useRef<number | null>(null);

  // PCM-zero AA detection counter.
  const silentBufferCount = useRef(0);

  // Active run ID for measurement logging.
  const runIdRef = useRef<string | null>(null);

  // Display-tick ring buffers. Audio callbacks write; RAF tick reads.
  // NaN = "no pitch this frame" (preserves window position so the average
  // doesn't gain weight on missing samples).
  const displayFreqRing = useRef<Float64Array>(new Float64Array(DISPLAY_RING_SIZE).fill(NaN));
  const displayRmsRing  = useRef<Float64Array>(new Float64Array(DISPLAY_RING_SIZE).fill(-160));
  const displayRingHead = useRef<number>(0);
  const displayRingCount = useRef<number>(0);
  // Most-recent audio buffer's wall-clock duration (samples × 1000 / rate).
  // Used by the RAF tick to convert RESPONSE-in-ms into a sample-count
  // window. Defaults to 25 ms — the raw-audio-input module's default chunk —
  // so the window math works even before the first buffer arrives.
  const bufferDurationMsRef = useRef<number>(25);

  // Note-selection hysteresis. At low frequencies YIN has a particular failure
  // mode: the fundamental and its sub-octave/octave have nearly equal CMND,
  // and noise flips the result. Averaging freq across the window then gives
  // a meaningless midpoint between two notes. Instead we vote on ROUNDED MIDI
  // across a longer-than-RESPONSE buffer, and the incumbent only loses when
  // a rival has a strict vote margin (NOTE_HYSTERESIS_MARGIN). Display freq
  // is the median of the freqs that voted for the incumbent within the
  // RESPONSE-sized window.
  const incumbentMidiRef = useRef<number | null>(null);

  // v1.0.1 — reusable per-tick scratch; eliminates Map + Array allocations at 60–120 Hz.
  const voteCountRef = useRef<Map<number, number>>(new Map());
  const winnerFreqsRef = useRef<number[]>([]);

  // COLLECT bucket accumulator. Each rounded fingered MIDI gets its own
  // BucketAccum (capped at BUCKET_SAMPLE_CAP samples). Switching notes
  // switches buckets — previous buckets are retained in the map so the
  // user can flip back without re-collecting. In-memory only; SQLite
  // logging is explicit via tap-to-log.
  const bucketAccumsRef = useRef<Map<number, BucketAccum>>(new Map());
  const activeBucketKeyRef = useRef<number | null>(null);
  const lastEmittedBucketSig = useRef<string>('');
  const [activeBucket, setActiveBucket] = useState<BucketStats | null>(null);

  // -------------------------------------------------------------------------
  // Both stream hooks are always called (Rules of Hooks). Only one is started
  // at a time, controlled by the stream-start effect below.
  // -------------------------------------------------------------------------
  const { stream: expoStream, isStreaming: expoIsStreaming } = useAudioStream(STREAM_OPTIONS);
  const rawAudioInput = useRawAudioInput(HIFI_OPTIONS);

  // -------------------------------------------------------------------------
  // savePrefsNow — exposed in AudioEngineState so App.tsx can call it with
  // { refHz: currentRefHz } on background transitions.
  // -------------------------------------------------------------------------
  const savePrefsNow = useCallback(async (extra?: Partial<AppPrefs>): Promise<void> => {
    // Read the currently persisted prefs first so fields the engine doesn't
    // track (e.g. minNVisible, lang — owned by App.tsx) survive the flush.
    // Without this, the engine's own AppState 'background' listener would
    // clobber them with defaults on every background event.
    const current = await loadPrefs();
    const prefs: AppPrefs = {
      ...current,
      instrumentKey:   instrumentKeyRef.current,
      nickname:        nicknameRef.current,
      a4Hz:            a4HzRef.current,
      displayMode:     displayModeRef.current,
      filterMode:      filterModeStateRef.current,
      gainMode:        gainModeStateRef.current,
      refHz:           a4HzRef.current,
      allowOutOfRange: allowOutOfRangeRef.current,
      hiFiMode:        hiFiModeRef.current,
      peakLock:        peakLockRef.current,
      lowCutDb:        lowCutDbRef.current,
      ...extra,
    };
    await savePrefs(prefs);
  }, []);

  // -------------------------------------------------------------------------
  // setHiFiMode — async because it stops the active stream before switching.
  // -------------------------------------------------------------------------
  const setPeakLock = useCallback((v: boolean): void => {
    setPeakLockState(v);
    // Fire-and-forget persist — keep the user's choice across restarts.
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, peakLock: v });
      } catch {
        // Ignore — best-effort persistence.
      }
    })();
  }, []);

  const setTheme = useCallback((t: ThemeName): void => {
    setThemeState(t);
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, theme: t });
      } catch {
        // best-effort
      }
    })();
  }, []);

  const setNightDarken = useCallback((v: number): void => {
    const clamped = Math.max(0.4, Math.min(1.0, v));
    setNightDarkenState(clamped);
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, nightDarken: clamped });
      } catch { /* best-effort */ }
    })();
  }, []);

  const setNightWarmth = useCallback((v: number): void => {
    const clamped = Math.max(-1.0, Math.min(1.0, v));
    setNightWarmthState(clamped);
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, nightWarmth: clamped });
      } catch { /* best-effort */ }
    })();
  }, []);

  const setTunerStyle = useCallback((s: 'arc' | 'strobe' | 'led'): void => {
    setTunerStyleState(s);
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, tunerStyle: s });
      } catch { /* best-effort */ }
    })();
  }, []);

  const setMetroStyle = useCallback((s: 'pulse' | 'pendulum' | 'flash'): void => {
    setMetroStyleState(s);
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, metroStyle: s });
      } catch { /* best-effort */ }
    })();
  }, []);

  const setDeckStyle = useCallback((s: 'reels' | 'vu' | 'waveform'): void => {
    setDeckStyleState(s);
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, deckStyle: s });
      } catch { /* best-effort */ }
    })();
  }, []);

  const setMetroClickOffsetMs = useCallback((ms: number): void => {
    // Clamp + round-to-step-5 here so the persisted value is always nice
    // round numbers (avoids ratcheting drift if multiple stepper presses
    // happen during a load-from-prefs).
    const clamped = Math.max(-50, Math.min(50, Math.round(ms / 5) * 5));
    setMetroClickOffsetMsState(clamped);
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, metroClickOffsetMs: clamped });
      } catch { /* best-effort */ }
    })();
  }, []);

  const setMetroOutputRoute = useCallback((r: 'speaker' | 'wired' | 'bluetooth'): void => {
    setMetroOutputRouteState(r);
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, metroOutputRoute: r });
      } catch { /* best-effort */ }
    })();
  }, []);

  // #A4-S1 — live A4 calibration setter. Updates the ref IMMEDIATELY (so the
  // very next audio callback / record sample uses the new reference — closes the
  // stale-record bug), updates state to re-render the display/drone/pipes, and
  // DEBOUNCE-persists (400ms) so a slider scrub doesn't flood storage. Clamp
  // MUST match the prefs-load clamp (prefs.ts) so a live value survives restart
  // byte-identical, with no see↔record divergence across a relaunch.
  const a4SaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setA4Hz = useCallback((hz: number): void => {
    const clamped = Math.max(430, Math.min(450, hz));
    a4HzRef.current = clamped;   // immediate — next record/audio callback is correct
    setA4HzState(clamped);       // re-render display + drone + pitch-pipes
    if (a4SaveTimer.current) clearTimeout(a4SaveTimer.current);
    a4SaveTimer.current = setTimeout(() => {
      a4SaveTimer.current = null;
      savePrefsNow({ a4Hz: clamped }).catch(() => {});
    }, 400);
  }, [savePrefsNow]);

  // ---------------------------------------------------------------------------
  // Drone-chase wiring entry points. Both reset the suspicion counter when
  // the drone state shifts under us — a fresh transition shouldn't carry an
  // old counter forward.
  // ---------------------------------------------------------------------------
  const setDroneCurrentMidi = useCallback((midi: number | null): void => {
    droneCurrentMidiRef.current = midi;
    droneSuspicionFramesRef.current = 0;
  }, []);
  const installDroneDuckHandler = useCallback((fn: ((ms: number) => void) | null): void => {
    droneRequestDuckRef.current = fn;
  }, []);

  const clearActiveBucket = useCallback((): void => {
    const key = activeBucketKeyRef.current;
    if (key !== null) {
      bucketAccumsRef.current.delete(key);
      activeBucketKeyRef.current = null;
    }
    lastEmittedBucketSig.current = '';
    setActiveBucket(null);
  }, []);

  const logCurrentReading = useCallback((): LogResult | null => {
    const freq = freqHzRef.current;
    if (freq === null || freq <= 0) return null;
    const a4 = a4HzRef.current;
    const midiSound = hzToMidi(freq, a4);
    const transp = transpMap[instrumentKeyRef.current] ?? 0;
    const midiFing = midiSound - transp;
    const cents = exactCentsFromHz(freq, a4, midiSound);

    // Apply the relaxed quality gate to user-explicit taps: respect the
    // transient (#1) and confidence (#2) filters but skip steady-state (#4)
    // and minimum-onset (#5). The tap is intentional; the player declared
    // intent. We still reject fingerslips and aperiodic noise.
    //
    // The current freqHz here is the display-tick-smoothed value, not the
    // most recent YIN result, so confidence isn't directly available. We
    // use the quality history's existing state — the most recent frame's
    // confidence was already validated by the bucket gate above. For an
    // additional guard we re-run the transient check against the smoothed
    // freq.
    const exactMidi = 69 + 12 * Math.log2(freq / a4);
    const roundedMidi = Math.round(exactMidi);
    const centsFromRound = (exactMidi - roundedMidi) * 100;
    const tapDecision = evaluateQualityGate(
      qualityHistoryRef.current,
      {
        nowMs:          Date.now(),
        freqHz:         freq,
        exactMidi,
        roundedMidi,
        centsFromRound,
        // The smoothed freq doesn't carry a fresh YIN confidence. Use a
        // permissive value (gate-edge); the most recent YIN call already
        // wrote its confidence to the bucket-rate gate above, so a low-
        // quality run would have failed those frames anyway. Here we just
        // want the transient and envelope checks.
        confidence:    0,
        db:            rmsDbRef.current,
      },
      { skipSteadyAndOnset: true },
    );
    if (!tapDecision.accept) {
      // Bump diagnostic counter but DON'T add to bucket. Caller gets null
      // back which lets the UI flash the bar red.
      droppedFrameCountRef.current = (droppedFrameCountRef.current + 1) % 100000;
      setDroppedFrameCount(droppedFrameCountRef.current);
      setLastDropReason(tapDecision.reason);
      return null;
    }

    // v1.4 wave-12 — use shared helper (eviction logic consolidated there).
    const accum = getOrCreateBucketAccum(bucketAccumsRef.current, midiFing, midiSound);
    bucketAddSample(accum, cents);
    activeBucketKeyRef.current = midiFing;

    const stats = computeBucketStats(accum);
    setActiveBucket(stats);
    return { midiFing, midiSound, cents, n: stats.n };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const undoLastLog = useCallback((): number | null => {
    const key = activeBucketKeyRef.current;
    if (key === null) return null;
    const accum = bucketAccumsRef.current.get(key);
    if (!accum || accum.samples.length === 0) return null;
    const dropped = accum.samples.pop() ?? null;
    // Force the RAF-tick dirty check to fire so the UI updates on the next
    // frame — its signature is bucket-key:n:lastCents, all of which just
    // changed.
    lastEmittedBucketSig.current = '';
    if (accum.samples.length === 0) {
      // Empty bucket — drop it entirely so the UI shows "no active bucket"
      // rather than a misleading n=0 card.
      bucketAccumsRef.current.delete(key);
      activeBucketKeyRef.current = null;
      setActiveBucket(null);
    } else {
      setActiveBucket(computeBucketStats(accum));
    }
    return dropped;
  }, []);

  const setSessionActive = useCallback((v: boolean): void => {
    setSessionActiveState(v);
    if (v) {
      setSessionStartedAtMs(Date.now());
      // Reset the streak tracker so the first sustained note after start
      // triggers an auto-log instead of inheriting a stale streak.
      sessionLastMidiRef.current = null;
      sessionStreakStartMsRef.current = null;
      sessionLastAutoLogMsRef.current = 0;
    } else {
      setSessionStartedAtMs(null);
    }
  }, []);


  const setLowCutDb = useCallback((db: number): void => {
    const clamped = Math.max(-80, Math.min(-10, Math.round(db)));
    setLowCutDbState(clamped);
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, lowCutDb: clamped });
      } catch {
        // Ignore — best-effort persistence.
      }
    })();
  }, []);

  const setHiFiMode = useCallback(async (v: boolean): Promise<void> => {
    if (v === hiFiModeRef.current) return;
    // Switching is handled by the stream-start effect when hiFiMode state
    // changes. We update state and persist; the effect picks up the change.
    setHiFiModeState(v);
    // Persist immediately — don't wait for AppState background.
    const current = await loadPrefs();
    await savePrefs({ ...current, hiFiMode: v });
  }, []);

  // -------------------------------------------------------------------------
  // Step 1: load prefs on mount, then init DB and start first run.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prefs = await loadPrefs();
        if (cancelled) return;
        // Hydrate state from persisted prefs.
        setFilterModeState(prefs.filterMode);
        setInstrumentKeyState(prefs.instrumentKey);
        setDisplayModeState(prefs.displayMode);
        setGainModeState(prefs.gainMode);
        setAllowOutOfRangeState(prefs.allowOutOfRange);
        setNicknameState(prefs.nickname);
        setHiFiModeState(prefs.hiFiMode);
        setPeakLockState(prefs.peakLock);
        setLowCutDbState(prefs.lowCutDb);
        setThemeState(prefs.theme);
        setNightDarkenState(prefs.nightDarken);
        setNightWarmthState(prefs.nightWarmth);
        setTunerStyleState(prefs.tunerStyle);
        setMetroStyleState(prefs.metroStyle);
        setDeckStyleState(prefs.deckStyle);
        setMetroClickOffsetMsState(prefs.metroClickOffsetMs);
        setMetroOutputRouteState(prefs.metroOutputRoute);
        a4HzRef.current = prefs.a4Hz;
        setA4HzState(prefs.a4Hz);   // #A4-S1 — hydrate state DIRECT (not via setA4Hz → no save-loop on load)
        setPrefsLoaded(true);

        // Init DB and open first run after prefs are known.
        try {
          await initMeasurementsDb();
          if (!cancelled) {
            const id = await startRun({
              instrument: prefs.instrumentKey,
              a4Hz:       prefs.a4Hz,
              nickname:   prefs.nickname,
              studentId:  null,
            });
            if (!cancelled) runIdRef.current = id;
          }
        } catch {
          // Measurement DB errors must not prevent the tuner from starting.
        }
      } catch {
        if (!cancelled) setPrefsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  // Run exactly once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Open a new run whenever instrumentKey changes mid-session (matches the
  // desktop session model: one run per contiguous (instrument, a4Hz) pair).
  // Skip the very first render where prefsLoaded is still false — the mount
  // effect above handles the initial run.
  // -------------------------------------------------------------------------
  const prevInstrumentKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!prefsLoaded) return;
    if (prevInstrumentKeyRef.current === instrumentKey) return;
    prevInstrumentKeyRef.current = instrumentKey;
    // Don't open a second initial run on the same tick as mount.
    if (runIdRef.current === null) return;
    // v1.4 wave-11 T1 — reset YIN/filter state so the previous instrument's
    // pitch history doesn't poison the new instrument's first note (stale
    // octave-jump guard, stale filter decisions).
    lastStablePitch.current = null;
    filterStateRef.current = null;
    qualityHistoryRef.current = newQualityHistory();
    // v1.4 wave-11 T2 — clear bucket accumulator: transposition changed, so
    // old midiFing keys are unreachable and count toward the 200-entry cap.
    bucketAccumsRef.current.clear();
    (async () => {
      try {
        const id = await startRun({
          instrument: instrumentKey,
          a4Hz:       a4HzRef.current,
          nickname:   nicknameRef.current,
          studentId:  null,
        });
        runIdRef.current = id;
      } catch {
        // Best-effort.
      }
    })();
  }, [instrumentKey, prefsLoaded]);

  // -------------------------------------------------------------------------
  // Save-on-background via AppState listener.
  // The listener writes what the engine knows. For refHz, it uses a4HzRef —
  // correct as long as App.tsx keeps the two in sync (which it should).
  // Frodo can call savePrefsNow({ refHz }) independently if he needs finer
  // control.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') {
        // Fire-and-forget; errors swallowed inside savePrefsNow.
        savePrefsNow().catch(() => {});
      }
    });
    return () => sub.remove();
  // savePrefsNow is stable (useCallback with no deps that change).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Step 2: request mic permission on mount
  // -------------------------------------------------------------------------
  const requestPermission = useCallback(async (): Promise<void> => {
    try {
      const res = await AudioModule.requestRecordingPermissionsAsync();
      setStatus(res.granted ? 'warming-up' : 'mic-denied');
    } catch {
      setStatus('mic-denied');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await AudioModule.requestRecordingPermissionsAsync();
        if (cancelled) return;
        setStatus(res.granted ? 'warming-up' : 'mic-denied');
      } catch {
        if (!cancelled) setStatus('mic-denied');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * Re-request RECORD_AUDIO. Call from a "Try Again" button after the user
   * returns from system Settings. If they granted from Settings, this picks
   * up the existing grant without a second OS dialog.
   */
  const retryPermission = useCallback(async (): Promise<void> => {
    await requestPermission();
  }, [requestPermission]);

  /**
   * Clear the stream-failed state and let the stream-start effect re-fire.
   * Flipping status to 'warming-up' changes the effect's dep tuple, which
   * triggers a fresh start() attempt and a new listener subscription.
   */
  const retryStream = useCallback((): void => {
    setStreamErrorReason(null);
    setStatus('warming-up');
  }, []);

  // -------------------------------------------------------------------------
  // Step 3: open stream once permission is granted.
  // When hiFiMode is true and the device is capable, start the raw module.
  // Otherwise fall back to expo-audio.
  // When hiFiMode flips, the old stream is stopped and the new one starts.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (status === 'mic-denied' || status === 'waiting-for-mic') return;

    // Determine which source to use.
    // hiFiActive is set based on hiFiMode AND capability.
    const useHiFi = hiFiMode && (rawAudioInput.capability?.supportsUnprocessed ?? false);
    setHiFiActive(useHiFi);

    // Per-effect cancellation flag. Survives even if a later effect run flips
    // `stopping.current` back to false; the .catch handlers below check it
    // before any setState so a stale promise can't poison a fresh session.
    let cancelled = false;
    stopping.current = false;
    setStreamErrorReason(null);

    // Reset signal-processing state for the new session.
    ring.current = new Float32Array(RING_BUFFER_CAPACITY);
    analysisBlock.current = new Float32Array(RING_BUFFER_CAPACITY);
    ringFilled.current = 0;
    bufferCount.current = 0;
    lastStablePitch.current = null;
    silentBufferCount.current = 0;
    filterStateRef.current = newFilterState();

    let sub: { remove(): void } | null = null;
    let errSub: { remove(): void } | null = null;

    // Snapshot the stream handle that this effect actually started, so the
    // cleanup stops THIS session — not whichever stream the next render
    // happens to expose. (rawAudioInput.stream is rebuilt every render.)
    const startedRawStream = useHiFi ? rawAudioInput.stream ?? null : null;
    const startedExpoStream = !useHiFi ? expoStream : null;

    if (useHiFi) {
      if (!startedRawStream) return;

      sub = startedRawStream.addListener('audioStreamBuffer', (buf: RawAudioBuffer) => {
        onBuffer({ data: buf.data, sampleRate: buf.sampleRate });
      });

      // Native-side capture-thread failures (ERROR_DEAD_OBJECT, etc.) surface
      // as audioStreamError. Without this listener, status would stay
      // 'listening' even after buffers stop arriving.
      errSub = startedRawStream.addErrorListener?.((reason: string) => {
        if (cancelled) return;
        setStreamErrorReason(reason);
        setStatus('stream-failed');
      }) ?? null;

      startedRawStream.start().catch((err) => {
        if (cancelled) return;
        console.warn('useAudioEngine: rawStream.start() failed', err);
        setStreamErrorReason(String(err?.message ?? err));
        setStatus('stream-failed');
      });
    } else {
      if (!startedExpoStream) return;

      startedExpoStream.start().catch((err) => {
        if (cancelled) return;
        console.warn('useAudioEngine: expoStream.start() failed', err);
        setStreamErrorReason(String(err?.message ?? err));
        setStatus('stream-failed');
      });

      sub = startedExpoStream.addListener('audioStreamBuffer', (buf: AudioStreamBuffer) => {
        onBuffer({ data: buf.data, sampleRate: buf.sampleRate });
      });
    }

    return () => {
      cancelled = true;
      stopping.current = true;
      if (sub) sub.remove();
      if (errSub) errSub.remove();

      // Stop the stream that THIS effect actually started.
      if (startedRawStream) {
        startedRawStream.stop().catch(() => {});
      }
      if (startedExpoStream) {
        try {
          startedExpoStream.stop();
        } catch {
          // stop() is synchronous void — errors are non-fatal.
        }
      }

      ring.current = null;
      analysisBlock.current = null;
      filterStateRef.current = null;
    };
  // Re-run when: permission status resolves, hiFiMode toggles, or capability
  // loads (rawAudioInput.capability is initially null).
  //
  // We deliberately do NOT depend on rawAudioInput.stream?.id — the raw
  // module bumps sessionId on every successful start(), which would cause
  // this effect to re-run, stop the stream we just started, and try again
  // (open/stop ~5 Hz forever). If the native stream truly dies, the
  // audioStreamError listener above transitions status → 'stream-failed',
  // which IS in the dep list and triggers a clean re-entry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    status === 'waiting-for-mic' || status === 'mic-denied' || status === 'stream-failed',
    hiFiMode,
    rawAudioInput.capability?.supportsUnprocessed,
  ]);

  // -------------------------------------------------------------------------
  // Keep isStreaming and audioSourceLabel up to date.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (
      status === 'mic-denied' ||
      status === 'waiting-for-mic' ||
      status === 'stream-failed'
    ) return;
    const streaming = hiFiActive ? rawAudioInput.isStreaming : expoIsStreaming;
    // Only promote to 'listening' if buffers ARE actually arriving in the
    // JS thread. If the stream layer claims streaming but onBuffer has gone
    // quiet for > 1s, stay in 'warming-up' — the pill must not lie.
    if (streaming) {
      const now = Date.now();
      const sinceLast = now - lastBufferAtMs.current;
      const buffersFlowing = lastBufferAtMs.current > 0 && sinceLast < 1000;
      setStatus(buffersFlowing ? 'listening' : 'warming-up');
    } else {
      setStatus('warming-up');
    }
  }, [hiFiActive, rawAudioInput.isStreaming, expoIsStreaming, status]);

  // Buffer-flow watchdog: re-evaluate every 500 ms so the status pill
  // demotes when the JS-side buffer pump stalls (Auto sleep, mic stolen,
  // etc) even though the stream layer hasn't signalled an error.
  useEffect(() => {
    if (
      status === 'mic-denied' ||
      status === 'waiting-for-mic' ||
      status === 'stream-failed'
    ) return;
    const id = setInterval(() => {
      const now = Date.now();
      const last = lastBufferAtMs.current;
      const sinceLast = last > 0 ? now - last : Number.POSITIVE_INFINITY;
      if (sinceLast > 1000 && status === 'listening') {
        setStatus('warming-up');
      } else if (sinceLast <= 1000 && status === 'warming-up') {
        setStatus('listening');
      }
    }, 500);
    return () => clearInterval(id);
  }, [status]);

  // Compute the audio source label from the active stream.
  useEffect(() => {
    if (hiFiActive && rawAudioInput.stream) {
      const src = rawAudioInput.stream.activeSource;
      const rate = rawAudioInput.stream.sampleRate;
      const khz = (rate / 1000).toFixed(1);
      const label =
        src === 'unprocessed'       ? `UNPROCESSED · ${khz} kHz` :
        src === 'voice_recognition' ? `VOICE · ${khz} kHz` :
                                      `MIC · ${khz} kHz`;
      setAudioSourceLabel(label);
    } else {
      setAudioSourceLabel('expo-audio · 44.1 kHz');
    }
  }, [hiFiActive, rawAudioInput.stream, rawAudioInput.isStreaming]);

  // -------------------------------------------------------------------------
  // onBuffer — unified handler for both sources.
  // Receives a { data: ArrayBuffer, sampleRate: number } shape from either path.
  // -------------------------------------------------------------------------
  const onBuffer = useCallback((buffer: { data: ArrayBuffer | Uint8Array; sampleRate: number }) => {
    if (stopping.current) return;
    // Stamp on every buffer arrival so the watchdog can demote 'listening'
    // back to 'warming-up' if buffers stop flowing for > 1s. Without this,
    // the status pill can lie — the stream layer reports "streaming" while
    // the JS thread sees nothing arriving (Android Auto sleeps, mic stolen,
    // etc).
    lastBufferAtMs.current = Date.now();

    // The raw-audio-input native module delivers bytes as a Uint8Array (the
    // Expo bridge's default for Kotlin ByteArray). expo-audio delivers an
    // ArrayBuffer directly. Reinterpret either as little-endian Float32
    // WITHOUT copying — `new Float32Array(uint8)` would copy byte values
    // (4800 garbage floats), not reinterpret bytes as four-byte floats.
    const raw = buffer.data;
    let incoming: Float32Array;
    if (raw instanceof Float32Array) {
      incoming = raw;
    } else if (raw instanceof ArrayBuffer) {
      incoming = new Float32Array(raw);
    } else {
      // Uint8Array (or any other ArrayBufferView): build a view over the
      // same backing buffer at the same offset, length in float32 units.
      const view = raw as Uint8Array;
      incoming = new Float32Array(view.buffer, view.byteOffset, view.byteLength >> 2);
    }
    const n = incoming.length;
    if (n === 0) return;

    // --- PCM-zero AA detection ---
    let maxAbs = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(incoming[i]);
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs < 1e-9) {
      silentBufferCount.current += 1;
      if (silentBufferCount.current >= SILENT_BUFFER_THRESHOLD) {
        setMicSilenced(true);
      }
    } else {
      silentBufferCount.current = 0;
      setMicSilenced(false);
    }

    // --- Ring buffer management ---
    if (!ring.current) {
      ring.current = new Float32Array(RING_BUFFER_CAPACITY);
      analysisBlock.current = new Float32Array(RING_BUFFER_CAPACITY);
      ringFilled.current = 0;
    }

    const r = ring.current;

    if (n >= RING_BUFFER_CAPACITY) {
      r.set(incoming.subarray(n - RING_BUFFER_CAPACITY));
      ringFilled.current = RING_BUFFER_CAPACITY;
    } else if (ringFilled.current + n <= RING_BUFFER_CAPACITY) {
      r.set(incoming, ringFilled.current);
      ringFilled.current += n;
    } else {
      const keep = RING_BUFFER_CAPACITY - n;
      const srcStart = ringFilled.current - keep;
      // v1.4 wave-7 — T3 (option a): guard against negative srcStart. In
      // practice the else-branch condition (ringFilled + n > RING_BUFFER_CAPACITY)
      // guarantees srcStart = ringFilled - (RING_BUFFER_CAPACITY - n) > 0, so
      // this should never fire. But TypedArray.copyWithin treats negative indices
      // as offsets-from-end and would silently corrupt the buffer, so we skip
      // the eviction when srcStart is non-positive rather than trust the
      // invariant unconditionally.
      if (srcStart > 0) {
        r.copyWithin(0, srcStart, ringFilled.current);
      }
      r.set(incoming, keep);
      ringFilled.current = RING_BUFFER_CAPACITY;
    }

    bufferCount.current += 1;

    // --- RMS ---
    const db = computeRmsDb(incoming);
    const fill = dbToMeterFill(db, gainModeRef.current);

    // --- Pitch detection ---
    // v1.4 wave-5 — L1: init to null, not stale freqHzRef.current.
    // If YIN returns null (silence, RMS floor, YIN failure) the yinFired
    // block is skipped entirely, so nextFreq would retain any stale init
    // value and leak into the display ring as a phantom Hz rather than NaN.
    // Initialising to null ensures the ring always writes NaN on silent
    // frames, satisfying the silence-over-wrong invariant on all YIN-null paths.
    let nextFreq: number | null = null;
    let nextRaw: number | null = null;
    let yinFired = false;

    if (bufferCount.current >= BUFFERS_PER_YIN_CALL && ringFilled.current >= RING_BUFFER_CAPACITY) {
      bufferCount.current = 0;
      yinFired = true;

      const mode = filterModeRef.current;
      const preset = FILTER_PRESETS[mode];

      let sumSq = 0;
      for (let i = 0; i < n; i++) {
        sumSq += incoming[i] * incoming[i];
      }
      const rmsLinear = Math.sqrt(sumSq / n);

      let rawHz: number | null = null;
      // YIN's confidence (CMND aperiodicity) — propagated to the quality gate
      // so #2 (confidence drop) can reject low-quality frames before they
      // pollute the bucket. Default to 1 (worst) so a missing/failed YIN call
      // automatically fails the gate.
      let frameConfidence = 1;

      // Combined RMS gate: take the higher of the per-mode preset floor and
      // the user's low-cut. The user can raise the gate (e.g. -30 dB for a
      // noisy room) but never lower it below the mode-tuned minimum.
      const userFloorLinear = Math.pow(10, lowCutDbRef.current / 20);
      const effectiveFloor = Math.max(preset.rmsFloorLinear, userFloorLinear);
      if (rmsLinear >= effectiveFloor) {
        analysisBlock.current!.set(r);

        const result = (() => {
          try {
            return yinPitch(analysisBlock.current!, buffer.sampleRate, preset.yinThreshold);
          } catch {
            return null;
          }
        })();

        if (result !== null && result.freqHz > 0) {
          nextRaw = result.freqHz;
          frameConfidence = result.confidence;
          let candidate = result.freqHz;

          if (lastStablePitch.current !== null) {
            const prev = lastStablePitch.current;
            const distSelf   = Math.abs(candidate - prev);
            const distHalf   = Math.abs(candidate - prev / 2);
            const distDouble = Math.abs(candidate - prev * 2);
            if (
              (distHalf < distSelf || distDouble < distSelf) &&
              Math.min(distHalf, distDouble) < distSelf * 0.5
            ) {
              candidate = -1;
            }
          }

          if (candidate > 0) {
            lastStablePitch.current = candidate;
            rawHz = candidate;
          }
        }
      }

      if (!filterStateRef.current) {
        filterStateRef.current = newFilterState();
      }
      const processed = processFrame(
        filterStateRef.current,
        rawHz,
        preset,
        buffer.sampleRate,
        a4HzRef.current,   // #A4-S2 — canonical A4 so clustering honours calibration
      );

      // LIVE / COLLECT both feed the same smoothed-freq path. The mode only
      // changes the UI presentation and the bucket-accumulation behavior:
      // COLLECT auto-accumulates samples into the active bucket; LIVE
      // accumulates only on explicit tap-to-log via logCurrentReading().
      //
      // Earlier we routed BIN through the desktop filter's confirmed output
      // (`processed`); that was the bug — the filter is too strict for
      // Android UNPROCESSED mic levels and rarely emits.
      void processed; // kept for now in case we want a "show only confirmed" toggle later

      // v1.4 wave-4 — L1: quality gate (silence-over-wrong invariant).
      // Per [[feedback-bellcurve-silence-over-wrong]] — reject means don't
      // display, not display-stale. nextFreq is only set to nextRaw AFTER the
      // gate accepts the frame. A rejected frame leaves nextFreq null so the
      // display ring writes NaN and the vote pool sees no entry for that frame.
      // This prevents a low-confidence or transient YIN output from locking
      // the wrong note in the display or the accumulation buckets.
      let gateDecision: QualityDecision | null = null;
      if (nextRaw !== null && nextRaw > 0) {
        const a4 = a4HzRef.current;
        const exactMidi = 69 + 12 * Math.log2(nextRaw / a4);
        const roundedMidi = Math.round(exactMidi);
        const centsFromRound = (exactMidi - roundedMidi) * 100;
        gateDecision = evaluateQualityGate(
          qualityHistoryRef.current,
          {
            nowMs:          Date.now(),
            freqHz:         nextRaw,
            exactMidi,
            roundedMidi,
            centsFromRound,
            confidence:    frameConfidence,
            db,
          },
          { skipSteadyAndOnset: false },
        );
        if (gateDecision.accept) {
          // Gate passed — this frame is safe to display and vote on.
          nextFreq = nextRaw;
        } else {
          // Gate rejected — silence-over-wrong: do NOT promote nextRaw to the
          // display ring. nextFreq remains null (no-display sentinel), ensuring
          // NaN is written to displayFreqRing and this frame is excluded from
          // the median vote.
          nextFreq = null;
          droppedFrameCountRef.current = (droppedFrameCountRef.current + 1) % 100000;
          setDroppedFrameCount(droppedFrameCountRef.current);
          setLastDropReason(gateDecision.reason);
        }
      }

      // COLLECT auto-accumulation: when peakLock=false and the quality gate
      // accepts this frame, push cents into the bucket for the rounded note.
      // Switching notes auto-switches buckets (each note has its own
      // history in the session). The gate handles transient/onset/steady
      // filtering so we don't pollute the bucket with attack glides.
      if (
        !peakLockRef.current &&
        nextRaw !== null && nextRaw > 0 &&
        gateDecision !== null && gateDecision.accept
      ) {
        const a4 = a4HzRef.current;
        const midiSound = hzToMidi(nextRaw, a4);
        const transp = transpMap[instrumentKeyRef.current] ?? 0;
        const midiFing = midiSound - transp;
        const cents = exactCentsFromHz(nextRaw, a4, midiSound);
        // v1.4 wave-12 — use shared helper; applies MAX_BUCKETS eviction cap.
        const accum = getOrCreateBucketAccum(bucketAccumsRef.current, midiFing, midiSound);
        bucketAddSample(accum, cents);
        activeBucketKeyRef.current = midiFing;
      }

      // Session auto-log: independent of peakLock. While a session is
      // active, hold the same rounded fingered note for SESSION_AUTO_LOG_MS
      // to drop one sample into its bucket. The quality gate must also
      // accept the frame — sessions inherit the same transient/confidence
      // guards so a vibrato peak doesn't get auto-logged as a "real" note.
      if (
        sessionActiveRef.current &&
        nextRaw !== null && nextRaw > 0 &&
        gateDecision !== null && gateDecision.accept
      ) {
        const a4 = a4HzRef.current;
        const midiSound = hzToMidi(nextRaw, a4);
        const transp = transpMap[instrumentKeyRef.current] ?? 0;
        const midiFing = midiSound - transp;
        const now = Date.now();

        if (sessionLastMidiRef.current !== midiFing) {
          // Note changed — start a new streak.
          sessionLastMidiRef.current = midiFing;
          sessionStreakStartMsRef.current = now;
        } else if (
          sessionStreakStartMsRef.current !== null &&
          now - sessionStreakStartMsRef.current >= SESSION_AUTO_LOG_MS &&
          now - sessionLastAutoLogMsRef.current >= SESSION_AUTO_LOG_MS
        ) {
          // Streak crossed the threshold — log one sample.
          const cents = exactCentsFromHz(nextRaw, a4, midiSound);
          // v1.4 wave-12 — use shared helper; applies MAX_BUCKETS eviction cap.
          const accum = getOrCreateBucketAccum(bucketAccumsRef.current, midiFing, midiSound);
          bucketAddSample(accum, cents);
          activeBucketKeyRef.current = midiFing;
          sessionLastAutoLogMsRef.current = now;
          // Restart the streak so we don't double-log this same hold.
          sessionStreakStartMsRef.current = now;
        }
      } else if (sessionActiveRef.current && (nextRaw === null || nextRaw <= 0)) {
        // Silence breaks the streak. Next sustained note starts fresh.
        sessionLastMidiRef.current = null;
        sessionStreakStartMsRef.current = null;
      }

      // --- Measurement logging (always log; allowOutOfRange filtering is display-layer) ---
      if (processed !== null && runIdRef.current !== null) {
        const a4Hz = a4HzRef.current;
        const midiSound = hzToMidi(processed, a4Hz);
        const transp = transpMap[instrumentKeyRef.current] ?? 0;
        // transp = sounding_midi - fingered_midi  →  fingered_midi = sounding_midi - transp
        const midiFing = midiSound - transp;
        const runId = runIdRef.current;
        const instrument = instrumentKeyRef.current;
        // Fire-and-forget — must not await inside onBuffer.
        insertMeasurement({
          runId,
          ts:         new Date().toISOString(),
          instrument,
          a4Hz,
          midiSound,
          midiFing,
          cents:      1200 * Math.log2(processed / (a4Hz * Math.pow(2, (midiSound - 69) / 12))),
          freqHz:     processed,
          studentId:  null,
        }).catch(() => {});
      }
    }

    // Write to the display-tick ring instead of setStating per-buffer. The
    // RAF tick below reads back, averages over the RESPONSE-sized window,
    // and pushes through to React. fill is rederived from rmsDb in the tick
    // (so a gainMode change is reflected on the next frame, not after the
    // next audio buffer).
    const head = displayRingHead.current;
    displayFreqRing.current[head] = nextFreq != null && nextFreq > 0 ? nextFreq : NaN;
    displayRmsRing.current[head] = db;
    displayRingHead.current = (head + 1) % DISPLAY_RING_SIZE;
    if (displayRingCount.current < DISPLAY_RING_SIZE) displayRingCount.current += 1;

    // Keep the RAF tick's ms-to-samples conversion honest. Buffer cadence
    // depends on the audio source (raw-audio-input's bufferDurationMs vs.
    // expo-audio's default); cheap to update per-frame from what arrived.
    if (n > 0 && buffer.sampleRate > 0) {
      bufferDurationMsRef.current = (n * 1000) / buffer.sampleRate;
    }

    // Diagnostic state still updates at audio rate — these are debug signals,
    // not display surfaces, so smoothing would just hide what's happening.
    if (yinFired) {
      setYinCallCount((c) => (c + 1) % 1000);
      setRawFreqHz(nextRaw);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Display-tick: pumps the ring buffers through React at ~screen-refresh
  // cadence. RESPONSE drives the moving-average window (3 / 5 / 8). When the
  // pitch ring is all-NaN (no detection in window), freqHz goes null and the
  // readout blanks naturally.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let rafHandle = 0;

    const tick = () => {
      if (cancelled) return;

      // RESPONSE window in ms → samples, using the live buffer duration.
      // At 25 ms buffers: fast=1 sample, normal=2, slow=8. At 10 ms buffers:
      // fast=1, normal=5, slow=20. Clamped to ring size for safety.
      const windowMs = DISPLAY_WINDOW_MS_BY_MODE[filterModeRef.current];
      const bufMs = bufferDurationMsRef.current || 25;
      const windowSize = Math.max(1, Math.min(DISPLAY_RING_SIZE, Math.ceil(windowMs / bufMs)));
      const available = Math.min(windowSize, displayRingCount.current);

      if (available > 0) {
        const head = displayRingHead.current;
        const a4 = a4HzRef.current;

        // -----------------------------------------------------------------
        // Note-selection hysteresis (low-frequency stability).
        //
        // Step 1 — vote on rounded MIDI across the FULL ring (not the
        //          RESPONSE window). Longer voting horizon = more
        //          inertia against octave/sub-octave flips. Each freq
        //          gets one vote; NaN slots skipped.
        // Step 2 — pick the candidate with the most votes.
        // Step 3 — apply hysteresis: incumbent stays unless rival beats
        //          it by ≥ NOTE_HYSTERESIS_MARGIN votes. Prevents single-
        //          frame noise from flipping the displayed note.
        // Step 4 — RESPONSE-window median of the freqs that voted for
        //          the incumbent gives the displayed pitch within that
        //          note. Median (vs mean) is robust to a stray outlier
        //          within the bucket.
        // -----------------------------------------------------------------
        const NOTE_VOTE_WINDOW = displayRingCount.current; // up to ring size
        const NOTE_HYSTERESIS_MARGIN = 2;
        // v1.0.1 — reuse hoisted Map ref; clear instead of allocate.
        const voteCount = voteCountRef.current;
        voteCount.clear();
        let rmsSum = 0;
        let rmsN = 0;

        for (let i = 0; i < NOTE_VOTE_WINDOW; i++) {
          const idx = (head - 1 - i + DISPLAY_RING_SIZE) % DISPLAY_RING_SIZE;
          const f = displayFreqRing.current[idx];
          if (Number.isFinite(f)) {
            const midi = Math.round(12 * Math.log2(f / a4) + 69);
            voteCount.set(midi, (voteCount.get(midi) ?? 0) + 1);
          }
        }
        // RMS averages over the RESPONSE window — the meter should react
        // at the user's chosen cadence, separate from note selection.
        for (let i = 0; i < available; i++) {
          const idx = (head - 1 - i + DISPLAY_RING_SIZE) % DISPLAY_RING_SIZE;
          rmsSum += displayRmsRing.current[idx];
          rmsN += 1;
        }

        // -----------------------------------------------------------------
        // Step 2 — find top candidate, with drone-chase guard.
        //
        // The drone's CURRENT MIDI (if any) is excluded from the standard
        // vote: any votes that land on it are bookmarked separately and
        // routed through the suspicion counter. If the user is genuinely
        // playing that pitch we'll prove it via the duck-on-suspicion path
        // a few frames from now; in the meantime mic leakage can't push the
        // incumbent there.
        // -----------------------------------------------------------------
        const droneMidi = droneCurrentMidiRef.current;
        let topMidi = -1;
        let topVotes = 0;
        let topMidiIncludingDrone = -1;
        let topVotesIncludingDrone = 0;
        for (const [m, v] of voteCount) {
          if (v > topVotesIncludingDrone) {
            topVotesIncludingDrone = v;
            topMidiIncludingDrone = m;
          }
          // Drone-MIDI never wins the standard vote.
          if (droneMidi !== null && m === droneMidi) continue;
          if (v > topVotes) { topVotes = v; topMidi = m; }
        }

        // -----------------------------------------------------------------
        // Drone-chase suspicion accounting.
        //
        // We look at the ABSOLUTE top vote (including drone-MIDI) — if that
        // matches the drone's pitch on consecutive frames, either the user
        // is genuinely playing in unison or the mic is hearing the drone.
        //
        // State machine:
        //   • Top vote ≠ drone-MIDI → counter reset to 0; vote-exclusion
        //     keeps the incumbent honest.
        //   • Top vote = drone-MIDI, counter < threshold → bump counter,
        //     still vote-exclude. (Could be transient leakage.)
        //   • Counter hits threshold → fire the duck and enter a brief
        //     POST-DUCK confirmation window. During that window, votes for
        //     drone-MIDI ARE counted toward the standard candidate (so a
        //     genuine unison player gets the incumbent to move). When the
        //     window expires, we reset to step 1.
        //   • Duck fires are rate-limited so we don't stack envelopes.
        // -----------------------------------------------------------------
        const droneNowMs = Date.now();
        const inPostDuckWindow = droneMidi !== null
          && droneLastDuckMsRef.current > 0
          && (droneNowMs - droneLastDuckMsRef.current) < (DUCK_MS + 120);

        if (droneMidi !== null && topVotesIncludingDrone > 0 && topMidiIncludingDrone === droneMidi) {
          if (inPostDuckWindow) {
            // The duck already ran. If YIN STILL says drone-MIDI, the user
            // is genuinely playing in unison — accept the vote into the
            // standard candidate pool. Step 3's hysteresis still gates the
            // actual incumbent move.
            if (topVotesIncludingDrone > topVotes) {
              topVotes = topVotesIncludingDrone;
              topMidi = topMidiIncludingDrone;
            }
            // Keep the counter at threshold so subsequent post-duck frames
            // continue to admit the vote without re-firing the duck.
            droneSuspicionFramesRef.current = SUSPICION_THRESHOLD_FRAMES;
          } else {
            droneSuspicionFramesRef.current += 1;
            if (droneSuspicionFramesRef.current >= SUSPICION_THRESHOLD_FRAMES) {
              // Trip the duck. Rate-limit (one duck per DUCK_MS + 120 ms)
              // so back-to-back trips don't stack envelopes. The post-duck
              // window above will admit votes if YIN continues to insist.
              if (droneNowMs - droneLastDuckMsRef.current >= DUCK_MS + 120) {
                droneLastDuckMsRef.current = droneNowMs;
                const requestDuck = droneRequestDuckRef.current;
                if (requestDuck) {
                  try { requestDuck(DUCK_MS); } catch { /* ignore */ }
                }
              }
              // Hold the counter at threshold — don't reset to 0, since the
              // next frame's inPostDuckWindow branch will pick up the vote
              // confirmation flow.
              droneSuspicionFramesRef.current = SUSPICION_THRESHOLD_FRAMES;
            }
          }
        } else {
          droneSuspicionFramesRef.current = 0;
        }

        // Step 3: hysteresis.
        const incumbent = incumbentMidiRef.current;
        const incumbentVotes = incumbent !== null ? (voteCount.get(incumbent) ?? 0) : 0;
        if (topVotes === 0) {
          // No data — clear incumbent so the next note starts fresh.
          incumbentMidiRef.current = null;
        } else if (incumbent === null || incumbentVotes === 0) {
          // First detection or incumbent vanished — accept the top.
          incumbentMidiRef.current = topMidi;
        } else if (topMidi !== incumbent && topVotes >= incumbentVotes + NOTE_HYSTERESIS_MARGIN) {
          // Rival has a strict vote margin — switch.
          incumbentMidiRef.current = topMidi;
        }
        // else: incumbent retains the lock.

        // Step 4: median of incumbent's freqs within RESPONSE window.
        const winnerMidi = incumbentMidiRef.current;
        let displayFreq: number | null = null;
        if (winnerMidi !== null) {
          // v1.0.1 — reuse hoisted array ref; reset length instead of allocate.
          const winnerFreqs = winnerFreqsRef.current;
          winnerFreqs.length = 0;
          for (let i = 0; i < available; i++) {
            const idx = (head - 1 - i + DISPLAY_RING_SIZE) % DISPLAY_RING_SIZE;
            const f = displayFreqRing.current[idx];
            if (Number.isFinite(f)) {
              const midi = Math.round(12 * Math.log2(f / a4) + 69);
              if (midi === winnerMidi) winnerFreqs.push(f);
            }
          }
          if (winnerFreqs.length > 0) {
            // v1.4 — L1: correct even-length median (average two middles).
            // Also sorts a COPY so the ring-buffer source array is not mutated.
            const sorted = winnerFreqs.slice().sort(_compareAsc);
            const n = sorted.length;
            displayFreq = n % 2 === 1
              ? sorted[Math.floor(n / 2)]
              : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
          }
        }

        const avgRms = rmsN > 0 ? rmsSum / rmsN : -160;

        setFreqHz(displayFreq);
        setRmsDb(avgRms);
        setMeterFill(dbToMeterFill(avgRms, gainModeRef.current));

        // Publish incumbentMidi to React state only when it changes. Reading
        // the latest value here (not when we voted earlier) means the public
        // signal matches what the freqHz path showed this frame — the drone
        // and the visible note stay in lockstep with no extra hysteresis.
        const pubMidi = winnerMidi;
        if (pubMidi !== incumbentMidiPublishedRef.current) {
          incumbentMidiPublishedRef.current = pubMidi;
          setIncumbentMidi(pubMidi);
        }
      }

      // Active-bucket pump: read the COLLECT accumulator, compute stats,
      // diff against last emission to skip no-op setStates.
      const activeKey = activeBucketKeyRef.current;
      const activeAccum = activeKey !== null ? bucketAccumsRef.current.get(activeKey) ?? null : null;
      if (activeAccum) {
        const stats = computeBucketStats(activeAccum);
        // Cheap dirty check — sample count + last cents value is enough.
        const sig = `${stats.midiFing}:${stats.n}:${stats.last5[stats.last5.length - 1]?.toFixed(2) ?? ''}`;
        if (sig !== lastEmittedBucketSig.current) {
          lastEmittedBucketSig.current = sig;
          setActiveBucket(stats);
        }
      } else if (lastEmittedBucketSig.current !== '') {
        lastEmittedBucketSig.current = '';
        setActiveBucket(null);
      }

      rafHandle = requestAnimationFrame(tick);
    };

    rafHandle = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafHandle);
    };
  }, []);

  // v1.2 hotfix — memoise the returned engine object. Without this, audio-rate
  // state ticks (meterFill at ~40Hz, freqHz, rmsDb) each produce a brand-new
  // AudioEngineState reference, App.tsx's consumers see a new `engine` prop
  // every tick, and the WHOLE screen tree re-renders. After this wrap, the
  // memo's identity only changes when one of its dependencies changes — and
  // crucially, consumers (SetupScreen, MetroScreen, DeckScreen) that DON'T
  // read meterFill/freqHz/rmsDb will keep their child sub-objects (`metro`,
  // `deck`) referentially stable across audio ticks. AudioEngine-direct
  // consumers (the tuner) still re-render at audio rate — that's by design.
  // Every setter listed below is useCallback-wrapped at definition time so
  // its identity is stable; including it in deps satisfies exhaustive-deps
  // without causing extra re-memos.
  return useMemo<AudioEngineState>(() => ({
    status,
    freqHz,
    rmsDb,
    meterFill,
    gainMode,
    setGainMode,
    yinCallCount,
    rawFreqHz,
    filterMode,
    setFilterMode,
    instrumentKey,
    setInstrumentKey,
    displayMode,
    setDisplayMode,
    micSilenced,
    allowOutOfRange,
    setAllowOutOfRange,
    prefsLoaded,
    nickname,
    setNickname,
    savePrefsNow,
    hiFiMode,
    setHiFiMode,
    hiFiActive,
    audioSourceLabel,
    streamErrorReason,
    retryPermission,
    retryStream,
    peakLock,
    setPeakLock,
    lowCutDb,
    setLowCutDb,
    activeBucket,
    clearActiveBucket,
    logCurrentReading,
    undoLastLog,
    sessionActive,
    sessionStartedAtMs,
    setSessionActive,
    droppedFrameCount,
    lastDropReason,
    theme,
    setTheme,
    nightDarken,
    setNightDarken,
    nightWarmth,
    setNightWarmth,
    incumbentMidi,
    tunerStyle,
    setTunerStyle,
    metroStyle,
    setMetroStyle,
    deckStyle,
    setDeckStyle,
    metroClickOffsetMs,
    setMetroClickOffsetMs,
    metroOutputRoute,
    setMetroOutputRoute,
    a4Hz,
    setA4Hz,
    setDroneCurrentMidi,
    installDroneDuckHandler,
  }), [
    status,
    freqHz,
    rmsDb,
    meterFill,
    gainMode,
    yinCallCount,
    rawFreqHz,
    filterMode,
    instrumentKey,
    displayMode,
    micSilenced,
    allowOutOfRange,
    prefsLoaded,
    nickname,
    hiFiMode,
    hiFiActive,
    audioSourceLabel,
    streamErrorReason,
    peakLock,
    lowCutDb,
    activeBucket,
    sessionActive,
    sessionStartedAtMs,
    droppedFrameCount,
    lastDropReason,
    theme,
    nightDarken,
    nightWarmth,
    incumbentMidi,
    tunerStyle,
    metroStyle,
    deckStyle,
    metroClickOffsetMs,
    metroOutputRoute,
    a4Hz,
    setGainMode,
    setFilterMode,
    setInstrumentKey,
    setDisplayMode,
    setAllowOutOfRange,
    setNickname,
    savePrefsNow,
    setHiFiMode,
    retryPermission,
    retryStream,
    setPeakLock,
    setLowCutDb,
    clearActiveBucket,
    logCurrentReading,
    undoLastLog,
    setSessionActive,
    setTheme,
    setNightDarken,
    setNightWarmth,
    setTunerStyle,
    setMetroStyle,
    setDeckStyle,
    setMetroClickOffsetMs,
    setMetroOutputRoute,
    setDroneCurrentMidi,
    installDroneDuckHandler,
  ]);
}
