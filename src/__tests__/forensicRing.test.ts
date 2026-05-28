/**
 * Smoke tests for src/forensicRing.ts (#64 Phase-1).
 *
 * Run with Node 24 (no test runner required):
 *   node --experimental-strip-types src/__tests__/forensicRing.test.ts
 *
 * Each assertion calls process.exit(1) on failure so CI can catch regressions.
 *
 * The ring is the on-device gate's data sink, so its contracts are load-bearing:
 * overwrite-oldest (no growth = no 2h leak), newest-first dump, and lossless
 * record-type tagging (LATENCY_COMMIT vs BEAT_OFFSET never flattened).
 */

// @ts-ignore: smoke — .ts extension required for node --experimental-strip-types
import {
  createForensicRing,
  DEFAULT_FORENSIC_CAPACITY,
} from '../forensicRing.ts';
import type { BeatOffsetRecord, LatencyCommitRecord } from '../forensicRing.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`PASS: ${message}`);
}

function latency(prevMs: number): LatencyCommitRecord {
  return {
    type: 'LATENCY_COMMIT',
    ts: 1000 + prevMs,
    route: 'speaker',
    rawMs: 85,
    heldMs: 85,
    prevMs,
    trigger: 'watchdog',
  };
}

function beat(residualNs: number): BeatOffsetRecord {
  return {
    type: 'BEAT_OFFSET',
    ts: 2000 + residualNs,
    route: 'speaker',
    beatHeardNanos: 1e14 + residualNs,
    rawSkewNs: residualNs * 2,
    residualNs,
    periodNanos: 5e8,
    atFrame: 48000 + residualNs,
    gen: 0,
    vsyncFrames: 60,
    vsyncSlow: 0,
    reset: false,
  };
}

const residuals = (recs: ReadonlyArray<{ residualNs?: number }>): number[] =>
  recs.map((r) => r.residualNs as number);

// ---------------------------------------------------------------------------
// Test 1 — under capacity: newest-first, size + total track pushes.
// ---------------------------------------------------------------------------
{
  const ring = createForensicRing(8);
  ring.push(beat(1));
  ring.push(beat(2));
  ring.push(beat(3));
  const dump = ring.dump();
  assert(
    JSON.stringify(residuals(dump as BeatOffsetRecord[])) === JSON.stringify([3, 2, 1]),
    'under-capacity: dump is newest-first',
  );
  assert(ring.size === 3, 'under-capacity: size === 3');
  assert(ring.total === 3, 'under-capacity: total === 3');
}

// ---------------------------------------------------------------------------
// Test 2 — overflow: keeps the most recent `capacity`, oldest overwritten.
// ---------------------------------------------------------------------------
{
  const ring = createForensicRing(3);
  for (let i = 1; i <= 5; i++) ring.push(beat(i)); // 4,5 overwrite 1,2
  const dump = ring.dump();
  assert(
    JSON.stringify(residuals(dump as BeatOffsetRecord[])) === JSON.stringify([5, 4, 3]),
    'overflow: newest-first, oldest two overwritten',
  );
  assert(ring.size === 3, 'overflow: size capped at capacity');
  assert(ring.total === 5, 'overflow: total counts every push');
}

// ---------------------------------------------------------------------------
// Test 3 — long run does not grow (no 2h leak).
// ---------------------------------------------------------------------------
{
  const ring = createForensicRing(64);
  for (let i = 0; i < 100_000; i++) ring.push(beat(i));
  assert(ring.size === 64, 'long-run: size stays at capacity');
  assert(ring.dump().length === 64, 'long-run: dump length === capacity');
  assert(ring.total === 100_000, 'long-run: total counts all pushes');
  assert(
    (ring.dump()[0] as BeatOffsetRecord).residualNs === 99_999,
    'long-run: newest is the last pushed',
  );
}

// ---------------------------------------------------------------------------
// Test 4 — both record types preserved with tags, interleaved in time order.
// ---------------------------------------------------------------------------
{
  const ring = createForensicRing(8);
  ring.push(latency(0));
  ring.push(beat(10));
  ring.push(latency(85));
  const dump = ring.dump();
  assert(
    JSON.stringify(dump.map((r) => r.type)) ===
      JSON.stringify(['LATENCY_COMMIT', 'BEAT_OFFSET', 'LATENCY_COMMIT']),
    'mixed: record types preserved newest-first',
  );
  assert((dump[0] as LatencyCommitRecord).prevMs === 85, 'mixed: newest LATENCY_COMMIT prevMs === 85');
  assert((dump[2] as LatencyCommitRecord).prevMs === 0, 'mixed: oldest LATENCY_COMMIT prevMs === 0');
}

// ---------------------------------------------------------------------------
// Test 5 — clear() resets and stays usable.
// ---------------------------------------------------------------------------
{
  const ring = createForensicRing(4);
  ring.push(beat(1));
  ring.push(beat(2));
  ring.clear();
  assert(ring.size === 0, 'clear: size === 0');
  assert(ring.total === 0, 'clear: total === 0');
  assert(ring.dump().length === 0, 'clear: dump empty');
  ring.push(beat(9));
  assert(ring.dump().length === 1, 'clear: usable after clear');
}

// ---------------------------------------------------------------------------
// Test 6 — non-positive capacity clamps to >= 1.
// ---------------------------------------------------------------------------
{
  const ring = createForensicRing(0);
  ring.push(beat(1));
  ring.push(beat(2));
  assert(ring.size === 1, 'clamp: capacity 0 → size 1');
  assert((ring.dump()[0] as BeatOffsetRecord).residualNs === 2, 'clamp: keeps newest');
}

// ---------------------------------------------------------------------------
// Test 7 — default capacity is 64.
// ---------------------------------------------------------------------------
{
  assert(DEFAULT_FORENSIC_CAPACITY === 64, 'default capacity === 64');
  const ring = createForensicRing();
  for (let i = 0; i < 70; i++) ring.push(beat(i));
  assert(ring.size === 64, 'default: caps at 64');
}

console.log('\nAll forensicRing.ts smoke tests passed.');
