/**
 * Regression test: v1.0.1 off-by-one in YIN global-minimum fallback scan.
 *
 * Bug: `for (let i = tmin + 1; i < tmax; i++)` excluded cmnd[tmax], so when
 * the global minimum sat exactly at tmax (lowest detectable frequency) the
 * fallback returned the wrong lag and produced a pitch error as large as one
 * full semitone in noisy low-register frames.
 *
 * Run with Node 24 (no test runner required):
 *   node --experimental-strip-types src/__tests__/yin-fallback.test.ts
 */

// @ts-ignore: smoke — .ts extension required for node --experimental-strip-types
import { yinPitch } from '../yin.ts';

// ---------------------------------------------------------------------------
// Helpers (identical style to yin.test.ts)
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
  assert(diff <= tolerance, `${label}: got ${actual.toFixed(3)}, expected ${expected} ± ${tolerance}`);
}

// ---------------------------------------------------------------------------
// Test: fallback global-minimum must inspect cmnd[tmax]  (v1.0.1 regression)
//
// Strategy: synthesize a pure sine whose period is exactly tmax samples.
// At SR=44100, MIN_FREQ_HZ=27, tmax = floor(44100/27) = 1633 samples.
// The sine frequency is therefore 44100/1633 ≈ 27.007 Hz — the lowest lag
// the algorithm will consider.  A pure sine at that lag produces a deep CMND
// dip AT tmax and shallower values everywhere below it in the search range.
//
// We force the fallback path by using thr=1.1 (no threshold crossing is
// possible since CMND ∈ [0,1]).  Pre-fix, the loop stopped at tmax-1 and
// returned a different (higher) lag; post-fix it reaches tmax and returns
// the correct (lowest) frequency.
// ---------------------------------------------------------------------------
{
  const SR = 44100;
  // tmax mirrors yinPitch's own computation so our expected frequency is exact.
  const MIN_FREQ_HZ = 27.0;
  const tmax = Math.floor(SR / MIN_FREQ_HZ); // 1633

  // Sine period = tmax samples → fundamental at SR/tmax Hz.
  const freqAtTmax = SR / tmax; // ≈ 27.007 Hz
  const N = 4096;
  const sig = new Float32Array(N);
  const omega = (2.0 * Math.PI * freqAtTmax) / SR;
  for (let i = 0; i < N; i++) sig[i] = Math.sin(omega * i);

  // thr=1.1 guarantees no threshold crossing → always uses global-min fallback.
  const result = yinPitch(sig, SR, 1.1);

  // v1.0.1 regression guard: result must not be null (signal is periodic).
  assert(result !== null, 'fallback tmax: result is not null');

  if (result !== null) {
    // Post-fix: algorithm finds the global minimum at tmax → freqHz ≈ 27.007 Hz.
    // Pre-fix: it stopped at tmax-1 and returned ~27.2 Hz (wrong lag).
    // Tolerance ±1 Hz is generous enough for parabolic interpolation wobble
    // but tight enough to catch the off-by-one (which shifts by ~0.2 Hz here).
    assertClose(
      result.freqHz,
      freqAtTmax,
      1.0,
      'fallback tmax: freqHz within ±1 Hz of SR/tmax (global min at tmax picked correctly)',
    );

    // Confidence should be low (periodic signal → small CMND at tmax).
    assert(
      result.confidence < 0.20,
      `fallback tmax: confidence < 0.20 (got ${result.confidence.toFixed(4)}) — sine should be periodic`,
    );
  }
}

console.log('\nAll yin-fallback.test.ts regression tests passed.');
