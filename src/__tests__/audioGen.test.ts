/**
 * audioGen.test.ts — metronome click WAV synthesis (src/audioGen.ts).
 *
 * Legacy node runner (audioGen.ts is pure — no native imports). btoa (used by
 * buildClickWavBase64's encoder) and Buffer (decode here) are node globals.
 *
 * WHY: buildClickWavBase64 generates the AUDIBLE metronome click. A malformed,
 * silent, or non-decaying buffer = a silent / wrong / buzzing metronome — a
 * silence-over-wrong failure (a metronome that ticks wrong is worse than none).
 * This guards that each click is a valid, non-silent, PERCUSSIVE (decaying) WAV.
 *
 * SCOPE: byte/signal structure only. Actual ExoPlayer playback is on-device.
 */

import { buildClickWavBase64, CLICK_SAMPLE_RATE } from '../audioGen.ts';

// ---------------------------------------------------------------------------
// Assert helpers (legacy idiom — mirrors pitchTones.test.ts / storage.test.ts)
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) { console.error(`FAIL: ${message}`); process.exit(1); }
  console.log(`PASS: ${message}`);
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Decode a base64 WAV → header fields + signed int16 PCM samples
// ---------------------------------------------------------------------------

interface DecodedWav {
  bytes: Buffer;
  dataSize: number;
  samples: number[];
}

function decodeWav(b64: string): DecodedWav {
  assert(typeof b64 === 'string' && b64.length > 0, 'click WAV is a non-empty base64 string');
  const bytes = Buffer.from(b64, 'base64');
  assert(bytes.length > 44, 'click WAV has a 44-byte header plus PCM data');

  const ascii = (off: number, len: number): string =>
    String.fromCharCode(...bytes.subarray(off, off + len));
  assertEqual(ascii(0, 4), 'RIFF', 'RIFF magic');
  assertEqual(ascii(8, 4), 'WAVE', 'WAVE magic');
  assertEqual(ascii(12, 4), 'fmt ', 'fmt sub-chunk');
  assertEqual(ascii(36, 4), 'data', 'data sub-chunk');

  assertEqual(bytes.readUInt32LE(16), 16, 'fmt size == 16 (PCM)');
  assertEqual(bytes.readUInt16LE(20), 1, 'audio format == PCM (1)');
  assertEqual(bytes.readUInt16LE(22), 1, 'channels == mono (1)');
  assertEqual(bytes.readUInt32LE(24), CLICK_SAMPLE_RATE, 'sample rate == CLICK_SAMPLE_RATE');
  assertEqual(bytes.readUInt32LE(28), CLICK_SAMPLE_RATE * 2, 'byte rate == sr * 1ch * 2bytes');
  assertEqual(bytes.readUInt16LE(32), 2, 'block align == 2');
  assertEqual(bytes.readUInt16LE(34), 16, 'bits per sample == 16');

  const dataSize = bytes.readUInt32LE(40);
  assertEqual(dataSize, bytes.length - 44, 'declared data size matches PCM length');

  const n = dataSize / 2;
  const samples: number[] = new Array(n);
  for (let i = 0; i < n; i++) samples[i] = bytes.readInt16LE(44 + i * 2);
  return { bytes, dataSize, samples };
}

function maxAbs(samples: number[]): number {
  let m = 0;
  for (const s of samples) { const a = Math.abs(s); if (a > m) m = a; }
  return m;
}
function energy(samples: number[]): number {
  let e = 0;
  for (const s of samples) e += s * s;
  return e;
}
// Count sign changes over [start, end) — a coarse pitch proxy (more crossings =
// higher fundamental). Skips zero samples so a brief zero doesn't double-count.
function zeroCrossings(samples: number[], start: number, end: number): number {
  let count = 0;
  let prevSign = 0;
  for (let i = start; i < end; i++) {
    const s = samples[i];
    if (s === 0) continue;
    const sign = s > 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign) count++;
    prevSign = sign;
  }
  return count;
}

assertEqual(CLICK_SAMPLE_RATE, 44100, 'CLICK_SAMPLE_RATE == 44100');

// Expected: ~25 ms at 44.1 kHz → round(0.025 * 44100) = 1103 samples.
const EXPECTED_SAMPLES = Math.round(0.025 * CLICK_SAMPLE_RATE);
assertEqual(EXPECTED_SAMPLES, 1103, 'expected click length is 1103 samples (~25 ms)');

