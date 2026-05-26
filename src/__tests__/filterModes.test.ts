/**
 * Smoke tests for src/filterModes.ts
 *
 * Run with Node 24 (no test runner required):
 *   node --experimental-strip-types src/__tests__/filterModes.test.ts
 *
 * Each assertion calls process.exit(1) on failure so CI can catch regressions.
 */

// @ts-ignore: smoke — .ts extension required for node --experimental-strip-types
import {
  FILTER_PRESETS,
  newFilterState,
  resetFilterState,
  processFrame,
} from '../filterModes.ts';
import type { FilterPreset, FilterState } from '../filterModes.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`PASS: ${message}`);
}

function assertClose(
  actual: number | null,
  expected: number,
  tolerance: number,
  label: string,
): void {
  if (actual === null) {
    console.error(`FAIL: ${label}: got null, expected ${expected}`);
    process.exit(1);
  }
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, `${label}: got ${actual.toFixed(3)}, expected ${expected} ± ${tolerance}`);
}

/** Convert MIDI note number to Hz (A4=440). */
function midiToHz(midi: number): number {
  return 440.0 * Math.pow(2, (midi - 69) / 12);
}

const SR = 44100;

// ---------------------------------------------------------------------------
// Test 1: Confirm window filling — 3 consecutive matching frames → locked output
//
// Using "fast" preset: window=3, confirm=2, edgeHops=1.
// Frame 1: 1 match of 3 required — suppressed.
// Frame 2: 2 matches → confirmed. _lockedMidi changes from null → N,
//          _hopInNote resets to 0, then increments to 1. edgeHops=1 so
//          hopInNote(1) <= edgeHops(1) → suppressed.
// Frame 3: still confirmed (window has 3 matching), hopInNote=2 > edgeHops=1
//          → median computed, pushed to _pending. _pending.length(1) <= edgeHops(1)
//          → no emit yet.
// Frame 4: hopInNote=3, _pending grows to 2 > edgeHops(1) → emit first entry.
// ---------------------------------------------------------------------------
{
  const preset = FILTER_PRESETS.fast; // window=3, confirm=2, edgeHops=1
  const s = newFilterState();
  const hz = midiToHz(60); // middle C

  const r1 = processFrame(s, hz, preset, SR);
  assert(r1 === null, 'confirm: frame 1 suppressed (below confirm)');

  const r2 = processFrame(s, hz, preset, SR);
  assert(r2 === null, 'confirm: frame 2 suppressed (edge hop)');

  const r3 = processFrame(s, hz, preset, SR);
  assert(r3 === null, 'confirm: frame 3 suppressed (pending not deep enough)');

  const r4 = processFrame(s, hz, preset, SR);
  assert(r4 !== null, 'confirm: frame 4 emits');
  assertClose(r4, hz, 1.0, 'confirm: frame 4 frequency close to input');
}

// ---------------------------------------------------------------------------
// Test 2: Edge-hop suppression after MIDI change
//
// Using "normal" preset: window=5, confirm=3, edgeHops=2.
// Establish C4 (MIDI 60) as locked, then switch to D4 (MIDI 62).
// The first edgeHops=2 frames at D4 must be suppressed.
// ---------------------------------------------------------------------------
{
  const preset = FILTER_PRESETS.normal; // window=5, confirm=3, edgeHops=2
  const s = newFilterState();
  const hzC = midiToHz(60);
  const hzD = midiToHz(62);

  // Warm up on C4 — need enough frames to get past confirm + edgeHops + pending.
  // confirm=3, edgeHops=2: first emit at frame confirm(3) + edgeHops(2) + edgeHops(2) + 1 = 8
  for (let i = 0; i < 8; i++) {
    processFrame(s, hzC, preset, SR);
  }
  // Verify C4 is locked.
  assert(s._lockedMidi === 60, 'edge-hop: C4 locked after warm-up');

  // Now feed D4 — first edgeHops frames must be null.
  const d1 = processFrame(s, hzD, preset, SR);
  assert(d1 === null, 'edge-hop: D4 frame 1 suppressed (confirm not met yet)');

  const d2 = processFrame(s, hzD, preset, SR);
  assert(d2 === null, 'edge-hop: D4 frame 2 suppressed');

  const d3 = processFrame(s, hzD, preset, SR);
  assert(d3 === null, 'edge-hop: D4 frame 3 suppressed (confirm=3 just met, edgeHops gate now starts)');

  // Frames 4+ should eventually emit.
  let emitted: number | null = null;
  for (let i = 0; i < 6; i++) {
    const r = processFrame(s, hzD, preset, SR);
    if (r !== null) { emitted = r; break; }
  }
  assert(emitted !== null, 'edge-hop: D4 eventually emits after edge guard');
  assertClose(emitted, hzD, 2.0, 'edge-hop: emitted D4 frequency within ±2 Hz');
}

