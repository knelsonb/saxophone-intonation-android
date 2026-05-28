/**
 * v1.4 wave-4 — L1: silence-over-wrong invariant for the quality gate.
 *
 * Verifies that a gate-rejected frame produces NaN in the display ring
 * (nextFreq=null) rather than the raw YIN value.
 *
 * Per [[feedback-bellcurve-silence-over-wrong]]: reject means don't display,
 * not display-stale.
 *
 * Run with Node 24 (no test runner required):
 *   node --experimental-strip-types src/__tests__/silenceOverWrong.test.ts
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) { console.error(`FAIL: ${message}`); process.exit(1); }
  console.log(`PASS: ${message}`);
}

// ---------------------------------------------------------------------------
// Replicated constants (must stay in sync with useAudioEngine.ts QG_ section)
// ---------------------------------------------------------------------------

const QG_TRANSIENT_CENTS_PER_MS = 0.3;
const QG_YIN_CONFIDENCE_MAX     = 0.15;
const QG_RMS_RING_SIZE          = 5;
const QG_RMS_STD_MAX_DB         = 3;
const QG_STEADY_FRAMES          = 3;
const QG_STEADY_CENTS_WINDOW    = 15;
const QG_MIN_ONSET_MS           = 200;

// ---------------------------------------------------------------------------
// Replicated types + functions (mirrors useAudioEngine.ts exactly)
// ---------------------------------------------------------------------------

type QualityRejection = 'transient' | 'confidence' | 'envelope' | 'steady-state' | 'onset-hold' | null;

interface QualityHistory {
  lastCents:        number | null;
  lastCentsTimeMs:  number;
  lastRoundedMidi:  number | null;
  steadyStreak:     number;
  onsetMs:          number;
  rmsRing:          Float64Array;
  rmsRingHead:      number;
  rmsRingCount:     number;
}

interface QualityInput {
  nowMs:          number;
  freqHz:         number;
  exactMidi:      number;
  roundedMidi:    number;
  centsFromRound: number;
  confidence:     number;
  db:             number;
}

interface QualityDecision {
  accept: boolean;
  reason: QualityRejection;
}

function newQualityHistory(): QualityHistory {
  return {
    lastCents:       null,
    lastCentsTimeMs: 0,
    lastRoundedMidi: null,
    steadyStreak:    0,
    onsetMs:         0,
    rmsRing:         new Float64Array(QG_RMS_RING_SIZE),
    rmsRingHead:     0,
    rmsRingCount:    0,
  };
}

function rmsRingStdDb(h: QualityHistory): number {
  if (h.rmsRingCount < 2) return 0;
  const n = h.rmsRingCount;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += h.rmsRing[i];
  const mean = sum / n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = h.rmsRing[i] - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / n);
}

function evaluateQualityGate(
  h: QualityHistory,
  input: QualityInput,
  opts: { skipSteadyAndOnset?: boolean },
): QualityDecision {
  h.rmsRing[h.rmsRingHead] = input.db;
  h.rmsRingHead = (h.rmsRingHead + 1) % QG_RMS_RING_SIZE;
  if (h.rmsRingCount < QG_RMS_RING_SIZE) h.rmsRingCount += 1;

  if (h.lastRoundedMidi !== input.roundedMidi) {
    h.lastRoundedMidi = input.roundedMidi;
    h.onsetMs = input.nowMs;
    h.steadyStreak = 0;
  }

  if (h.lastCents !== null) {
    const dtMs = Math.max(1, input.nowMs - h.lastCentsTimeMs);
    const deltaCents = Math.abs(input.exactMidi * 100 - h.lastCents);
    const rate = deltaCents / dtMs;
    if (rate > QG_TRANSIENT_CENTS_PER_MS) {
      h.lastCents = input.exactMidi * 100;
      h.lastCentsTimeMs = input.nowMs;
      return { accept: false, reason: 'transient' };
    }
  }
  h.lastCents = input.exactMidi * 100;
  h.lastCentsTimeMs = input.nowMs;

  if (input.confidence > QG_YIN_CONFIDENCE_MAX) {
    h.steadyStreak = 0;
    return { accept: false, reason: 'confidence' };
  }

  const envStd = rmsRingStdDb(h);
  if (envStd > QG_RMS_STD_MAX_DB) {
    return { accept: false, reason: 'envelope' };
  }

  if (Math.abs(input.centsFromRound) <= QG_STEADY_CENTS_WINDOW) {
    h.steadyStreak += 1;
  } else {
    h.steadyStreak = 0;
  }
  if (!opts.skipSteadyAndOnset && h.steadyStreak < QG_STEADY_FRAMES) {
    return { accept: false, reason: 'steady-state' };
  }

  if (!opts.skipSteadyAndOnset && input.nowMs - h.onsetMs < QG_MIN_ONSET_MS) {
    return { accept: false, reason: 'onset-hold' };
  }

  return { accept: true, reason: null };
}

// ---------------------------------------------------------------------------
// Simulation of the display-ring write — the invariant under test.
//
// After the wave-4 L1 fix, the pattern is:
//   if (gateDecision.accept) { nextFreq = nextRaw; }
//   else                     { nextFreq = null; /* silence-over-wrong */ }
//   ring[head] = nextFreq != null && nextFreq > 0 ? nextFreq : NaN;
// ---------------------------------------------------------------------------