// ---------------------------------------------------------------------------
// Per-kind structural + signal guarantees
// ---------------------------------------------------------------------------

const decoded: Record<'accent' | 'normal', DecodedWav> = {
  accent: decodeWav(buildClickWavBase64('accent')),
  normal: decodeWav(buildClickWavBase64('normal')),
};

for (const kind of ['accent', 'normal'] as const) {
  const w = decoded[kind];

  // Right length (a ~25 ms tick, not a drone or a single sample).
  assertEqual(w.samples.length, EXPECTED_SAMPLES, `${kind}: ${EXPECTED_SAMPLES} PCM samples`);

  // NON-SILENT: the body must swing near full scale. peak = 32767*0.99 ≈ 32439;
  // the first sine peak (lightly decayed) lands around ~30000. A regression
  // that zeroed the buffer (silent metronome) or collapsed the gain fails here.
  const peak = maxAbs(w.samples);
  assert(peak > 20000, `${kind}: click is audibly loud (max |sample| ${peak} > 20000)`);
  assert(peak <= 32767, `${kind}: no int16 overflow (max |sample| ${peak} <= 32767)`);

  // STARTS at zero — a sine begins at 0, so there is no DC click/pop at sample 0.
  assertEqual(w.samples[0], 0, `${kind}: first sample is 0 (no attack-edge pop)`);

  // DECAYS to silence: it's a percussive click, NOT a sustained tone burst.
  // The exponential envelope is ~0 by the 25 ms tail.
  const tail = w.samples.slice(w.samples.length - 50);
  assert(maxAbs(tail) <= 4, `${kind}: tail has decayed to ~silence (max |tail| ${maxAbs(tail)} <= 4)`);

  // No clipping/buzz: a sine·0.99·envelope must never rail to the int16 limits.
  // (maxAbs <= 32767 alone is loose — a gain bump that railed would clamp to
  // exactly 32767 and still pass; an explicit rail count catches the buzz.)
  const railed = w.samples.filter((s) => s === 32767 || s === -32768).length;
  assertEqual(railed, 0, `${kind}: no clipped/railed samples (clean sine, no buzz)`);

  // Independent absolute duration bounds — NOT derived from the production
  // literal, so a duration drift (tick → long tone) can't slip through in
  // lockstep. A tick is 10..30 ms.
  assert(
    w.samples.length >= 0.010 * CLICK_SAMPLE_RATE && w.samples.length <= 0.030 * CLICK_SAMPLE_RATE,
    `${kind}: click is a 10..30 ms tick (${w.samples.length} samples)`,
  );
}

// ---------------------------------------------------------------------------
// Cross-kind: accent and normal are distinct, and accent decays faster
// ---------------------------------------------------------------------------

assert(
  buildClickWavBase64('accent') !== buildClickWavBase64('normal'),
  'accent and normal clicks are different buffers',
);

// Same duration, but the accent's faster decay (0.0012 s vs 0.0020 s) makes its
// total energy envelope-dominated and strictly lower (~0.6×). Swapping the two
// decay constants flips this → fails. (Pitch contrast is pinned separately below.)
const eAccent = energy(decoded.accent.samples);
const eNormal = energy(decoded.normal.samples);
assert(eAccent < eNormal,
  `accent decays faster → less energy than normal (accent ${eAccent} < normal ${eNormal})`);

// Pitch CONTRAST is the entire point of two click kinds: the accent must be the
// higher-pitched tick (4 kHz vs 1.5 kHz). Energy alone would NOT catch a
// frequency swap (it would stay green while the downbeat went LOW) — count
// zero-crossings over the first 3 ms, where both clicks are well above silence.
const ZC_WINDOW = Math.round(0.003 * CLICK_SAMPLE_RATE); // ~132 samples
const zcAccent = zeroCrossings(decoded.accent.samples, 0, ZC_WINDOW);
const zcNormal = zeroCrossings(decoded.normal.samples, 0, ZC_WINDOW);
assert(zcAccent > zcNormal * 1.5,
  `accent is higher-pitched than normal (zero-crossings ${zcAccent} > 1.5 * ${zcNormal})`);

// Determinism: same input → byte-identical output (safe to cache the file).
assertEqual(
  buildClickWavBase64('accent'),
  buildClickWavBase64('accent'),
  'buildClickWavBase64 is deterministic',
);

console.log('\nAll audioGen.ts click-synthesis tests passed.');
