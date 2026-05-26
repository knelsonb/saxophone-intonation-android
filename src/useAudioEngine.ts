import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioModule, useAudioStream } from 'expo-audio';
import type { AudioStreamBuffer } from 'expo-audio';

import { yinPitch } from './yin';

// ---------------------------------------------------------------------------
// Window size decision — Option A: 16384 samples (4 × ~4100-sample buffers).
//
// Saxophone lowest practical pitch is ~103 Hz (Ab2, tenor sax). Three periods
// at 103 Hz require ~1283 samples at 44100 Hz; five periods need ~2140. YIN
// needs at least half the window to be lag-search space, so a 4096-sample
// window is marginal. 16384 samples gives ~375 ms of audio and roughly
// 38 periods of 103 Hz — well above the minimum — while still running
// comfortably inside the Pixel 9 Pro JS budget (<20 ms measured for YIN at
// this window size). The 400 ms hop latency is acceptable for a tuner whose
// primary use is sustained notes.
// ---------------------------------------------------------------------------

// Module-level constant so useReleasingSharedObject inside useAudioStream
// sees the same object identity every render and does not recreate the stream.
const STREAM_OPTIONS = {
  sampleRate: 44100,
  channels: 1,
  encoding: 'float32' as const,
} satisfies { sampleRate: number; channels: number; encoding: 'float32' | 'int16' };

// The number of incoming ~4100-sample buffers to accumulate before running YIN.
// Four buffers × 4410 samples/buffer = 16384-sample analysis window.
const RING_BUFFER_CAPACITY = 16384;
// v0.2.1: dropped from 4 to 2.  The 16k-sample analysis window still gives YIN
// a full ~370 ms of audio (we don't drop ring capacity), but YIN now runs every
// other buffer arrival (~200 ms cadence) instead of every fourth (~400 ms).
// Halves perceived latency without changing the per-call cost.
const BUFFERS_PER_YIN_CALL = 2;

// RMS floor below which pitch detection is skipped (dBFS).
// v0.2.1: loosened from -50 to -55 — Tom's first feedback was that the meter
// moves but the note stays stuck.  A -50 floor was too aggressive given that
// the meter spans -60..0 dBFS in Low gain mode.
const RMS_FLOOR_DB = -55;

// Gain-mode display mapping:  rmsDb → meterFill [0, 1]
// low:  -60 dBFS maps to 0, 0 dBFS maps to 1
// high: -60 dBFS maps to 0, -20 dBFS maps to 1
const GAIN_DISPLAY_MAP = {
  low: { floor: -60, ceil: 0 },
  high: { floor: -60, ceil: -20 },
} as const;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type GainMode = 'low' | 'high';
export type EngineStatus = 'waiting-for-mic' | 'mic-denied' | 'warming-up' | 'listening';

export interface AudioEngineState {
  status: EngineStatus;
  freqHz: number | null;
  rmsDb: number;
  meterFill: number;
  gainMode: GainMode;
  setGainMode: (m: GainMode) => void;
  // v0.2.1 diagnostics — surfaced so the UI can show that the engine is
  // actually running even when nothing is happening in the centerpiece
  // readout.  Cheap to compute and read; remove if perf ever needs it.
  yinCallCount: number;
  rawFreqHz: number | null;
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
  // Guard against log(0): clamp to an effective -160 dB floor.
  const db = meanSquare > 0 ? 10 * Math.log10(meanSquare) : -160;
  return Math.max(-160, Math.min(0, db));
}

function dbToMeterFill(db: number, mode: GainMode): number {
  const { floor, ceil } = GAIN_DISPLAY_MAP[mode];
  const norm = (db - floor) / (ceil - floor);
  return Math.max(0, Math.min(1, norm));
}

