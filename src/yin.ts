/**
 * YIN pitch detector — TypeScript port of `yin_pitch` from
 * sax_audio_engine.py (desktop v0.5.6+).
 *
 * Algorithm reference: de Cheveigné & Kawahara (2002) "YIN, a fundamental
 * frequency estimator for speech and music", JASA 111(4).
 *
 * MINIMUM BUFFER SIZE
 * -------------------
 * YIN needs at least two full periods to build a reliable autocorrelation.
 * The saxophone's lowest sounding pitch on Eb alto is Db3 (concert Bb2,
 * ~116 Hz). At 44 100 Hz that is a period of ~380 samples; two periods ≈ 760
 * samples. Use 1024 as the practical floor so the tmax probe window is wide
 * enough.  For Bb tenor the lowest note is Ab2 (~104 Hz) → period ~425
 * samples → same 1024 floor applies.
 *
 * COMPLEXITY
 * ----------
 * The difference function d(τ) = Σ_{j∈[0,N−τ)} (x[j] − x[j+τ])² is computed
 * via the desktop's bit-perfect FFT trick (sax_audio_engine.py:258-273):
 *
 *   r[τ]   = Σ x[j] · x[j+τ]      — linear autocorrelation, FFT in O(N log N)
 *   E1[τ]  = Σ_{j<N−τ} x[j]²       — left-window energy, O(1) via prefix sum
 *   E2[τ]  = Σ_{j≥τ}  x[j]²        — right-window energy, O(1) via prefix sum
 *   d[τ]   = E1[τ] + E2[τ] − 2·r[τ]
 *
 * This is algebraically identical to the naive double loop — expanding
 * (x[j] − x[j+τ])² gives x[j]² + x[j+τ]² − 2·x[j]·x[j+τ], the three terms
 * above. The naive "d ≈ 2·(r[0] − r[τ])" shortcut is biased for windowed
 * signals; we use the full window-correct form like the desktop.
 *
 * Worst case for N = 4096, tmax ≈ 1778: ~7.3 M mul-adds (naive) → ~100 K
 * (FFT). ~70× speedup, restoring 40 Hz pitch detection on the audio thread.
 *
 * PARITY WITH DESKTOP
 * -------------------
 * Numerically identical to the desktop modulo IEEE-754 rounding (same FFT
 * twiddles, same energy expansion, same threshold scan, same parabolic
 * interpolation). The existing yin smoke tests pass with the same ±Hz
 * tolerances.
 */

// @ts-ignore: smoke — .ts extension required for node --experimental-strip-types
import { autocorrelation } from './fft.ts';

const MIN_FREQ_HZ = 27.0;   // below lowest concert pitch; matches desktop
const MAX_FREQ_HZ = 1400.0; // well above saxophone top; matches desktop

// Module-level scratch buffers — sized for the worst case we'd realistically
// see (tmax around 96000 / 27 ≈ 3556 + slack). Reused across calls so YIN
// doesn't allocate ~28 KB per invocation; at 40 Hz that was 1.1 MB/sec of GC
// churn on the audio path.
const MAX_TMAX_SLOTS = 4096;
const _diffScratch = new Float64Array(MAX_TMAX_SLOTS);
const _cmndScratch = new Float64Array(MAX_TMAX_SLOTS);
// Prefix sum of x² has length N+1; we cap at RING_BUFFER_CAPACITY (4096) + 1.
const _prefixSqScratch = new Float64Array(4096 + 1);
// Float64 view of the input signal for stable cumulative sums at large N
// (matches the desktop's astype(np.float64) at sax_audio_engine.py:257).
const _signal64Scratch = new Float64Array(4096);

export interface YinResult {
  freqHz: number;
  confidence: number; // aperiodicity in [0, 1]; lower = more periodic
}

/**
 * Estimate the fundamental frequency of a monophonic PCM frame using YIN.
 *
 * @param signal     Float32Array of normalised PCM samples (any amplitude)
 * @param sampleRate Sample rate in Hz (typically 48000 or 44100)
 * @param thr        Aperiodicity threshold (default 0.10, matching desktop
 *                   "normal" filter mode). Lower values are stricter.
 * @returns          { freqHz, confidence } on success, or null when the frame
 *                   is too short or no pitch is detectable below the threshold
 *                   after exhausting the search range.
 */