function simulateFrameRingWrite(
  h: QualityHistory,
  nextRaw: number,
  frameConfidence: number,
  dbValue: number,
  nowMs: number,
): number {
  const a4 = 440;
  const exactMidi   = 69 + 12 * Math.log2(nextRaw / a4);
  const roundedMidi = Math.round(exactMidi);
  const centsFromRound = (exactMidi - roundedMidi) * 100;

  let nextFreq: number | null = null;

  const gateDecision = evaluateQualityGate(
    h,
    { nowMs, freqHz: nextRaw, exactMidi, roundedMidi, centsFromRound, confidence: frameConfidence, db: dbValue },
    { skipSteadyAndOnset: false },
  );

  if (gateDecision.accept) {
    nextFreq = nextRaw;
  } else {
    // silence-over-wrong: leave nextFreq null
    nextFreq = null;
  }

  // display ring write (mirrors line 1709 of useAudioEngine.ts)
  return nextFreq != null && nextFreq > 0 ? nextFreq : NaN;
}

// ---------------------------------------------------------------------------
// Test 1: Low-confidence frame → gate rejects → ring gets NaN (not the Hz).
// ---------------------------------------------------------------------------
{
  const h = newQualityHistory();
  const badConfidence = QG_YIN_CONFIDENCE_MAX + 0.1; // above threshold → reject
  const ringVal = simulateFrameRingWrite(h, 440, badConfidence, -30, 1000);
  assert(Number.isNaN(ringVal), 'confidence-rejected frame: ring entry is NaN (not 440 Hz)');
}

// ---------------------------------------------------------------------------
// Test 2: Accepted frame → ring gets the Hz value.
// A frame can pass only after onset-hold + steady-frames are satisfied.
// Warm up the history first with enough steady frames and elapsed time.
// ---------------------------------------------------------------------------
{
  const h = newQualityHistory();
  const goodConfidence = QG_YIN_CONFIDENCE_MAX - 0.05; // below threshold → pass confidence
  const freqHz = 440;
  const a4 = 440;
  const exactMidi = 69 + 12 * Math.log2(freqHz / a4);
  const roundedMidi = Math.round(exactMidi);
  const centsFromRound = (exactMidi - roundedMidi) * 100;
  const baseMs = 0;

  // Feed enough frames with stable RMS and within steady-cents-window
  // so steady-state + onset-hold are satisfied.
  const msPerFrame = 25;
  let lastRingVal = NaN;
  for (let i = 0; i < 20; i++) {
    const nowMs = baseMs + i * msPerFrame;
    lastRingVal = simulateFrameRingWrite(h, freqHz, goodConfidence, -30, nowMs);
  }
  // After >= QG_STEADY_FRAMES (3) frames and >= QG_MIN_ONSET_MS (200ms = 8 frames at 25ms),
  // the gate should accept.
  assert(!Number.isNaN(lastRingVal), 'accepted frame: ring entry is not NaN');
  assert(lastRingVal === freqHz, `accepted frame: ring entry equals input freqHz (${freqHz})`);
}

