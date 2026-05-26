import { useCallback, useEffect, useRef, useState } from 'react';
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

// Note: the engine stores instrumentKey + displayMode as state but does not
// perform the transposition itself. App.tsx looks up transpMap from
// ./instruments at display time and applies the conversion.

// ---------------------------------------------------------------------------
// Window size decision — Option A: 4096 samples (see v0.2.2 comment block).
// ---------------------------------------------------------------------------

const STREAM_OPTIONS = {
  sampleRate: 44100,
  channels: 1,
  encoding: 'float32' as const,
} satisfies { sampleRate: number; channels: number; encoding: 'float32' | 'int16' };

// v0.2.2 — see full rationale in the original comment block; preserved here
// for history. Window = 4096 samples, YIN runs every incoming buffer.
const RING_BUFFER_CAPACITY = 4096;
const BUFFERS_PER_YIN_CALL = 1;

// Gain-mode display mapping:  rmsDb → meterFill [0, 1]
const GAIN_DISPLAY_MAP = {
  low: { floor: -60, ceil: 0 },
  high: { floor: -60, ceil: -20 },
} as const;

// PCM-zero AA detection: consecutive all-silent-buffer threshold.
// At the ~100 ms cadence of expo-audio this is ≈ 800 ms of pure-zero PCM.
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
  // v0.3.0 instrument selection — engine stores key + displayMode;
  // App.tsx applies transposition lookup via instruments.ts.
  instrumentKey: string;
  setInstrumentKey: (k: string) => void;
  displayMode: DisplayMode;
  setDisplayMode: (m: DisplayMode) => void;
  // v0.3.0 PCM-zero AA detection
  micSilenced: boolean;
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

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAudioEngine(): AudioEngineState {
  const [status, setStatus] = useState<EngineStatus>('waiting-for-mic');
  const [freqHz, setFreqHz] = useState<number | null>(null);
  const [rmsDb, setRmsDb] = useState<number>(-160);
  const [meterFill, setMeterFill] = useState<number>(0);
  const [gainMode, setGainModeState] = useState<GainMode>('low');
  // v0.2.1 diagnostics
  const [yinCallCount, setYinCallCount] = useState<number>(0);
  const [rawFreqHz, setRawFreqHz] = useState<number | null>(null);
  // v0.3.0 filter mode
  const [filterMode, setFilterModeState] = useState<FilterMode>('normal');
  // v0.3.0 instrument selection
  const [instrumentKey, setInstrumentKeyState] = useState<string>('bb_tenor');
  const [displayMode, setDisplayModeState] = useState<DisplayMode>('griff');
  // v0.3.0 PCM-zero AA detection
  const [micSilenced, setMicSilenced] = useState<boolean>(false);

  // Stable setters.
  const setGainMode = useCallback((m: GainMode) => setGainModeState(m), []);
  const setFilterMode = useCallback((m: FilterMode) => {
    setFilterModeState(m);
    // Reset filter state immediately so the new preset takes effect cleanly.
    if (filterStateRef.current) {
      resetFilterState(filterStateRef.current);
    }
  // filterStateRef is a stable ref — safe to include as non-reactive dep.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setInstrumentKey = useCallback((k: string) => setInstrumentKeyState(k), []);
  const setDisplayMode = useCallback((m: DisplayMode) => setDisplayModeState(m), []);

  // Refs that onBuffer reads without recreating the callback.
  const gainModeRef = useRef<GainMode>('low');
  gainModeRef.current = gainMode;

  const freqHzRef = useRef<number | null>(null);
  freqHzRef.current = freqHz;

  // Active filter mode ref — onBuffer reads this without a stale closure.
  const filterModeRef = useRef<FilterMode>('normal');
  filterModeRef.current = filterMode;

  // Reentry guard.
  const stopping = useRef(false);

  // Ring buffer — allocated once per stream start.
  const ring = useRef<Float32Array | null>(null);
  const ringFilled = useRef(0);
  const bufferCount = useRef(0);
  const analysisBlock = useRef<Float32Array | null>(null);

  // Filter state — allocated on stream start, reset on mode change.
  const filterStateRef = useRef<FilterState | null>(null);

  // Last accepted stable pitch for octave-jump guard.
  const lastStablePitch = useRef<number | null>(null);

  // PCM-zero AA detection counter.
  const silentBufferCount = useRef(0);

  // -------------------------------------------------------------------------
  // Step 1: request mic permission on mount
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
    return () => {
      cancelled = true;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Step 2: open stream once permission is granted
  // -------------------------------------------------------------------------
  const { stream, isStreaming } = useAudioStream(STREAM_OPTIONS);

  useEffect(() => {
    if (status === 'mic-denied' || status === 'waiting-for-mic') return;
    setStatus(isStreaming ? 'listening' : 'warming-up');
  }, [isStreaming, status]);

  // -------------------------------------------------------------------------
  // onBuffer — wired to the stream's event emitter so it always reads
  // current refs without needing to recreate the stream.
  // -------------------------------------------------------------------------
  const onBuffer = useCallback((buffer: AudioStreamBuffer) => {
    if (stopping.current) return;

    const incoming = new Float32Array(buffer.data);
    const n = incoming.length;
    if (n === 0) return;

    // --- PCM-zero AA detection (v0.3.0) ---
    // O(N) scan over the incoming buffer. N ≈ 4410 at 100 ms cadence — cheap.
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

    // --- RMS computation over the latest incoming slice ---
    const db = computeRmsDb(incoming);
    const fill = dbToMeterFill(db, gainModeRef.current);

    // --- Pitch detection (every BUFFERS_PER_YIN_CALL buffers) ---
    let nextFreq: number | null = freqHzRef.current;
    let nextRaw: number | null = null;
    let yinFired = false;

    if (bufferCount.current >= BUFFERS_PER_YIN_CALL && ringFilled.current >= RING_BUFFER_CAPACITY) {
      bufferCount.current = 0;
      yinFired = true;

      const mode = filterModeRef.current;
      const preset = FILTER_PRESETS[mode];

      // Linear RMS gate — using the same mean-square computed for dB display
      // but compared directly against preset.rmsFloorLinear (linear, not dBFS).
      // Computing sqrt(meanSquare) inline is cheaper than converting RMS_FLOOR_DB
      // back to linear for the comparison.
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
            // Pass the mode-tuned YIN threshold from the active preset.
            return yinPitch(analysisBlock.current!, buffer.sampleRate, preset.yinThreshold);
          } catch {
            return null;
          }
        })();

        if (result !== null && result.freqHz > 0) {
          nextRaw = result.freqHz;
          let candidate = result.freqHz;

          // Octave-jump guard: integrity check, not smoothing.
          // Discard frames where the candidate is closer to ½× or 2× the
          // last stable pitch than to the pitch itself.
          if (lastStablePitch.current !== null) {
            const prev = lastStablePitch.current;
            const distSelf = Math.abs(candidate - prev);
            const distHalf = Math.abs(candidate - prev / 2);
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
          // Octave ghost — pass null to filter so it can update state.
        }
      }

      // Route through filter state machine (confirm, edge-hops, median).
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

    // Allocate a fresh filter state for this stream session.
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
  };
}
