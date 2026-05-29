/**
 * pitchTones.test.ts — unit coverage for src/pitchTones.ts (pitch-pipe tone math).
 *
 * Legacy-runner test (node --experimental-strip-types via scripts/legacy-tests.js),
 * matching music.test.ts / yin.test.ts. pitchTones.ts has no native imports, so
 * the REAL functions are imported directly (no re-implemented copy that can drift).
 *
 * WHY: the pitch pipes play a REFERENCE tone the user tunes to. If midiToFrequency
 * regresses, or a tuning-map entry's label disagrees with its MIDI, the app plays
 * the WRONG pitch and the user tunes to it — the single worst silence-over-wrong
 * failure for a tuner. This file had zero coverage before.
 *
 * SCOPE/HONESTY: pure math + data-integrity only. Actual audio output (ExoPlayer /
 * file:// playback) is on-device and NOT exercised here. The tuning-map sweep checks
 * INTERNAL consistency (label matches sounding_midi); it does NOT assert the musical
 * correctness of each instrument's chosen tuning note (that's domain/owner knowledge).
 */

import {
  midiToFrequency,
  buildWavBase64,
  tuningNoteForInstrument,
  CHROMATIC_OCTAVE,
} from '../pitchTones.ts';
// The AUDIBLE pitch path (drone/synth/click engines) uses audioGen's copy — a
// separate, formula-identical symbol. Imported here to guard the two from drift.
import { midiToFrequency as midiToFrequencyAudible } from '../audioGen.ts';