export function yinPitch(
  signal: Float32Array,
  sampleRate: number,
  thr: number = 0.10,
): YinResult | null {
  const N: number = signal.length;
  const tmin: number = Math.max(1, Math.floor(sampleRate / MAX_FREQ_HZ));
  const tmax: number = Math.min(Math.floor(N / 2), Math.floor(sampleRate / MIN_FREQ_HZ));

  if (tmax <= tmin) return null;
  if (tmax + 1 > MAX_TMAX_SLOTS) return null;
  if (N + 1 > _prefixSqScratch.length) return null;
  if (N > _signal64Scratch.length) return null;

  // --- Step 0: widen signal to fp64 ------------------------------------------
  // Matches the desktop's astype(np.float64). The cumulative-energy sums
  // below benefit from the extra precision when N is large; fp32 would
  // accumulate rounding error linearly in N.
  const x: Float64Array = _signal64Scratch;
  for (let i = 0; i < N; i++) x[i] = signal[i];

  // --- Step 1: linear autocorrelation via FFT --------------------------------
  // r[t] = Σ_{j} x[j] · x[j+t] for t in [0, tmax]. The FFT is zero-padded
  // to ≥ 2N − 1 so the circular convolution gives the correct linear result.
  const r = autocorrelation(x, N, tmax);

  // --- Step 2: prefix sum of x² for O(1) per-τ energies ----------------------
  // S[0] = 0; S[k] = Σ_{j<k} x[j]² for k in [1, N].
  const S: Float64Array = _prefixSqScratch;
  S[0] = 0.0;
  for (let k = 0; k < N; k++) {
    const v = x[k];
    S[k + 1] = S[k] + v * v;
  }

  // --- Step 3: difference function ------------------------------------------
  // d[τ] = E1[τ] + E2[τ] − 2·r[τ]
  //   E1[τ] = S[N − τ]           (energy of x[0..N−τ))
  //   E2[τ] = S[N] − S[τ]        (energy of x[τ..N))
  const diff: Float64Array = _diffScratch;
  const totalEnergy = S[N];
  for (let t = 0; t <= tmax; t++) {
    const E1 = S[N - t];
    const E2 = totalEnergy - S[t];
    diff[t] = E1 + E2 - 2.0 * r[t];
  }

  // --- Step 4: cumulative mean normalised difference (CMND) -----------------
  // cmnd[0] = 1 by convention (never used in threshold search).
  // cmnd[t] = diff[t] · t / Σ_{k=1..t} diff[k]
  const cmnd: Float64Array = _cmndScratch;
  cmnd[0] = 1.0;
  let runningSum = 0.0;
  for (let t = 1; t <= tmax; t++) {
    runningSum += diff[t];
    cmnd[t] = runningSum > 0.0 ? (diff[t] * t) / runningSum : 1.0;
  }

  // --- Step 5: absolute threshold + local minimum walk ----------------------
  // Scan from tmin upward; accept the first tau where cmnd < thr, then walk
  // forward to the local minimum (handles cases where the dip slopes down past
  // thr before reaching its floor).
  let tau = -1;
  let mv = 1.0;
  let t = tmin;
  while (t < tmax) {
    if (cmnd[t] < thr) {
      while (t + 1 < tmax && cmnd[t + 1] < cmnd[t]) {
        t++;
      }
      tau = t;
      mv = cmnd[t];
      break;
    }
    t++;
  }

  // --- Step 6: global minimum fallback --------------------------------------
  // No lag cleared the threshold; pick the smallest CMND value in range.
  // This matches the desktop's argmin fallback and ensures we always return
  // a candidate (caller decides whether to trust it based on confidence).
  if (tau === -1) {
    let minVal = cmnd[tmin];
    let minIdx = tmin;
    for (let i = tmin + 1; i < tmax; i++) {
      if (cmnd[i] < minVal) {
        minVal = cmnd[i];
        minIdx = i;
      }
    }
    tau = minIdx;
    mv = minVal;
  }

  // --- Step 7: parabolic interpolation for sub-sample precision -------------
  // Refines tau by fitting a parabola to the three CMND values around the
  // winner. The denominator guard (d !== 0) prevents division by zero when
  // the three values are collinear.
  if (tau > 1 && tau < tmax - 1) {
    const s0: number = cmnd[tau - 1];
    const s1: number = cmnd[tau];
    const s2: number = cmnd[tau + 1];
    const d: number = 2.0 * s1 - s0 - s2;
    if (d !== 0) {
      tau += 0.5 * (s0 - s2) / d;
    }
  }

  // Clamp tau to ≥ 1 before the division: parabolic interpolation can drag
  // tau below 1.0 in pathological cases, which would inflate sr / tau into a
  // nonsense high frequency. Matches the desktop's safety check.
  if (tau < 1.0) return null;

  return {
    freqHz: sampleRate / tau,
    confidence: mv,
  };
}