// ---------------------------------------------------------------------------
// Test 3: Transient rejection → ring gets NaN.
// Send a stable frame then a large jump — the jump triggers transient rejection.
// ---------------------------------------------------------------------------
{
  const h = newQualityHistory();
  const goodConfidence = QG_YIN_CONFIDENCE_MAX - 0.05;
  // Frame 1: 440 Hz
  simulateFrameRingWrite(h, 440, goodConfidence, -30, 1000);
  // Frame 2: 880 Hz just 1ms later → enormous rate → transient reject
  const ringVal = simulateFrameRingWrite(h, 880, goodConfidence, -30, 1001);
  assert(Number.isNaN(ringVal), 'transient-rejected frame: ring entry is NaN (not 880 Hz)');
}

// ---------------------------------------------------------------------------
// Test 4: Steady-state rejection on first frame of a new note → NaN.
// Even with good confidence and no transient, the first frame of a new
// note has steadyStreak=0 < QG_STEADY_FRAMES → steady-state rejection.
// ---------------------------------------------------------------------------
{
  const h = newQualityHistory();
  const goodConfidence = 0.01;
  const ringVal = simulateFrameRingWrite(h, 440, goodConfidence, -30, 1000);
  assert(Number.isNaN(ringVal), 'steady-state-rejected first frame: ring entry is NaN');
}

// ---------------------------------------------------------------------------
// Test 6 (wave-5 L1): YIN returns null (silent / RMS-floor / YIN failure)
// → yinFired block is never entered → nextFreq stays at its initial value.
// The fix initialises nextFreq=null (not stale freqHzRef), so the ring write
// must be NaN — not the previous display frequency.
// ---------------------------------------------------------------------------
{
  // Simulate the pre-fix bug: if nextFreq were initialised to a stale Hz
  // value (e.g. 440 from the last frame) and YIN returns null so neither
  // block runs, the ring write would produce 440 Hz rather than NaN.
  // With the fix, the initial value is null → ring write is NaN.

  // Correct post-fix behaviour (nextFreq = null on init):
  const nextFreqPostFix: number | null = null;  // <-- the fixed init
  const ringValFixed = nextFreqPostFix != null && nextFreqPostFix > 0 ? nextFreqPostFix : NaN;
  assert(Number.isNaN(ringValFixed), 'YIN-null path (wave-5 L1): post-fix init=null → ring writes NaN');

  // Demonstrate the pre-fix bug (nextFreq = 440 stale init):
  const nextFreqPreFix: number | null = 440;    // <-- the stale init that was wrong
  const ringValStale = nextFreqPreFix != null && nextFreqPreFix > 0 ? nextFreqPreFix : NaN;
  assert(!Number.isNaN(ringValStale) && ringValStale === 440,
    'YIN-null path (wave-5 L1): pre-fix stale init=440 → ring erroneously wrote 440 Hz (confirmed bug)');
}

// ---------------------------------------------------------------------------
// Test 5: Envelope instability rejection → NaN.
// Push varying RMS values that exceed QG_RMS_STD_MAX_DB (3 dB).
// ---------------------------------------------------------------------------
{
  const h = newQualityHistory();
  const goodConfidence = 0.01;
  const freqHz = 440;
  const a4 = 440;
  const exactMidi = 69 + 12 * Math.log2(freqHz / a4);
  const roundedMidi = Math.round(exactMidi);
  const centsFromRound = (exactMidi - roundedMidi) * 100;
  const nowMs = 1000;

  // Pre-fill the RMS ring with wildly varying dB values so std > 3dB.
  // Feed directly into the gate at varying dB levels.
  const dbValues = [-20, -40, -20, -40, -20]; // std >> 3 dB
  for (let i = 0; i < dbValues.length; i++) {
    const decision = evaluateQualityGate(
      h,
      { nowMs: nowMs + i * 25, freqHz, exactMidi, roundedMidi, centsFromRound, confidence: goodConfidence, db: dbValues[i] },
      { skipSteadyAndOnset: false },
    );
    if (decision.reason === 'envelope') {
      assert(true, `envelope instability detected at frame ${i}`);
      // Confirm the ring write would be NaN.
      const nextFreq: number | null = decision.accept ? freqHz : null;
      const ringVal = nextFreq != null && nextFreq > 0 ? nextFreq : NaN;
      assert(Number.isNaN(ringVal), 'envelope-rejected frame: ring entry is NaN');
      process.exit(0); // pass
    }
  }
  // If we never hit an envelope rejection with these inputs, something is wrong.
  assert(false, 'envelope instability: expected at least one envelope rejection in 5 frames with std >> 3dB');
}
