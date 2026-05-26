import { useCallback, useEffect, useRef, useState } from 'react';
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
import { transpMap } from './instruments';
import { loadPrefs, savePrefs } from './storage/prefs';
import type { AppPrefs } from './storage/prefs';
import {
  initMeasurementsDb,
  startRun,
  insertMeasurement,
} from './storage/measurements';

// ---------------------------------------------------------------------------
// save-on-background: refHz lives in App.tsx as useState (Frodo's territory).
// The engine exposes savePrefsNow(extra?) so App.tsx can pass { refHz } when
// it handles AppState changes, or call it on demand (e.g. on picker close).
// The engine's own AppState listener fires as a backstop and writes refHz
// from its internal a4HzRef (same value in practice — a4Hz === refHz while
// App.tsx keeps them in sync). This avoids a second AppState listener in
// App.tsx for the common case while still letting Frodo override if needed.
// ---------------------------------------------------------------------------

const STREAM_OPTIONS = {
  sampleRate: 44100,
  channels: 1,
  encoding: 'float32' as const,
} satisfies { sampleRate: number; channels: number; encoding: 'float32' | 'int16' };

const RING_BUFFER_CAPACITY = 4096;
const BUFFERS_PER_YIN_CALL = 1;

const GAIN_DISPLAY_MAP = {
  low:  { floor: -60, ceil:   0 },
  high: { floor: -60, ceil: -20 },
} as const;

const SILENT_BUFFER_THRESHOLD = 8;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type GainMode = 'low' | 'high';
export type EngineStatus = 'waiting-for-mic' | 'mic-denied' | 'warming-up' | 'listening';
export type { FilterMode };
export type DisplayMode = 'griff' | 'klingend';

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
  // a4Hz is not yet lifted into the engine (Frodo owns refHz in App.tsx).
  // We track it only in a ref so onBuffer can use it for MIDI conversion and
  // savePrefsNow can write a consistent blob. Initialized to 440; prefs
  // hydration updates it via the ref.
  const a4HzRef = useRef<number>(440);

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
      ...extra,
    };
    await savePrefs(prefs);
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
        a4HzRef.current = prefs.a4Hz;
        setPrefsLoaded(true);

        // Init DB and open first run after prefs are known.
        try {
          await initMeasurementsDb();
          if (!cancelled) {
            const id = await startRun({
              instrument: prefs.instrumentKey,
              a4Hz:       prefs.a4Hz,
              nickname:   prefs.nickname,
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
    (async () => {
      try {
        const id = await startRun({
          instrument: instrumentKey,
          a4Hz:       a4HzRef.current,
          nickname:   nicknameRef.current,
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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await AudioModule.requestRecordingPermissionsAsync();
        if (cancelled) return;
        if (res.granted) {
          setStatus('warming-up');
        } else {
          setStatus('mic-denied');
        }
      } catch {
        if (!cancelled) setStatus('mic-denied');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // -------------------------------------------------------------------------
  // Step 3: open stream once permission is granted
  // -------------------------------------------------------------------------
  const { stream, isStreaming } = useAudioStream(STREAM_OPTIONS);

  useEffect(() => {
    if (status === 'mic-denied' || status === 'waiting-for-mic') return;
    setStatus(isStreaming ? 'listening' : 'warming-up');
  }, [isStreaming, status]);

  // -------------------------------------------------------------------------
  // onBuffer
  // -------------------------------------------------------------------------
  const onBuffer = useCallback((buffer: AudioStreamBuffer) => {
    if (stopping.current) return;

    const incoming = new Float32Array(buffer.data);
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
      r.copyWithin(0, srcStart, ringFilled.current);
      r.set(incoming, keep);
      ringFilled.current = RING_BUFFER_CAPACITY;
    }

    bufferCount.current += 1;

    // --- RMS ---
    const db = computeRmsDb(incoming);
    const fill = dbToMeterFill(db, gainModeRef.current);

    // --- Pitch detection ---
    let nextFreq: number | null = freqHzRef.current;
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

      if (rmsLinear >= preset.rmsFloorLinear) {
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
      );
      nextFreq = processed;

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
        }).catch(() => {});
      }
    }

    setRmsDb(db);
    setMeterFill(fill);
    setFreqHz(nextFreq);
    if (yinFired) {
      setYinCallCount((c) => (c + 1) % 1000);
      setRawFreqHz(nextRaw);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire onBuffer to the stream event emitter.
  useEffect(() => {
    if (status === 'waiting-for-mic' || status === 'mic-denied') return;

    stopping.current = false;

    ring.current = new Float32Array(RING_BUFFER_CAPACITY);
    analysisBlock.current = new Float32Array(RING_BUFFER_CAPACITY);
    ringFilled.current = 0;
    bufferCount.current = 0;
    lastStablePitch.current = null;
    silentBufferCount.current = 0;

    filterStateRef.current = newFilterState();

    stream.start().catch((err) => {
      console.warn('useAudioEngine: stream.start() failed', err);
      setStatus('mic-denied');
    });

    const sub = stream.addListener('audioStreamBuffer', onBuffer);

    return () => {
      stopping.current = true;
      sub.remove();
      try {
        stream.stop();
      } catch {
        // stop() is synchronous void — errors are non-fatal.
      }
      ring.current = null;
      analysisBlock.current = null;
      filterStateRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.id, status === 'waiting-for-mic' || status === 'mic-denied']);

  return {
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
  };
}
