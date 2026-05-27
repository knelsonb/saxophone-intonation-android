/**
 * audioGen.ts — shared WAV synthesis helpers.
 *
 * v1.1 — the drone WAV synth section is gone. The drone is now driven by
 * @local/raw-audio-output (TinySoundFont). This file is back to its
 * original purpose: short percussive metronome clicks + a single MIDI→Hz
 * helper used across the codebase.
 *
 * Approach: synthesize 16-bit PCM, slap a RIFF/WAVE header on it, return a
 * base64 string. Caller writes it to the cache directory and hands the
 * resulting `file://` URI to expo-audio's `createAudioPlayer` (Android's
 * ExoPlayer rejects `data:` URIs).
 *
 * All generators below produce mono int16 little-endian PCM.
 */

const A4_REF_DEFAULT = 440;
const MIDI_A4 = 69;

// 44.1 kHz for clicks — sharper transient, no aliasing on the high-freq
// downbeat click.
export const CLICK_SAMPLE_RATE = 44100;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function midiToFrequency(midi: number, a4Hz: number = A4_REF_DEFAULT): number {
  return a4Hz * Math.pow(2, (midi - MIDI_A4) / 12);
}

// ---------------------------------------------------------------------------
// WAV header
// ---------------------------------------------------------------------------

function wavHeader(sampleRate: number, dataBytes: number): Uint8Array {
  const buf = new Uint8Array(44);
  const view = new DataView(buf.buffer);
  // "RIFF"
  buf[0] = 0x52; buf[1] = 0x49; buf[2] = 0x46; buf[3] = 0x46;
  view.setUint32(4, 36 + dataBytes, true);
  // "WAVE"
  buf[8] = 0x57; buf[9] = 0x41; buf[10] = 0x56; buf[11] = 0x45;
  // "fmt "
  buf[12] = 0x66; buf[13] = 0x6d; buf[14] = 0x74; buf[15] = 0x20;
  view.setUint32(16, 16, true);            // PCM sub-chunk size
  view.setUint16(20, 1, true);             // audio format (PCM)
  view.setUint16(22, 1, true);             // mono
  view.setUint32(24, sampleRate, true);    // sample rate
  view.setUint32(28, sampleRate * 2, true);// byte rate
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits per sample
  // "data"
  buf[36] = 0x64; buf[37] = 0x61; buf[38] = 0x74; buf[39] = 0x61;
  view.setUint32(40, dataBytes, true);
  return buf;
}

function pcmToBase64(header: Uint8Array, pcm: Uint8Array): string {
  const out = new Uint8Array(header.length + pcm.length);
  out.set(header, 0);
  out.set(pcm, header.length);
  let s = '';
  // Chunk binary string build — keeps `String.fromCharCode` arg count below
  // engine limits (Hermes caps argument list around 2^16). 32k chunk is safe.
  const CHUNK = 32768;
  for (let i = 0; i < out.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, out.length);
    s += String.fromCharCode.apply(null, Array.from(out.subarray(i, end)));
  }
  return btoa(s);
}

function writeInt16Sample(pcm: Uint8Array, idx: number, sample: number): void {
  // Clamp + write little-endian int16.
  const s = sample < -32768 ? -32768 : sample > 32767 ? 32767 : sample;
  const v = s | 0;
  pcm[idx * 2]     = v & 0xff;
  pcm[idx * 2 + 1] = (v >> 8) & 0xff;
}

// ---------------------------------------------------------------------------
// Click — metronome.
// ---------------------------------------------------------------------------

export type ClickKind = 'accent' | 'normal';

/**
 * Build a base64 WAV containing a single short percussive click.
 *
 *   - `accent` — ~4 kHz, sharper attack, used on beat 1.
 *   - `normal` — ~1.5 kHz, softer, used on beats 2..N.
 *
 * Click length is ~25 ms (1102 samples at 44.1 kHz). An exponential decay
 * envelope shapes the body so the click is percussive, not a tone burst.
 */
export function buildClickWavBase64(kind: ClickKind): string {
  const sr = CLICK_SAMPLE_RATE;
  // 25 ms — long enough to perceive, short enough to feel like a tick.
  const totalSamples = Math.round(0.025 * sr);
  const freq = kind === 'accent' ? 4000 : 1500;
  const decay = kind === 'accent' ? 0.0012 : 0.0020; // seconds — accent decays faster
  // v1.1 — bumped from 0.75 → 0.99 (max headroom without clipping). Single
  // sine peaks at exactly ±1.0 at the attack instant; 0.99 keeps a one-bit
  // guard against rounding into +32768/-32769 on the writeInt16Sample clamp.
  const peak = 32767 * 0.99;

  const pcm = new Uint8Array(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sr;
    const env = Math.exp(-t / decay);
    // Multiply a sine by a fast exponential decay — classic click body.
    const sample = Math.sin(2 * Math.PI * freq * t) * env;
    writeInt16Sample(pcm, i, sample * peak);
  }
  const header = wavHeader(sr, pcm.length);
  return pcmToBase64(header, pcm);
}
