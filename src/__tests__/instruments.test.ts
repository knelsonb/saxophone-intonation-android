/**
 * Smoke tests for src/instruments.ts
 *
 * Run with Node 24 (no test runner required):
 *   node --experimental-strip-types src/__tests__/instruments.test.ts
 *
 * Each assertion calls process.exit(1) on failure so CI can catch regressions.
 * Spot-check values are verified against sax_instruments.py (desktop reference).
 */

// @ts-ignore: smoke — .ts extension required for node --experimental-strip-types
import {
  INSTRUMENTS,
  FAMILIES,
  transpMap,
  rangeMap,
  getInstrument,
  getFamily,
} from '../instruments.ts';

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

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// ---------------------------------------------------------------------------
// Instrument count — must match _FAMILIES tuple count in sax_instruments.py
// (saxophone:7 clarinet:10 flute:4 trumpet:12 horn:4 trombone:4
//  low_brass:9 double_reed:5 recorder:5 strings:5 plucked:5 voice_other:3 = 73)
// ---------------------------------------------------------------------------

assertEqual(INSTRUMENTS.length, 73, 'INSTRUMENTS.length === 73');

// ---------------------------------------------------------------------------
// Transposition spot-checks (sax_instruments.py is the ground truth)
// ---------------------------------------------------------------------------

assertEqual(transpMap['bb_tenor'],     -14, 'transpMap[bb_tenor] === -14');
assertEqual(transpMap['eb_alto'],       -9, 'transpMap[eb_alto] === -9');
assertEqual(transpMap['bb_soprano'],    -2, 'transpMap[bb_soprano] === -2');
assertEqual(transpMap['eb_bari'],      -21, 'transpMap[eb_bari] === -21');
assertEqual(transpMap['c'],              0, 'transpMap[c] === 0');
assertEqual(transpMap['clar_bass_bb'], -14, 'transpMap[clar_bass_bb] === -14');
assertEqual(transpMap['clar_contraalto_eb'], -21, 'transpMap[clar_contraalto_eb] === -21');
assertEqual(transpMap['clar_contrabass_bb'], -26, 'transpMap[clar_contrabass_bb] === -26');
assertEqual(transpMap['flute_piccolo'], +12, 'transpMap[flute_piccolo] === +12');

// ---------------------------------------------------------------------------
// getInstrument — key lookup and undefined for missing key
// ---------------------------------------------------------------------------

{
  const inst = getInstrument('bb_tenor');
  assert(inst !== undefined, 'getInstrument("bb_tenor") is defined');
  if (inst !== undefined) {
    assertEqual(inst.transp, -14, 'getInstrument("bb_tenor").transp === -14');
    assertEqual(inst.family, 'saxophone', 'getInstrument("bb_tenor").family === "saxophone"');
    assertEqual(inst.nameEn, 'Bb Sax · Tenor', 'getInstrument("bb_tenor").nameEn');
    assertEqual(inst.nameDe, 'Bb-Sax · Tenor', 'getInstrument("bb_tenor").nameDe');
  }
}

assertEqual(getInstrument('nonexistent_key'), undefined, 'getInstrument("nonexistent_key") === undefined');

// ---------------------------------------------------------------------------
// Range spot-checks — verified against sax_instruments.py _RANGES
// ---------------------------------------------------------------------------

// Bass clarinet: low-C extension; fixed in desktop v0.4.2
assert(rangeMap['clar_bass_bb'][0] === 48, 'rangeMap[clar_bass_bb] lo === 48');
assert(rangeMap['clar_bass_bb'][1] === 96, 'rangeMap[clar_bass_bb] hi === 96');

// Contra clarinets
assert(rangeMap['clar_contraalto_eb'][0] === 48, 'rangeMap[clar_contraalto_eb] lo === 48');
assert(rangeMap['clar_contraalto_eb'][1] === 91, 'rangeMap[clar_contraalto_eb] hi === 91');
assert(rangeMap['clar_contrabass_bb'][0] === 48, 'rangeMap[clar_contrabass_bb] lo === 48');
assert(rangeMap['clar_contrabass_bb'][1] === 91, 'rangeMap[clar_contrabass_bb] hi === 91');

// Saxophone (low A = MIDI 57, altissimo top = 96)
assert(rangeMap['eb_alto'][0] === 57,  'rangeMap[eb_alto] lo === 57');
assert(rangeMap['eb_alto'][1] === 96,  'rangeMap[eb_alto] hi === 96');
assert(rangeMap['bb_tenor'][0] === 57, 'rangeMap[bb_tenor] lo === 57');
assert(rangeMap['bb_tenor'][1] === 96, 'rangeMap[bb_tenor] hi === 96');

// Piano: full 88-key span
assert(rangeMap['piano'][0] === 21,  'rangeMap[piano] lo === 21');
assert(rangeMap['piano'][1] === 108, 'rangeMap[piano] hi === 108');

// ---------------------------------------------------------------------------
// Every instrument has a transpMap and rangeMap entry
// ---------------------------------------------------------------------------

{
  const missingTransp: string[] = [];
  const missingRange: string[] = [];
  for (const inst of INSTRUMENTS) {
    if (transpMap[inst.key] === undefined) missingTransp.push(inst.key);
    if (rangeMap[inst.key] === undefined)  missingRange.push(inst.key);
  }
  assert(
    missingTransp.length === 0,
    `all instruments have transpMap entry (missing: ${missingTransp.join(', ')})`,
  );
  assert(
    missingRange.length === 0,
    `all instruments have rangeMap entry (missing: ${missingRange.join(', ')})`,
  );
}

// ---------------------------------------------------------------------------
// FAMILIES count and structure
// ---------------------------------------------------------------------------

assertEqual(FAMILIES.length, 12, 'FAMILIES.length === 12');

{
  const saxFamily = getFamily('saxophone');
  assert(saxFamily !== undefined, 'getFamily("saxophone") is defined');
  if (saxFamily !== undefined) {
    assertEqual(saxFamily.nameDe, 'Saxophon',  'saxophone.nameDe === "Saxophon"');
    assertEqual(saxFamily.nameEn, 'Saxophone', 'saxophone.nameEn === "Saxophone"');
    assertEqual(saxFamily.instruments.length, 7, 'saxophone family has 7 instruments');
  }
}

assertEqual(getFamily('nonexistent_family'), undefined, 'getFamily("nonexistent_family") === undefined');

// Family display order preserved (saxophone first, voice_other last)
assertEqual(FAMILIES[0].key,  'saxophone',   'FAMILIES[0] is saxophone');
assertEqual(FAMILIES[11].key, 'voice_other', 'FAMILIES[11] is voice_other');

// ---------------------------------------------------------------------------
// Every instrument key listed in FAMILIES exists in INSTRUMENTS
// ---------------------------------------------------------------------------

{
  const instrumentKeys = new Set(INSTRUMENTS.map((i) => i.key));
  const missing: string[] = [];
  for (const family of FAMILIES) {
    for (const key of family.instruments) {
      if (!instrumentKeys.has(key)) missing.push(`${family.key}/${key}`);
    }
  }
  assert(
    missing.length === 0,
    `all FAMILIES instrument refs exist in INSTRUMENTS (missing: ${missing.join(', ')})`,
  );
}

console.log('\nAll instruments.ts smoke tests passed.');
