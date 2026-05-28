/**
 * forensicRing — #64 Phase-1 fixed-size, overwrite-oldest forensic ring.
 *
 * Frodo-LOTC's spec, absorbed into the bus (see #64 changeset §1.4): ONE
 * preallocated ~64-entry ring, zero growth (no 2-hour leak), JS-side only
 * (never on the audio thread). Two record types, never flattened — each
 * carries a `type` tag:
 *
 *   - LATENCY_COMMIT (sparse, ≤1 Hz, event-driven): the #167 output-latency
 *     compensation commits. `prevMs` + `trigger` capture CAUSATION, not just the
 *     symptom — you can see WHY the held latency moved.
 *   - BEAT_OFFSET (per downbeat, only while the shadow probe is armed): the
 *     sub-ms-sync achievability-floor record straight off the native
 *     `shadowBeat` event.
 *
 * Dump is newest-first, both types interleaved in time order, on demand (a
 * logcat command or a debug tap) — never on a timer.
 *
 * Pure module (no React, no native imports) so the Node test runner can
 * exercise the overwrite-oldest + newest-first contracts directly.
 */

/** The #167 latency compensation committed to a new held value. */
export interface LatencyCommitRecord {
  type: 'LATENCY_COMMIT';
  /** Date.now() at commit. */
  ts: number;
  /** Output route in effect (speaker/wired/bluetooth). */
  route: string;
  /** Raw measured write→hear latency (ms) that triggered the commit. */
  rawMs: number;
  /** New held compensation value (ms). */
  heldMs: number;
  /** Previous held value (ms) — together with `trigger`, the causation. */
  prevMs: number;
  /** What caused the commit. */
  trigger: 'mount' | 'route' | 'recovery' | 'watchdog' | 'force';
}

/** One per-downbeat sub-ms-sync shadow measurement (native `shadowBeat`). */
export interface BeatOffsetRecord {
  type: 'BEAT_OFFSET';
  /** Date.now() when the record was ringed. */
  ts: number;
  /** Output route in effect. */
  route: string;
  /** Projected HEARD time of the downbeat (CLOCK_MONOTONIC ns) — ground truth. */
  beatHeardNanos: number;
  /** Untrimmed cumulative-K drift residual (ns): slope = DAC drift, detrended noise = floor. */
  rawSkewNs: number;
  /** §2.1 per-downbeat trimmed residual (ns) — the as-designed control law's floor. */
  residualNs: number;
  /** 60e9 / bpm. */
  periodNanos: number;
  /** The scheduled beat frame (g_frame_position space). */
  atFrame: number;
  /** Anchor discontinuity generation at this beat. */
  gen: number;
  /** Vsyncs observed since the previous beat. */
  vsyncFrames: number;
  /** Of those, intervals >10 ms — an ARR-demotion (panel left 120 Hz) tell. */
  vsyncSlow: number;
  /** true = re-anchor beat (first / post-discontinuity) — exclude from the steady floor. */
  reset: boolean;
}

export type ForensicRecord = LatencyCommitRecord | BeatOffsetRecord;

export interface ForensicRing {
  /** Append a record, overwriting the oldest once full. O(1), no growth. */
  push(rec: ForensicRecord): void;
  /** Newest-first snapshot of the live records (≤ capacity). */
  dump(): ForensicRecord[];
  /** Live record count (≤ capacity). */
  readonly size: number;
  /** Total records ever pushed (so a dump can report how many were overwritten). */
  readonly total: number;
  /** Drop all records (size + total reset). */
  clear(): void;
}

export const DEFAULT_FORENSIC_CAPACITY = 64;

/**
 * Create a fixed-capacity forensic ring. `capacity` is clamped to ≥ 1.
 */
export function createForensicRing(capacity: number = DEFAULT_FORENSIC_CAPACITY): ForensicRing {
  const cap = Math.max(1, Math.floor(capacity));
  const buf: (ForensicRecord | undefined)[] = new Array(cap);
  let head = 0; // index of the NEXT write slot
  let size = 0; // live entries, ≤ cap
  let total = 0; // ever pushed

  return {
    push(rec: ForensicRecord): void {
      buf[head] = rec;
      head = (head + 1) % cap;
      if (size < cap) size++;
      total++;
    },
    dump(): ForensicRecord[] {
      const out: ForensicRecord[] = [];
      // Walk backward from the most-recent write for `size` entries.
      for (let i = 1; i <= size; i++) {
        const idx = (head - i + cap) % cap;
        const r = buf[idx];
        if (r !== undefined) out.push(r);
      }
      return out;
    },
    get size(): number {
      return size;
    },
    get total(): number {
      return total;
    },
    clear(): void {
      for (let i = 0; i < cap; i++) buf[i] = undefined;
      head = 0;
      size = 0;
      total = 0;
    },
  };
}