// ---------------------------------------------------------------------------
// Test 3: Median across a window of [-2¢, 0¢, +2¢] deviations
//
// Synthesise three frames whose freqHz values straddle the true pitch by
// ±2 cents. The median should land within 1 cent of the true pitch.
// Using "fast" preset (window=3) so all three fit in one window.
// ---------------------------------------------------------------------------
{
  const preset = FILTER_PRESETS.fast; // window=3, confirm=2, edgeHops=1
  const s = newFilterState();
  const trueMidi = 69; // A4 = 440 Hz
  const trueHz = 440.0;

  // ±2 cents in Hz: Hz * 2^(±0.02/12)
  const flatHz = trueHz * Math.pow(2, -2 / 1200);
  const sharpHz = trueHz * Math.pow(2, 2 / 1200);

  // Feed flat, centre, sharp — all round to MIDI 69 so they confirm.
  // We need to get past confirm(2) + edgeHops(1) + pending fill.
  // Drive with enough frames to emit.
  let result: number | null = null;
  const inputs = [flatHz, trueHz, sharpHz, trueHz, trueHz, trueHz];
  for (const hz of inputs) {
    const r = processFrame(s, hz, preset, SR);
    if (r !== null) { result = r; break; }
  }
  assert(result !== null, 'median: emitted a result');
  // The median of flatHz, trueHz, sharpHz is trueHz; confirm within 0.5 Hz.
  assertClose(result, trueHz, 0.5, 'median: result within 0.5 Hz of 440');
}

// ---------------------------------------------------------------------------
// Test 4: Silence (null input) resets state
//
// Warm up to a locked note, then feed null. State must clear.
// ---------------------------------------------------------------------------
{
  const preset = FILTER_PRESETS.fast;
  const s = newFilterState();
  const hz = midiToHz(60);

  // Warm up enough to lock.
  for (let i = 0; i < 6; i++) {
    processFrame(s, hz, preset, SR);
  }
  assert(s._lockedMidi !== null, 'silence: locked before null');

  processFrame(s, null, preset, SR);

  assert(s._lockedMidi === null, 'silence: _lockedMidi cleared after null');
  assert(s._recent.length === 0, 'silence: _recent cleared after null');
  assert(s._hopInNote === 0, 'silence: _hopInNote reset after null');
}

// ---------------------------------------------------------------------------
// Test 5: resetFilterState clears all fields
// ---------------------------------------------------------------------------
{
  const preset = FILTER_PRESETS.slow;
  const s = newFilterState();
  const hz = midiToHz(72);

  for (let i = 0; i < 12; i++) {
    processFrame(s, hz, preset, SR);
  }
  // State should be non-trivial.
  assert(s._recent.length > 0 || s._lockedMidi !== null, 'reset: state is non-trivial before reset');

  resetFilterState(s);
  assert(s._recent.length === 0, 'reset: _recent empty');
  assert(s._lockedMidi === null, 'reset: _lockedMidi null');
  assert(s._hopInNote === 0, 'reset: _hopInNote zero');
  assert(s._pending.length === 0, 'reset: _pending empty');
}

// ---------------------------------------------------------------------------
// Test 6: Mode-switching preset parameters are correct
// ---------------------------------------------------------------------------
{
  assert(FILTER_PRESETS.fast.window === 3,   'preset fast: window=3');
  assert(FILTER_PRESETS.fast.confirm === 2,  'preset fast: confirm=2');
  assert(FILTER_PRESETS.fast.yinThreshold === 0.15, 'preset fast: yinThreshold=0.15');
  assert(FILTER_PRESETS.fast.rmsFloorLinear === 8e-5, 'preset fast: rmsFloorLinear=8e-5');
  assert(FILTER_PRESETS.fast.edgeHops === 1, 'preset fast: edgeHops=1');

  assert(FILTER_PRESETS.normal.window === 5,   'preset normal: window=5');
  assert(FILTER_PRESETS.normal.confirm === 3,  'preset normal: confirm=3');
  assert(FILTER_PRESETS.normal.yinThreshold === 0.10, 'preset normal: yinThreshold=0.10');
  assert(Math.abs(FILTER_PRESETS.normal.rmsFloorLinear - 1.5e-4) < 1e-10, 'preset normal: rmsFloorLinear=1.5e-4');
  assert(FILTER_PRESETS.normal.edgeHops === 2, 'preset normal: edgeHops=2');

  assert(FILTER_PRESETS.slow.window === 10,  'preset slow: window=10');
  assert(FILTER_PRESETS.slow.confirm === 6,  'preset slow: confirm=6');
  assert(FILTER_PRESETS.slow.yinThreshold === 0.07, 'preset slow: yinThreshold=0.07');
  assert(FILTER_PRESETS.slow.rmsFloorLinear === 3e-4, 'preset slow: rmsFloorLinear=3e-4');
  assert(FILTER_PRESETS.slow.edgeHops === 4, 'preset slow: edgeHops=4');
}

// ---------------------------------------------------------------------------
// Test 7: Zero-input (0 Hz) treated as silence
// ---------------------------------------------------------------------------
{
  const preset = FILTER_PRESETS.normal;
  const s = newFilterState();

  for (let i = 0; i < 8; i++) {
    processFrame(s, midiToHz(60), preset, SR);
  }
  const wasLocked = s._lockedMidi;
  processFrame(s, 0, preset, SR);
  assert(s._lockedMidi === null, 'zero-hz: treated as silence, lockedMidi cleared');
}

console.log('\nAll filterModes.ts smoke tests passed.');