// 3-frame median filter over pitch values.  Returns the median of the
// three most-recent non-null results (or null if fewer than 3 exist).
// chunk-2 minimum — chunk 3 will replace this with configurable filter modes.
function medianOf3(a: number, b: number, c: number): number {
  // Sort-free median: compare pairs.
  if ((a <= b && b <= c) || (c <= b && b <= a)) return b;
  if ((b <= a && a <= c) || (c <= a && a <= b)) return a;
  return c;
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
  // Diagnostic state (v0.2.1).
  const [yinCallCount, setYinCallCount] = useState<number>(0);
  const [rawFreqHz, setRawFreqHz] = useState<number | null>(null);

  // Stable setter exposed to callers.
  const setGainMode = useCallback((m: GainMode) => setGainModeState(m), []);

  // Refs that onBuffer reads without needing the callback to be re-created.
  // gainMode and freqHz are both kept here so the callback closure is stable
  // across render cycles (re-creating it would tear down and re-add the
  // stream listener every render, causing missed buffers and GC pressure).
  const gainModeRef = useRef<GainMode>('low');
  gainModeRef.current = gainMode;

  // freqHz ref: updated atomically with state so onBuffer can read
  // the latest committed pitch value without stale-closure issues.
  const freqHzRef = useRef<number | null>(null);
  // Keep ref in sync every render.
  freqHzRef.current = freqHz;

  // Reentry guard: prevents double-stop / start-during-stop races.
  const stopping = useRef(false);

  // Ring buffer — allocated once per stream start, released on cleanup.
  // Holds the last RING_BUFFER_CAPACITY samples in arrival order (no circular
  // wraparound needed: we shift-and-append each incoming buffer slice).
  const ring = useRef<Float32Array | null>(null);
  // How many samples have been written since the ring was last reset.
  const ringFilled = useRef(0);
  // Counts how many onBuffer calls have been accumulated toward the next YIN run.
  const bufferCount = useRef(0);
  // Pre-allocated analysis block: reused every YIN call to avoid per-call GC.
  const analysisBlock = useRef<Float32Array | null>(null);

  // 3-frame pitch history for median filter.
  const pitchHistory = useRef<[number, number, number]>([0, 0, 0]);
  const pitchHistoryLen = useRef(0);
  // Last accepted stable pitch (for octave-jump detection).
  const lastStablePitch = useRef<number | null>(null);

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

  // onBuffer is passed to useAudioStream via STREAM_OPTIONS — but the hook
  // accepts onBuffer as part of the options object, and the options object is
  // module-level (no onBuffer field there).  We subscribe to buffer events
  // through the stream listener approach inside the useEffect below.
  // Because STREAM_OPTIONS has no onBuffer, the stream opens without a static
  // callback and we wire up dynamically so the handler can read the latest
  // ref values without recreating the stream.
  const { stream, isStreaming } = useAudioStream(STREAM_OPTIONS);

  // Reflect isStreaming in status (only once we have permission).
  useEffect(() => {
    if (status === 'mic-denied' || status === 'waiting-for-mic') return;
    setStatus(isStreaming ? 'listening' : 'warming-up');
  }, [isStreaming, status]);

  // -------------------------------------------------------------------------
  // onBuffer — wired to the stream's event emitter so it always reads
  // current refs without needing to recreate the stream.
  // -------------------------------------------------------------------------
  const onBuffer = useCallback((buffer: AudioStreamBuffer) => {
    // Guard: ignore stale callbacks that arrive after unmount.
    if (stopping.current) return;

    // Decode the ArrayBuffer into float32 samples.
    const incoming = new Float32Array(buffer.data);
    const n = incoming.length;
    if (n === 0) return;

    // --- Ring buffer management ---
    // Ensure ring and block are allocated (lazy on first buffer; should
    // already be allocated from the start-stream effect but guard here).
    if (!ring.current) {
      ring.current = new Float32Array(RING_BUFFER_CAPACITY);
      analysisBlock.current = new Float32Array(RING_BUFFER_CAPACITY);
      ringFilled.current = 0;
    }

    const r = ring.current;

    if (n >= RING_BUFFER_CAPACITY) {
      // Incoming buffer larger than ring (shouldn't happen at 44100 Hz / ~100ms
      // but defend against it): keep the last RING_BUFFER_CAPACITY samples.
      r.set(incoming.subarray(n - RING_BUFFER_CAPACITY));
      ringFilled.current = RING_BUFFER_CAPACITY;
    } else if (ringFilled.current + n <= RING_BUFFER_CAPACITY) {
      // Ring has room: append directly.
      r.set(incoming, ringFilled.current);
      ringFilled.current += n;
    } else {
      // Shift oldest samples left to make room, then append.
      // This branch is reached only when ringFilled + n > RING_BUFFER_CAPACITY,
      // so ringFilled > keep = RING_BUFFER_CAPACITY - n (srcStart is always > 0).
      // We retain the last `keep` samples of the valid region:
      //   r[srcStart..ringFilled] → r[0..keep]
      // then place the new `n` samples at r[keep..RING_BUFFER_CAPACITY].
      const keep = RING_BUFFER_CAPACITY - n;
      const srcStart = ringFilled.current - keep; // > 0 by the branch invariant
      r.copyWithin(0, srcStart, ringFilled.current);
      r.set(incoming, keep);
      ringFilled.current = RING_BUFFER_CAPACITY;
    }

    bufferCount.current += 1;

    // --- RMS computation over the latest incoming slice ---
    const db = computeRmsDb(incoming);
    const fill = dbToMeterFill(db, gainModeRef.current);

    // --- Pitch detection (every BUFFERS_PER_YIN_CALL buffers) ---
    // Read from ref to avoid stale closure — freqHzRef.current is kept in
    // sync with state on every render.
    let nextFreq: number | null = freqHzRef.current; // default: carry previous value

    let nextRaw: number | null = null;
    let yinFired = false;

    if (bufferCount.current >= BUFFERS_PER_YIN_CALL && ringFilled.current >= RING_BUFFER_CAPACITY) {
      bufferCount.current = 0;
      yinFired = true;

      if (db < RMS_FLOOR_DB) {
        // Below noise floor — suppress pitch output.
        nextFreq = null;
        pitchHistoryLen.current = 0;
        lastStablePitch.current = null;
      } else {
        // Copy ring to analysis block (oldest-sample-first, ring is already
        // in arrival order because we shift-and-append).
        analysisBlock.current!.set(r);

        const result = (() => {
          try {
            return yinPitch(analysisBlock.current!, buffer.sampleRate);
          } catch {
            return null;
          }
        })();

        if (result === null || result.freqHz <= 0) {
          nextFreq = null;
          pitchHistoryLen.current = 0;
          lastStablePitch.current = null;
        } else {
          nextRaw = result.freqHz;
          let candidate = result.freqHz;

          // Octave-jump guard: if candidate is closer to ½× or 2× the last
          // stable pitch than to itself, discard this frame.
          if (lastStablePitch.current !== null) {
            const prev = lastStablePitch.current;
            const distSelf = Math.abs(candidate - prev);
            const distHalf = Math.abs(candidate - prev / 2);
            const distDouble = Math.abs(candidate - prev * 2);
            if (
              (distHalf < distSelf || distDouble < distSelf) &&
              Math.min(distHalf, distDouble) < distSelf * 0.5
            ) {
              // Likely octave ghost — skip this frame.
              candidate = -1;
            }
          }

          if (candidate > 0) {
            // Push into 3-frame history.
            pitchHistory.current[0] = pitchHistory.current[1];
            pitchHistory.current[1] = pitchHistory.current[2];
            pitchHistory.current[2] = candidate;
            if (pitchHistoryLen.current < 3) pitchHistoryLen.current += 1;

            if (pitchHistoryLen.current === 3) {
              // Full history — emit the median for stable readout.
              const [a, b, c] = pitchHistory.current;
              const med = medianOf3(a, b, c);
              lastStablePitch.current = med;
              nextFreq = med;
            } else {
              // v0.2.1: emit the raw candidate immediately rather than waiting
              // for 3 frames of history.  The old behavior left the display
              // stuck at `—` for the first 600 ms after pitch detection began
              // (and reset to `—` whenever history was cleared by a frame
              // below the noise floor), which made the app look broken.
              // Median smoothing still kicks in once 3 frames accumulate.
              lastStablePitch.current = candidate;
              nextFreq = candidate;
            }
          }
          // else: discarded by octave guard — carry previous output.
        }
      }
    }

    // Batch all state updates in a single call per onBuffer tick.
    // React 18 batches setState calls in event handlers and async callbacks;
    // in React Native / React 17 we rely on the fact that these three calls
    // happen synchronously in one JS task, so only one re-render is scheduled.
    setRmsDb(db);
    setMeterFill(fill);
    setFreqHz(nextFreq);
    if (yinFired) {
      setYinCallCount((n) => (n + 1) % 1000);
      setRawFreqHz(nextRaw);
    }
  // Empty deps: all mutable values are read through refs (gainModeRef,
  // freqHzRef, ring, analysisBlock, etc.) so the callback is stable for
  // the lifetime of the component.  Re-creating it would tear down and
  // re-add the stream listener every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire onBuffer to the stream event emitter.  Re-wires whenever stream.id
  // changes (which only happens if STREAM_OPTIONS primitives change — they
  // don't, because STREAM_OPTIONS is module-level).
  useEffect(() => {
    if (status === 'waiting-for-mic' || status === 'mic-denied') return;

    stopping.current = false;

    // Allocate ring buffer and analysis block on stream open.
    ring.current = new Float32Array(RING_BUFFER_CAPACITY);
    analysisBlock.current = new Float32Array(RING_BUFFER_CAPACITY);
    ringFilled.current = 0;
    bufferCount.current = 0;
    pitchHistoryLen.current = 0;
    lastStablePitch.current = null;

    // Start the stream.
    stream.start().catch((err) => {
      console.warn('useAudioEngine: stream.start() failed', err);
      setStatus('mic-denied');
    });

    // Subscribe to buffer events using the stream's event emitter.
    // AudioStream extends SharedObject<AudioStreamEvents>; expo-modules-core
    // SharedObject exposes addListener.
    const sub = stream.addListener('audioStreamBuffer', onBuffer);

    return () => {
      stopping.current = true;
      sub.remove();
      try {
        stream.stop();
      } catch {
        // stop() is synchronous void — errors are non-fatal.
      }
      // Release ring buffer memory.
      ring.current = null;
      analysisBlock.current = null;
    };
  // onBuffer is stable (empty useCallback dep array — reads all mutable
  // values through refs).  stream.id changes only when STREAM_OPTIONS
  // primitives change (they don't — module-level constant).  The boolean
  // expression fires the effect exactly once: when status first leaves the
  // pre-permission states.
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
  };
}
