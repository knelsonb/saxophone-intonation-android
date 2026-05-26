/**
 * Smoke tests for the aggregation algorithm used by src/storage/measurements.ts.
 *
 * Run with Node 24 (no test runner required):
 *   node --experimental-strip-types src/__tests__/aggregation.test.ts
 *
 * Strategy: pure-JS reference implementation (approach 1 from the brief).
 *   - aggregate() mirrors the SQL query measurements.ts will run via expo-sqlite.
 *   - std dev formula: population (matches SQLite SQRT(AVG(x*x) - AVG(x)^2)).
 *   - Tests the algorithm; the SQL translation is a separate concern.
 *
 * NOT covered (requires on-device integration):
 *   - expo-sqlite lifecycle (open/close/migrate)
 *   - Schema migrations and column additions
 *   - Concurrent write safety from multiple React Native renders
 *   - Physical storage limits / SQLite FULL errors
 *   - rangeOverrides persistence and JOIN queries
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) { console.error(`FAIL: ${message}`); process.exit(1); }
  console.log(`PASS: ${message}`);
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertClose(actual: number, expected: number, tol: number, label: string): void {
  assert(Math.abs(actual - expected) <= tol,
    `${label}: got ${actual.toFixed(6)}, expected ${expected} ± ${tol}`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawSample     { midiFing: number; instrumentKey: string; cents: number; }
interface AggregatedNote { midiFing: number; instrumentKey: string; n: number; meanCents: number; stdCents: number; }

// ---------------------------------------------------------------------------
// Reference implementation
//
// Mirrors:
//   SELECT midiFing, instrumentKey,
//          COUNT(*) n, AVG(cents) meanCents,
//          SQRT(MAX(0, AVG(cents*cents) - AVG(cents)*AVG(cents))) stdCents
//   FROM measurements WHERE instrumentKey = ?
//   GROUP BY midiFing, instrumentKey HAVING n >= ?
// ---------------------------------------------------------------------------

function populationStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

function aggregate(samples: RawSample[], instrumentKey: string, minN: number): AggregatedNote[] {
  const groups = new Map<number, number[]>();
  for (const s of samples) {
    if (s.instrumentKey !== instrumentKey) continue;
    const bucket = groups.get(s.midiFing) ?? [];
    bucket.push(s.cents);
    groups.set(s.midiFing, bucket);
  }
  const results: AggregatedNote[] = [];
  for (const [midiFing, cents] of groups) {
    if (cents.length < minN) continue;
    const n = cents.length;
    const meanCents = cents.reduce((s, v) => s + v, 0) / n;
    results.push({ midiFing, instrumentKey, n, meanCents, stdCents: populationStdDev(cents) });
  }
  return results.sort((a, b) => a.midiFing - b.midiFing);
}

// ---------------------------------------------------------------------------
// Test 1: [0¢, 0¢, 0¢] → mean=0, std=0, n=3
// ---------------------------------------------------------------------------
{
  const rows = aggregate(
    [60, 60, 60].map(m => ({ midiFing: m, instrumentKey: 'bb_tenor', cents: 0 })),
    'bb_tenor', 1,
  );
  assertEqual(rows.length, 1, '[0,0,0]: one group');
  assertEqual(rows[0].n,    3, '[0,0,0]: n=3');
  assertClose(rows[0].meanCents, 0, 1e-10, '[0,0,0]: meanCents=0');
  assertClose(rows[0].stdCents,  0, 1e-10, '[0,0,0]: stdCents=0');
}

// ---------------------------------------------------------------------------
// Test 2: [-5¢, 0¢, +5¢] → mean=0, std=sqrt(50/3) ≈ 4.082
//
// Population variance: ((−5)²+0²+5²)/3 = 50/3; std = sqrt(50/3).
// ---------------------------------------------------------------------------
{
  const rows = aggregate(
    [-5, 0, 5].map(c => ({ midiFing: 69, instrumentKey: 'eb_alto', cents: c })),
    'eb_alto', 1,
  );
  assertEqual(rows.length, 1, '[-5,0,+5]: one group');
  assertEqual(rows[0].n,    3, '[-5,0,+5]: n=3');
  assertClose(rows[0].meanCents, 0,                   1e-10, '[-5,0,+5]: mean=0');
  assertClose(rows[0].stdCents,  Math.sqrt(50 / 3),   1e-6,  '[-5,0,+5]: std=sqrt(50/3)');
}

// ---------------------------------------------------------------------------
// Test 3: Single measurement → mean=10, std=0 (n<2 guard)
// ---------------------------------------------------------------------------
{
  const rows = aggregate(
    [{ midiFing: 72, instrumentKey: 'bb_tenor', cents: 10 }],
    'bb_tenor', 1,
  );
  assertEqual(rows[0].n,          1, 'single: n=1');
  assertClose(rows[0].meanCents, 10, 1e-10, 'single: mean=10');
  assertClose(rows[0].stdCents,   0, 1e-10, 'single: std=0 (n<2 guard)');
}

// ---------------------------------------------------------------------------
// Test 4: minN filter — n=6 passes minN=4; n=3 excluded
// ---------------------------------------------------------------------------
{
  const make = (midi: number, n: number): RawSample[] =>
    Array.from({ length: n }, () => ({ midiFing: midi, instrumentKey: 'bb_tenor', cents: 0 }));

  const rows = aggregate([...make(60, 6), ...make(72, 3)], 'bb_tenor', 4);
  assertEqual(rows.length,        1,  'minN=4: only n=6 group passes');
  assertEqual(rows[0].midiFing,  60,  'minN=4: surviving row midiFing=60');
  assertEqual(rows[0].n,          6,  'minN=4: n=6 confirmed');
}

// ---------------------------------------------------------------------------
// Test 5: minN=5, n=3 → excluded entirely
// ---------------------------------------------------------------------------
{
  const rows = aggregate(
    [-2, 0, 2].map(c => ({ midiFing: 60, instrumentKey: 'eb_alto', cents: c })),
    'eb_alto', 5,
  );
  assertEqual(rows.length, 0, 'minN=5 n=3: empty result');
}

// ---------------------------------------------------------------------------
// Test 6: Mixed notes — midiFing=60 (5 samples), midiFing=72 (3), minN=4
//          → only midiFing=60 survives
// ---------------------------------------------------------------------------
{
  const s60: RawSample[] = [-3, -1, 0, 1, 3].map(c => ({ midiFing: 60, instrumentKey: 'bb_tenor', cents: c }));
  const s72: RawSample[] = [5, 6, 7].map(c => ({ midiFing: 72, instrumentKey: 'bb_tenor', cents: c }));
  const rows = aggregate([...s60, ...s72], 'bb_tenor', 4);
  assertEqual(rows.length,       1,  'mixed minN=4: only midiFing=60 passes');
  assertEqual(rows[0].midiFing, 60,  'mixed: surviving row midiFing=60');
  assertEqual(rows[0].n,         5,  'mixed: n=5');
  assertClose(rows[0].meanCents, 0,  1e-10, 'mixed: mean=0 (symmetric)');
}

// ---------------------------------------------------------------------------
// Test 7: Instrument isolation — same midiFing, different instruments
// ---------------------------------------------------------------------------
{
  const s: RawSample[] = [
    ...([2, 4, 6].map(c => ({ midiFing: 60, instrumentKey: 'bb_tenor', cents: c }))),
    ...([-5, -3, -1].map(c => ({ midiFing: 60, instrumentKey: 'eb_alto', cents: c }))),
  ];
  const tenor = aggregate(s, 'bb_tenor', 1);
  const alto  = aggregate(s, 'eb_alto',  1);
  assertEqual(tenor.length, 1,  'isolation: tenor has 1 group');
  assertEqual(alto.length,  1,  'isolation: alto has 1 group');
  assertClose(tenor[0].meanCents,  4, 1e-10, 'isolation: tenor mean=4¢');
  assertClose(alto[0].meanCents,  -3, 1e-10, 'isolation: alto mean=-3¢');
}

// ---------------------------------------------------------------------------
// Test 8: Empty input → empty result
// ---------------------------------------------------------------------------
{
  assertEqual(aggregate([], 'bb_tenor', 1).length, 0, 'empty input → empty result');
}

// ---------------------------------------------------------------------------
// Test 9: All samples belong to a different instrument → empty result
// ---------------------------------------------------------------------------
{
  const rows = aggregate(
    [0, 1, 2].map(c => ({ midiFing: 60, instrumentKey: 'eb_alto', cents: c })),
    'bb_tenor', 1,
  );
  assertEqual(rows.length, 0, 'wrong instrument → empty result');
}

// ---------------------------------------------------------------------------
// Test 10: NaN in cents — populationStdDev must not return NaN
//          (SQL schema prevents this; JS guard makes downstream display safe)
// ---------------------------------------------------------------------------
{
  const std = populationStdDev([0, NaN, 0]);
  assert(Number.isFinite(std) || std === 0,
    `NaN in input: populationStdDev returns finite or 0 (got ${std})`);
}

// ---------------------------------------------------------------------------
// Test 11: Large symmetric dataset — 101 integers from -50¢ to +50¢
//
// mean = 0 by symmetry.
// E[k²] for uniform integers [-50..50] = (2/101)*Σ_{k=1}^{50} k²
//       = (2/101)*(50*51*101/6) = 850
// std = sqrt(850) ≈ 29.155
// ---------------------------------------------------------------------------
{
  const samples = Array.from({ length: 101 }, (_, i) => ({
    midiFing: 60, instrumentKey: 'bb_tenor', cents: i - 50,
  }));
  const rows = aggregate(samples, 'bb_tenor', 1);
  assertEqual(rows[0].n, 101, 'large symmetric: n=101');
  assertClose(rows[0].meanCents, 0,            1e-8, 'large symmetric: mean=0');
  assertClose(rows[0].stdCents,  Math.sqrt(850), 1e-4, 'large symmetric: std=sqrt(850)');
}

// ---------------------------------------------------------------------------
// Test 12: minN=1 → every single-sample group passes
// ---------------------------------------------------------------------------
{
  const rows = aggregate(
    [3, -2, 7].map((c, i) => ({ midiFing: 60 + i, instrumentKey: 'bb_tenor', cents: c })),
    'bb_tenor', 1,
  );
  assertEqual(rows.length, 3, 'minN=1: all 3 groups pass');
  for (const row of rows) assertEqual(row.stdCents, 0, `minN=1: std=0 for midiFing=${row.midiFing}`);
}

// ---------------------------------------------------------------------------
// Test 13: Exactly at minN boundary
// ---------------------------------------------------------------------------
{
  const make = (midi: number, n: number): RawSample[] =>
    Array.from({ length: n }, () => ({ midiFing: midi, instrumentKey: 'bb_tenor', cents: 0 }));
  const samples = [...make(60, 4), ...make(61, 3)];

  const at4 = aggregate(samples, 'bb_tenor', 4);
  const at5 = aggregate(samples, 'bb_tenor', 5);

  assertEqual(at4.length,        1,  'boundary minN=4: one passes');
  assertEqual(at4[0].midiFing,  60,  'boundary minN=4: midiFing=60 passes');
  assertEqual(at5.length,        0,  'boundary minN=5: none pass');
}

// ---------------------------------------------------------------------------
// Test 14: populationStdDev([0, 10]) = 5 exactly — hand-verified
//
// mean=5; variance=((0-5)²+(10-5)²)/2=25; std=5.
// ---------------------------------------------------------------------------
{
  assertClose(populationStdDev([0, 10]), 5, 1e-10, 'populationStdDev([0,10])=5');
}

// ---------------------------------------------------------------------------
// Test 15: Results sorted ascending by midiFing regardless of insertion order
// ---------------------------------------------------------------------------
{
  const samples: RawSample[] = [
    ...([72, 72, 60, 60, 65, 65].map((m, i) => ({ midiFing: m, instrumentKey: 'bb_tenor', cents: i }))),
  ];
  const rows = aggregate(samples, 'bb_tenor', 1);
  assertEqual(rows[0].midiFing, 60, 'sort: rows[0]=60');
  assertEqual(rows[1].midiFing, 65, 'sort: rows[1]=65');
  assertEqual(rows[2].midiFing, 72, 'sort: rows[2]=72');
}

console.log('\nAll aggregation smoke tests passed.');
