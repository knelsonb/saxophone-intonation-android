/**
 * Vendored radix-2 Cooley–Tukey FFT.
 *
 * Sole purpose: feed YIN's autocorrelation step (see yin.ts). The desktop
 * companion at sax_audio_engine.py:258-263 uses numpy's rfft/irfft to compute
 * the linear autocorrelation of a windowed signal in O(N log N) instead of
 * the naive O(N × tmax) difference-function loop. This module ports the same
 * trick to TypeScript without pulling in a dependency — Hermes can't load
 * Node-native FFT modules, and a pure-JS lib would bloat the bundle.
 *
 * Numerical parity: results match numpy.fft to within IEEE-754 double-rounding
 * (no algorithmic difference — same butterflies, same twiddle factors).
 *
 * Scratch / twiddle reuse: FFT size is determined by signal length and stays
 * constant across calls for any given audio engine config (N = 4096 → M = 8192
 * in our case). We cache the twiddle tables and bit-reversal permutation per M
 * so the second call onward pays only the butterfly cost.
 */

interface FftCache {
  M: number;
  /** Cos(−2π k / M) for k in [0, M/2). */
  cosT: Float64Array;
  /** Sin(−2π k / M) for k in [0, M/2). Forward FFT uses negative sign. */
  sinT: Float64Array;
  /** Bit-reversal permutation: brev[i] = bit-reversed index of i. */
  brev: Int32Array;
  /** Scratch real buffer of length M, zero-padded across calls. */
  re: Float64Array;
  /** Scratch imag buffer of length M, zero-padded across calls. */
  im: Float64Array;
}

const _cache = new Map<number, FftCache>();

function getCache(M: number): FftCache {
  let c = _cache.get(M);
  if (c) return c;

  if ((M & (M - 1)) !== 0 || M < 2) {
    throw new Error(`fft: M=${M} is not a power of two ≥ 2`);
  }

  const half = M >> 1;
  const cosT = new Float64Array(half);
  const sinT = new Float64Array(half);
  const TWO_PI_OVER_M = (2 * Math.PI) / M;
  for (let k = 0; k < half; k++) {
    cosT[k] = Math.cos(-TWO_PI_OVER_M * k);
    sinT[k] = Math.sin(-TWO_PI_OVER_M * k);
  }

  const brev = new Int32Array(M);
  const bits = Math.log2(M) | 0;
  for (let i = 0; i < M; i++) {
    let r = 0;
    let x = i;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>>= 1;
    }
    brev[i] = r;
  }

  c = { M, cosT, sinT, brev, re: new Float64Array(M), im: new Float64Array(M) };
  _cache.set(M, c);
  return c;
}

/**
 * In-place radix-2 FFT. Caller fills re/im (length M, power of two). The
 * inverse pass uses the conjugate-trick (swap re/im, forward FFT, swap and
 * divide) so we share one twiddle table for both directions.
 */
function fftInPlace(re: Float64Array, im: Float64Array, cache: FftCache, inverse: boolean): void {
  const { M, cosT, sinT, brev } = cache;

  // Bit-reversal permutation. Swap each pair only once (i < brev[i]).
  for (let i = 0; i < M; i++) {
    const j = brev[i];
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  // Inverse via conjugation: flip imag, forward FFT, flip imag, then scale.
  if (inverse) {
    for (let i = 0; i < M; i++) im[i] = -im[i];
  }

  // Butterfly passes. `size` doubles each stage; `step` indexes the twiddle
  // table at the granularity of the current stage.
  for (let size = 2; size <= M; size <<= 1) {
    const halfSize = size >> 1;
    const step = M / size;
    for (let i = 0; i < M; i += size) {
      let tw = 0;
      for (let j = i; j < i + halfSize; j++) {
        const wr = cosT[tw];
        const wi = sinT[tw];
        const k = j + halfSize;
        const tr = wr * re[k] - wi * im[k];
        const ti = wr * im[k] + wi * re[k];
        re[k] = re[j] - tr;
        im[k] = im[j] - ti;
        re[j] += tr;
        im[j] += ti;
        tw += step;
      }
    }
  }

  if (inverse) {
    const invM = 1 / M;
    for (let i = 0; i < M; i++) {
      re[i] *= invM;
      im[i] = -im[i] * invM;
    }
  }
}

/**
 * Compute the linear autocorrelation r[τ] = Σ_{j} x[j] · x[j+τ] for τ in
 * [0, tmax], using a zero-padded FFT to avoid the wraparound of circular
 * correlation. Mirrors numpy's rfft → |·|² → irfft path used by the desktop.
 *
 * @param signal Real-valued input. Only the first N samples are read.
 * @param N Number of samples to consume from `signal`.
 * @param tmax Maximum lag to compute (inclusive). The returned array has
 *             length tmax + 1; index 0 is the energy of the signal.
 * @returns Float64Array of length tmax + 1. Reused across calls only via
 *          the caller — we allocate fresh here because tmax can vary per
 *          call (sample rate dependent).
 */
export function autocorrelation(signal: ArrayLike<number>, N: number, tmax: number): Float64Array {
  // Linear autocorrelation requires zero-padding to M ≥ 2N − 1; rounded to
  // the next power of two so the FFT stays radix-2.
  const need = 2 * N - 1;
  let M = 1;
  while (M < need) M <<= 1;
  if (M < 2) M = 2;

  const cache = getCache(M);
  const { re, im } = cache;

  // Copy signal into re[0..N), zero-pad rest. We zero only the slots we
  // dirtied last time (everything in M) because previous calls may have
  // left non-zero values from the IFFT.
  for (let i = 0; i < N; i++) re[i] = signal[i];
  for (let i = N; i < M; i++) re[i] = 0;
  for (let i = 0; i < M; i++) im[i] = 0;

  fftInPlace(re, im, cache, false);

  // Replace X with |X|² (real, imag→0). After this, the inverse FFT yields
  // the autocorrelation as the real part.
  for (let i = 0; i < M; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }

  fftInPlace(re, im, cache, true);

  const out = new Float64Array(tmax + 1);
  for (let t = 0; t <= tmax; t++) out[t] = re[t];
  return out;
}
