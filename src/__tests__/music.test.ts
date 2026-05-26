/**
 * Smoke tests for src/music.ts
 *
 * Run with Node 24 (no test runner required):
 *   node --experimental-strip-types src/__tests__/music.test.ts
 */

// @ts-ignore: smoke — .ts extension required for node --experimental-strip-types
import {
  freqToMidi,
  midiToNoteName,
  centsDeviation,
  centsDisplayPrecision,
} from '../music.ts';

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
  actual: number,
  expected: number,
  tolerance: number,
  label: string,
): void {
  const diff = Math.abs(actual - expected);
  assert(
    diff <= tolerance,
    `${label}: got ${actual.toFixed(6)}, expected ${expected} ± ${tolerance}`,
  );
}

// ---------------------------------------------------------------------------
// freqToMidi
// ---------------------------------------------------------------------------

// A4 = 440 Hz → MIDI 69 exactly
assertClose(freqToMidi(440, 440), 69.0, 1e-10, 'freqToMidi(440, 440) === 69');

// A4 with A4=442 (European reference) → slightly below 69
assert(freqToMidi(440, 442) < 69, 'freqToMidi(440, 442) < 69 (concert A is flat relative to A4=442)');

// C4 (middle C) = MIDI 60
// freq(C4) = 440 * 2^((60-69)/12) = 440 * 2^(-9/12) ≈ 261.626 Hz
{
  const c4hz = 440 * Math.pow(2, (60 - 69) / 12);
  assertClose(freqToMidi(c4hz, 440), 60.0, 1e-10, 'freqToMidi(C4_hz, 440) === 60');
}

// Octave doubling: A5 = 880 Hz → MIDI 81
assertClose(freqToMidi(880, 440), 81.0, 1e-10, 'freqToMidi(880, 440) === 81');

// Default a4Hz = 440 applies when omitted
assertClose(freqToMidi(440), 69.0, 1e-10, 'freqToMidi(440) default a4Hz=440');

// ---------------------------------------------------------------------------
// midiToNoteName
// ---------------------------------------------------------------------------

// A4 = MIDI 69
{
  const r = midiToNoteName(69);
  assert(r.letter === 'A', 'midiToNoteName(69).letter === "A"');
  assert(r.accidental === '', 'midiToNoteName(69).accidental === ""');
  assert(r.octave === 4, `midiToNoteName(69).octave === 4 (got ${r.octave})`);
}

// C4 = MIDI 60
{
  const r = midiToNoteName(60);
  assert(r.letter === 'C', 'midiToNoteName(60).letter === "C"');
  assert(r.accidental === '', 'midiToNoteName(60).accidental === ""');
  assert(r.octave === 4, `midiToNoteName(60).octave === 4 (got ${r.octave})`);
}

// C#4 = MIDI 61
{
  const r = midiToNoteName(61);
  assert(r.letter === 'C', 'midiToNoteName(61).letter === "C"');
  assert(r.accidental === '#', 'midiToNoteName(61).accidental === "#"');
  assert(r.octave === 4, `midiToNoteName(61).octave === 4 (got ${r.octave})`);
}

// C5 = MIDI 72
{
  const r = midiToNoteName(72);
  assert(r.letter === 'C', 'midiToNoteName(72).letter === "C"');
  assert(r.octave === 5, `midiToNoteName(72).octave === 5 (got ${r.octave})`);
}

// B3 = MIDI 59
{
  const r = midiToNoteName(59);
  assert(r.letter === 'B', 'midiToNoteName(59).letter === "B"');
  assert(r.accidental === '', 'midiToNoteName(59).accidental === ""');
  assert(r.octave === 3, `midiToNoteName(59).octave === 3 (got ${r.octave})`);
}

// C0 = MIDI 12 (edge: very low)
{
  const r = midiToNoteName(12);
  assert(r.letter === 'C', 'midiToNoteName(12).letter === "C"');
  assert(r.octave === 0, `midiToNoteName(12).octave === 0 (got ${r.octave})`);
}

// Bb4 = MIDI 70 — uses sharp name A#
{
  const r = midiToNoteName(70);
  assert(r.letter === 'A', 'midiToNoteName(70).letter === "A" (A#4)');
  assert(r.accidental === '#', 'midiToNoteName(70).accidental === "#"');
  assert(r.octave === 4, `midiToNoteName(70).octave === 4 (got ${r.octave})`);
}

// Fractional input is rounded: MIDI 69.3 → 69 → A4
{
  const r = midiToNoteName(69.3);
  assert(r.letter === 'A', 'midiToNoteName(69.3) rounds to A4');
  assert(r.octave === 4, `midiToNoteName(69.3).octave === 4 (got ${r.octave})`);
}

// ---------------------------------------------------------------------------
// centsDeviation
// ---------------------------------------------------------------------------

// 440 Hz at A4=440 → exactly on pitch → cents ≈ 0
{
  const r = centsDeviation(440, 440);
  assert(r.nearestMidi === 69, `centsDeviation(440,440).nearestMidi === 69 (got ${r.nearestMidi})`);
  assertClose(r.cents, 0.0, 1e-10, 'centsDeviation(440,440).cents === 0');
}

// 442 Hz at A4=440 → sharp → cents ≈ +7.845¢
// Derivation: midi = 69 + 12*log2(442/440) = 69 + 12*log2(1.00454...)
//   log2(1.00454) ≈ 0.006544; * 12 ≈ 0.07853; * 100 ≈ 7.853 cents
{
  const r = centsDeviation(442, 440);
  assert(r.nearestMidi === 69, `centsDeviation(442,440).nearestMidi === 69 (got ${r.nearestMidi})`);
  assertClose(r.cents, 7.845, 0.05, 'centsDeviation(442,440).cents ≈ +7.85');
  assert(r.cents > 0, 'centsDeviation(442,440): positive = sharp');
}