// ---------------------------------------------------------------------------
// Assert helpers (legacy idiom — mirrors storage.test.ts / music.test.ts)
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) { console.error(`FAIL: ${message}`); process.exit(1); }
  console.log(`PASS: ${message}`);
}
function assertClose(actual: number, expected: number, tol: number, label: string): void {
  assert(Math.abs(actual - expected) <= tol,
    `${label}: expected ${expected} ±${tol}, got ${actual}`);
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const SEMITONE = Math.pow(2, 1 / 12);

// ---------------------------------------------------------------------------
// midiToFrequency — equal temperament f = a4Hz * 2^((midi-69)/12)
// ---------------------------------------------------------------------------

// Anchor: A4 (midi 69) returns the reference exactly, for any A4.
assertClose(midiToFrequency(69, 440), 440, 1e-9, 'A4@440 == 440 exactly');
assertClose(midiToFrequency(69, 442), 442, 1e-9, 'A4@442 == 442 exactly (calibration anchor)');
assertClose(midiToFrequency(69, 415), 415, 1e-9, 'A4@415 == 415 (baroque pitch)');

// Octaves double / halve exactly.
assertClose(midiToFrequency(81, 440), 880, 1e-6, 'A5 (midi 81) == 2 * A4');
assertClose(midiToFrequency(57, 440), 220, 1e-6, 'A3 (midi 57) == A4 / 2');
assertClose(midiToFrequency(93, 440), 1760, 1e-5, 'A6 (midi 93) == 4 * A4');

// Standard reference frequencies (concert pitch, A4=440).
assertClose(midiToFrequency(60, 440), 261.6255653, 1e-3, 'middle C (C4) == 261.626 Hz');
assertClose(midiToFrequency(72, 440), 523.2511306, 1e-3, 'C5 == 523.251 Hz');
assertClose(midiToFrequency(64, 440), 329.6275569, 1e-3, 'E4 == 329.628 Hz');
assertClose(midiToFrequency(70, 440), 466.1637615, 1e-3, 'Bb4 == 466.164 Hz');

// Adjacent semitone ratio is the 12th root of 2 everywhere.
for (const m of [40, 55, 60, 69, 84]) {
  assertClose(midiToFrequency(m + 1, 440) / midiToFrequency(m, 440), SEMITONE, 1e-12,
    `semitone ratio at midi ${m} == 2^(1/12)`);
}

// A4 calibration scales the WHOLE grid linearly: f(m,442)/f(m,440) == 442/440 for any m.
for (const m of [36, 48, 60, 69, 81, 96]) {
  assertClose(midiToFrequency(m, 442) / midiToFrequency(m, 440), 442 / 440, 1e-12,
    `A4 scaling is linear at midi ${m}`);
}

// Strictly monotonic increasing across the usable range.
{
  let prev = -Infinity;
  let mono = true;
  for (let m = 21; m <= 108; m++) {
    const f = midiToFrequency(m, 440);
    if (!(f > prev)) { mono = false; break; }
    prev = f;
  }
  assert(mono, 'midiToFrequency strictly increasing over midi 21..108');
}

// Matches the closed-form exactly (guards against a refactor introducing a table/approx).
assertClose(midiToFrequency(50, 440), 440 * Math.pow(2, (50 - 69) / 12), 1e-12,
  'matches closed-form at midi 50');

// audioGen.midiToFrequency is the AUDIBLE path (drone/synth/click engines use
// it, NOT pitchTones'). It is formula-identical today; guard the two against
// ever diverging — the audible reference pitch is what the user tunes to.
assertClose(midiToFrequencyAudible(69), 440, 1e-9, 'audioGen default A4 == 440');
assertClose(midiToFrequencyAudible(69, 442), 442, 1e-9, 'audioGen A4@442 == 442');
{
  let agree = true;
  let firstBad = '';
  for (let m = 21; m <= 108 && agree; m++) {
    for (const a4 of [415, 440, 442]) {
      if (midiToFrequencyAudible(m, a4) !== midiToFrequency(m, a4)) {
        agree = false;
        firstBad = ` — first mismatch midi ${m}@${a4}: audioGen=${midiToFrequencyAudible(m, a4)} pitchTones=${midiToFrequency(m, a4)}`;
        break;
      }
    }
  }
  assert(agree, `audioGen and pitchTones midiToFrequency agree exactly across midi 21..108 @{415,440,442}${firstBad}`);
}

// ---------------------------------------------------------------------------
// tuningNoteForInstrument — known families + unknown → null
// ---------------------------------------------------------------------------

function expectTuning(key: string, midi: number, label: string): void {
  const t = tuningNoteForInstrument(key);
  assert(t !== null, `${key} has a tuning note`);
  assertEqual(t!.sounding_midi, midi, `${key} sounding_midi`);
  assertEqual(t!.label, label, `${key} label`);
}

expectTuning('bb_tenor', 70, 'Bb4');
expectTuning('eb_alto', 63, 'Eb4');
expectTuning('violin', 69, 'A4');
expectTuning('flute_piccolo', 81, 'A5');
expectTuning('tuba_bbb', 46, 'Bb2');
expectTuning('oboe_damore', 66, 'F#4');
expectTuning('english_horn', 62, 'D4');
expectTuning('contrabassoon', 45, 'A2');
expectTuning('tuba_cc', 48, 'C3');

for (const unknown of ['guitar', 'banjo', '', 'nonsense_key', 'BB_TENOR']) {
  assertEqual(tuningNoteForInstrument(unknown), null, `unknown instrument '${unknown}' → null`);
}

// ---------------------------------------------------------------------------
// Tuning-map INTEGRITY sweep — every entry's label must agree with its MIDI.
// A typo in either field = a wrong reference pitch for that instrument. The
// map is hand-maintained (60+ entries), so this is the real regression guard.
// (Validates label↔midi consistency, NOT the musical choice of tuning note.)
// ---------------------------------------------------------------------------

const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Parse a label like "Bb4" / "F#4" / "A2" to its MIDI number. */
function labelToMidi(label: string): number {
  const m = label.match(/^([A-G])(b|#)?(-?\d+)$/);
  assert(m !== null, `tuning label is well-formed: '${label}'`);
  const base = PITCH_CLASS[m![1]];
  const accidental = m![2] === 'b' ? -1 : m![2] === '#' ? 1 : 0;
  const octave = parseInt(m![3], 10);
  return (octave + 1) * 12 + base + accidental;
}

// Sanity-check the parser itself before trusting it on the map.
assertEqual(labelToMidi('A4'), 69, 'labelToMidi A4 == 69');
assertEqual(labelToMidi('Bb4'), 70, 'labelToMidi Bb4 == 70');
assertEqual(labelToMidi('C3'), 48, 'labelToMidi C3 == 48');
assertEqual(labelToMidi('F#4'), 66, 'labelToMidi F#4 == 66');

// All instrument keys present in TUNING_NOTE_MAP (kept in sync with pitchTones.ts).
const ALL_TUNING_KEYS: string[] = [
  'bb_soprano', 'bb_tenor', 'bb_bass',
  'eb_sopranino', 'eb_alto', 'eb_bari', 'eb_contrabass',
  'clar_bb', 'clar_bass_bb', 'clar_contrabass_bb',
  'clar_eb', 'clar_alto_eb', 'clar_contraalto_eb',
  'clar_a', 'clar_c', 'clar_d', 'clar_basset_f',
  'flute_c', 'flute_piccolo', 'flute_alto_g', 'flute_bass_c',
  'trp_bb', 'trp_c', 'trp_d', 'trp_e', 'trp_eb', 'trp_f', 'trp_a',
  'trp_bass_bb', 'trp_piccolo_bb', 'trp_piccolo_a', 'cornet_bb', 'flugel_bb',
  'horn_f', 'horn_bb', 'horn_eb_alto', 'mellophone_f',
  'tbn_tenor', 'tbn_bass', 'tbn_alto_eb', 'tbn_contrabass',
  'euph_bc', 'euph_tc', 'baritone_bc', 'baritone_tc',
  'tuba_f', 'tuba_eb', 'tuba_cc', 'tuba_bbb', 'sousaphone_bbb',
  'oboe', 'oboe_damore', 'english_horn', 'bassoon', 'contrabassoon',
  'violin', 'viola', 'cello', 'double_bass',
  'c', 'piano', 'voice',
];

for (const key of ALL_TUNING_KEYS) {
  const t = tuningNoteForInstrument(key);
  assert(t !== null, `tuning-map sweep: '${key}' present`);
  assertEqual(labelToMidi(t!.label), t!.sounding_midi,
    `tuning-map sweep: '${key}' label '${t!.label}' matches sounding_midi ${t!.sounding_midi}`);
  // Range sanity: a real, playable concert pitch.
  assert(t!.sounding_midi >= 21 && t!.sounding_midi <= 108,
    `tuning-map sweep: '${key}' sounding_midi in piano range`);
}

// ---------------------------------------------------------------------------
// CHROMATIC_OCTAVE — the default pitch-pipe octave (C4..B4)
// ---------------------------------------------------------------------------

assertEqual(CHROMATIC_OCTAVE.length, 12, 'CHROMATIC_OCTAVE has 12 notes');
assertEqual(CHROMATIC_OCTAVE[0].midi, 60, 'starts at C4 (midi 60)');
assertEqual(CHROMATIC_OCTAVE[0].name, 'C', 'first note is C');
assertEqual(CHROMATIC_OCTAVE[11].midi, 71, 'ends at B4 (midi 71)');
assertEqual(CHROMATIC_OCTAVE[9].midi, 69, 'A is midi 69 (concert A4)');
for (let i = 0; i < CHROMATIC_OCTAVE.length; i++) {
  assertEqual(CHROMATIC_OCTAVE[i].midi, 60 + i, `CHROMATIC_OCTAVE[${i}] is consecutive`);
}

// ---------------------------------------------------------------------------
// buildWavBase64 — produces a valid, playable mono 16-bit PCM WAV
// ---------------------------------------------------------------------------

{
  const b64 = buildWavBase64(69, 440);
  assert(typeof b64 === 'string' && b64.length > 0, 'buildWavBase64 returns a non-empty string');

  const bytes = Buffer.from(b64, 'base64');
  assert(bytes.length > 44, 'WAV has a 44-byte header plus PCM data');

  const ascii = (off: number, len: number): string =>
    String.fromCharCode(...bytes.subarray(off, off + len));
  assertEqual(ascii(0, 4), 'RIFF', 'RIFF magic');
  assertEqual(ascii(8, 4), 'WAVE', 'WAVE magic');
  assertEqual(ascii(12, 4), 'fmt ', 'fmt sub-chunk');
  assertEqual(ascii(36, 4), 'data', 'data sub-chunk');

  assertEqual(bytes.readUInt16LE(20), 1, 'audio format == PCM (1)');
  assertEqual(bytes.readUInt16LE(22), 1, 'channels == mono (1)');
  assertEqual(bytes.readUInt32LE(24), 44100, 'sample rate == 44100');
  assertEqual(bytes.readUInt16LE(34), 16, 'bits per sample == 16');
  assertEqual(bytes.readUInt32LE(16), 16, 'fmt sub-chunk size == 16 (PCM)');
  assertEqual(bytes.readUInt32LE(28), 88200, 'byte rate == 44100 * 1ch * 2bytes');
  assertEqual(bytes.readUInt16LE(32), 2, 'block align == 2 (mono * 16-bit)');

  const dataSize = bytes.readUInt32LE(40);
  assertEqual(dataSize, bytes.length - 44, 'declared data size matches actual PCM length');
  assertEqual(bytes.readUInt32LE(4), 36 + dataSize, 'RIFF chunk size == 36 + dataSize');
  assertEqual(dataSize % 2, 0, '16-bit samples → even byte count');

  // Frequency flows through: a higher note packs fewer samples per cycle, so a
  // ~integer-cycle buffer for C5 is shorter than for C4.
  const lowLen = Buffer.from(buildWavBase64(60, 440), 'base64').length;
  const highLen = Buffer.from(buildWavBase64(72, 440), 'base64').length;
  assert(highLen < lowLen, 'C5 buffer shorter than C4 buffer (freq drives sample count)');
}

console.log('\nAll pitchTones.ts tests passed.');
