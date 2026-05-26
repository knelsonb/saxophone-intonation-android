/**
 * YIN pitch detector — pure TypeScript port of `yin_pitch` from
 * sax_audio_engine.py (desktop v0.5.6).
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
 * Sauron feeds whatever expo-audio accumulates; the function silently returns
 * null for frames shorter than 2 × tmin.
 *
 * COMPLEXITY
 * ----------
 * The difference function is computed naively as an explicit double loop
 * (O(N × tmax)). For the expected block sizes (1024–16 384 samples) and a
 * tmax driven by MIN_FREQ = 27 Hz (≈1633 samples at 44.1k), the worst-case
 * work is ~26 M multiply-adds per call — fast enough inside the JS audio
 * callback at ~46 ms hop intervals. If performance becomes an issue the
 * difference function can be replaced with the FFT-based O(N log N) variant.
 *
 * PARITY WITH DESKTOP
 * -------------------
 * The desktop uses NumPy list-comprehension shorthand:
 *   diff[t] = dot(sig[:N-t] - sig[t:N], sig[:N-t] - sig[t:N])
 * which is identical to the explicit loop below. Parabolic interpolation is
 * also preserved verbatim (same formula, same edge guard).
 */

const MIN_FREQ_HZ = 27.0;   // below lowest concert pitch; matches desktop
const MAX_FREQ_HZ = 1400.0; // well above saxophone top; matches desktop

export interface YinResult {
  freqHz: number;
  confidence: number; // aperiodicity in [0, 1]; lower = more periodic
}

/**
 * Estimate the fundamental frequency of a monophonic PCM frame using YIN.
 *
 * @param signal     Float32Array of normalised PCM samples (any amplitude)
 * @param sampleRate Sample rate in Hz (typically 44100)
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

  // Frame is too short to search the required lag range.
  if (tmax <= tmin) {
    return null;
  }

  // --- Step 1: difference function -------------------------------------------
  // diff[t] = Σ (signal[j] - signal[j+t])² for j in [0, N-t)
  // Allocated to tmax + 1 to match the desktop's indexing (diff[0] is unused).
  const diff: Float64Array = new Float64Array(tmax + 1);
  for (let t = 1; t <= tmax; t++) {
    let sum = 0.0;
    const len: number = N - t;
    for (let j = 0; j < len; j++) {
      const d: number = signal[j] - signal[j + t];
      sum += d * d;
    }
    diff[t] = sum;
  }

  // --- Step 2: cumulative mean normalised difference (CMND) ------------------
  // cmnd[0] = 1 by convention (never used in threshold search).
  // cmnd[t] = diff[t] * t / Σ diff[1..t]
  const cmnd: Float64Array = new Float64Array(tmax + 1);
  cmnd[0] = 1.0;
  let runningSum = 0.0;
  for (let t = 1; t <= tmax; t++) {
    runningSum += diff[t];
    cmnd[t] = runningSum > 0.0 ? (diff[t] * t) / runningSum : 1.0;
  }

  // --- Step 3: absolute threshold + local minimum walk -----------------------
  // Scan from tmin upward; accept the first tau where cmnd < thr, then walk
  // forward to the local minimum (handles cases where the dip slopes down past
  // thr before reaching its floor).
  let tau = -1;
  let mv = 1.0;
  let t = tmin;
  while (t < tmax) {
    if (cmnd[t] < thr) {
      // Walk to local minimum.
      while (t + 1 < tmax && cmnd[t + 1] < cmnd[t]) {
        t++;
      }
      tau = t;
      mv = cmnd[t];
      break;
    }
    t++;
  }

  // --- Step 4: global minimum fallback ---------------------------------------
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

  // --- Step 5: parabolic interpolation for sub-sample precision --------------
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

  if (tau <= 0) {
    return null;
  }

  return {
    freqHz: sampleRate / tau,
    confidence: mv,
  };
}