// 438 Hz at A4=440 → flat → cents ≈ -7.845¢
{
  const r = centsDeviation(438, 440);
  assert(r.nearestMidi === 69, `centsDeviation(438,440).nearestMidi === 69 (got ${r.nearestMidi})`);
  assert(r.cents < 0, 'centsDeviation(438,440): negative = flat');
}

// Exactly 50¢ sharp: midpoint → rounds up to next MIDI, returns -50
// (or stays at boundary — depends on round-half-to-even behavior)
// Just verify cents is in [-50, 50].
{
  const halfSharpFreq = 440 * Math.pow(2, 0.5 / 12); // exactly 50¢ sharp from A4
  const r = centsDeviation(halfSharpFreq, 440);
  assert(
    r.cents >= -50 && r.cents <= 50,
    `centsDeviation boundary: cents ${r.cents.toFixed(4)} in [-50,50]`,
  );
}

// Lower C (MIDI 48 = C3): verify note name consistency
{
  const c3hz = 440 * Math.pow(2, (48 - 69) / 12);
  const r = centsDeviation(c3hz, 440);
  assert(r.nearestMidi === 48, `centsDeviation(C3_hz) nearestMidi=48 (got ${r.nearestMidi})`);
  assertClose(r.cents, 0.0, 1e-9, 'centsDeviation(C3_hz) cents=0');
}

// ---------------------------------------------------------------------------
// centsDisplayPrecision
// ---------------------------------------------------------------------------

// At 44100 Hz:
//   floor = 173 * freq / 44100
//   floor=0.3 crossover at freq ≈ 76.5 Hz  → below → 0.1
//   floor=0.7 crossover at freq ≈ 178.5 Hz → above 76.5 but below → 0.5
//   above 178.5 Hz → 1.0   -- wait, logic is inverted: see note below

// Re-check: floor <= 0.3 → 0.1¢; floor <= 0.7 → 0.5¢; else → 1.0¢
// LOW freq → SMALL floor → finest precision (0.1¢)
// HIGH freq → LARGE floor → coarsest precision (1.0¢)

// Eb3 ≈ 155.56 Hz — floor = 173*155.56/44100 ≈ 0.610 → ≤ 0.7 → 0.5¢
assert(centsDisplayPrecision(155.56, 44100) === 0.5, 'Eb3 (155.56 Hz) @ 44100 → 0.5¢');

// A4 = 440 Hz — floor = 173*440/44100 ≈ 1.726 → > 0.7 → 1.0¢
assert(centsDisplayPrecision(440, 44100) === 1.0, 'A4 (440 Hz) @ 44100 → 1.0¢');

// Very low: E2 ≈ 82.4 Hz — floor = 173*82.4/44100 ≈ 0.323 → > 0.3 → 0.5¢
assert(centsDisplayPrecision(82.4, 44100) === 0.5, 'E2 (82.4 Hz) @ 44100 → 0.5¢');

// Very low: Db2 ≈ 69.3 Hz — floor = 173*69.3/44100 ≈ 0.272 → ≤ 0.3 → 0.1¢
assert(centsDisplayPrecision(69.3, 44100) === 0.1, 'Db2 (69.3 Hz) @ 44100 → 0.1¢');

// 192000 Hz sample rate: same 440 Hz — floor = 173*440/192000 ≈ 0.396 → ≤ 0.7 → 0.5¢
assert(centsDisplayPrecision(440, 192000) === 0.5, 'A4 @ 192000 Hz → 0.5¢ (higher rate, finer)');

// Edge: freqHz = 0 → default fallback 1.0
assert(centsDisplayPrecision(0, 44100) === 1.0, 'freqHz=0 → 1.0¢ fallback');

// Edge: negative freq → 1.0 (guard)
assert(centsDisplayPrecision(-1, 44100) === 1.0, 'freqHz=-1 → 1.0¢ fallback');

// Confirm the tier crossover at 44100 Hz:
//   173 * 76.5 / 44100 = 0.300... — right on the boundary; should be 0.1¢
{
  const crossoverLow = (0.3 * 44100) / 173; // ≈ 76.5 Hz
  assert(
    centsDisplayPrecision(crossoverLow - 0.01, 44100) === 0.1,
    'just below 76.5 Hz crossover → 0.1¢',
  );
  // At exactly crossoverLow: floor = 0.3 exactly → ≤ 0.3 → 0.1¢
  assert(
    centsDisplayPrecision(crossoverLow, 44100) === 0.1,
    'exactly at 76.5 Hz crossover → 0.1¢ (≤ boundary)',
  );
  assert(
    centsDisplayPrecision(crossoverLow + 0.01, 44100) === 0.5,
    'just above 76.5 Hz crossover → 0.5¢',
  );
}

{
  const crossoverHigh = (0.7 * 44100) / 173; // ≈ 178.5 Hz
  assert(
    centsDisplayPrecision(crossoverHigh - 0.01, 44100) === 0.5,
    'just below 178.5 Hz crossover → 0.5¢',
  );
  assert(
    centsDisplayPrecision(crossoverHigh, 44100) === 0.5,
    'exactly at 178.5 Hz crossover → 0.5¢ (≤ boundary)',
  );
  assert(
    centsDisplayPrecision(crossoverHigh + 0.01, 44100) === 1.0,
    'just above 178.5 Hz crossover → 1.0¢',
  );
}

console.log('\nAll music.ts smoke tests passed.');
