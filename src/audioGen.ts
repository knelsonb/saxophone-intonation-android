/**
 * audioGen.ts — shared WAV synthesis helpers.
 *
 * Used by:
 *   - Metronome (short percussive clicks)
 *   - Drone (sustained tonal voices: cello / sine / saw)
 *
 * Approach (same lineage as `pitchTones.ts`): synthesize 16-bit PCM, slap a
 * RIFF/WAVE header on it, return a base64 string. Caller writes it to the
 * cache directory and hands the resulting `file://` URI to expo-audio's
 * `createAudioPlayer` (Android's ExoPlayer rejects `data:` URIs).
 *
 * All generators below produce mono int16 little-endian PCM. Length is chosen
 * so an integer number of fundamental cycles fits exactly — eliminates clicks
 * at the loop point when `player.loop = true`.
 */

const A4_REF_DEFAULT = 440;
const MIDI_A4 = 69;

// 22.05 kHz keeps WAV blobs small enough for fast crossfades (≈90 kB / sec at
// 16-bit mono) while still resolving every harmonic the drone produces
// comfortably below Nyquist (top harmonic ~4× fundamental for cello, well
// inside the 11 kHz Nyquist).
export const DRONE_SAMPLE_RATE = 22050;

// 44.1 kHz for clicks — sharper transient, no aliasing on the high-freq
// downbeat click.
export const CLICK_SAMPLE_RATE = 44100;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function midiToFrequency(midi: number, a4Hz: number = A4_REF_DEFAULT): number {
  return a4Hz * Math.pow(2, (midi - MIDI_A4) / 12);
}

export type DroneVoice = 'cello' | 'sine' | 'saw';

export const DRONE_VOICES: readonly DroneVoice[] = ['cello', 'sine', 'saw'] as const;

export function droneVoiceLabel(v: DroneVoice): string {
  switch (v) {
    case 'cello': return 'CELLO';
    case 'sine':  return 'SINE';
    case 'saw':   return 'SAW';
  }
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
// Drone — sustained tones for the TUNER drone toggle.
// ---------------------------------------------------------------------------

/**
 * Build a base64 WAV containing one looped period (or a few cycles' worth) of
 * the requested drone voice at the given frequency. Designed so
 * `player.loop = true` produces a continuous sustained tone.
 *
 * `freqHz` must be > 0. Caller is responsible for clamping to a sane range
 * (16–2000 Hz covers the entire musical range we care about).
 *
 * `voice` selects the timbre:
 *   - `sine`  — pure fundamental. Reference flavor.
 *   - `cello` — fundamental + 2x, 3x, 4x harmonics with relative amplitudes
 *               [1.0, 0.55, 0.28, 0.14] and a gentle 5 Hz vibrato of ±5 cents.
 *               Two seconds long so the vibrato cycle reads naturally.
 *   - `saw`   — band-limited sawtooth via additive synthesis up to ~5 kHz.
 *               Brighter, useful for cutting through a noisy room.
 *
 * `volume` 0..1 scales the peak amplitude. Internal headroom keeps the result
 * comfortably below clipping for any voice at volume=1.0.
 */
export function buildDroneWavBase64(
  freqHz: number,
  voice: DroneVoice,
  volume: number = 0.6,
): string {
  if (!Number.isFinite(freqHz) || freqHz <= 0) freqHz = 220;
  const sr = DRONE_SAMPLE_RATE;
  const vol = Math.max(0, Math.min(1, volume));

  // Pick a buffer that holds an integer number of fundamental cycles AND is
  // long enough for the slow modulation (vibrato for cello). Aim for ~2 s.
  const TARGET_SECONDS = 2.0;
  const samplesPerCycle = sr / freqHz;
  const cycleCount = Math.max(1, Math.round((TARGET_SECONDS * sr) / samplesPerCycle));
  const totalSamples = Math.round(cycleCount * samplesPerCycle);

  // Headroom guards against the harmonic sum going above 1.0 (cello: 1+0.55+
  // 0.28+0.14 = 1.97; saw: ~1.27 after band-limited series; sine: 1.0).
  const HEADROOM = voice === 'cello' ? 0.5 : voice === 'saw' ? 0.7 : 0.9;
  const peak = 32767 * vol * HEADROOM;

  const pcm = new Uint8Array(totalSamples * 2);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sr;                       // seconds
    const phase = (2 * Math.PI * i) / samplesPerCycle; // fundamental phase
    let sample = 0;

    if (voice === 'sine') {
      sample = Math.sin(phase);
    } else if (voice === 'cello') {
      // Slight vibrato — modulates fundamental phase. ±5 cents at 5 Hz.
      // 5 cents = 2^(5/1200) ≈ 1.0029, so phase deviation is ~0.29 % of the
      // base phase per cycle. Implemented as a phase-modulation term.
      const vib = 0.0029 * Math.sin(2 * Math.PI * 5 * t);
      const p = phase * (1 + vib);
      sample =
          1.00 * Math.sin(p)
        + 0.55 * Math.sin(2 * p)
        + 0.28 * Math.sin(3 * p)
        + 0.14 * Math.sin(4 * p);
    } else {
      // Band-limited sawtooth — additive series sum_{k=1..N}(sin(k phase) / k).
      // N chosen so kN * freqHz stays under ~5 kHz (a reasonable brightness
      // ceiling that doesn't alias near Nyquist for any musical fundamental).
      const N = Math.max(2, Math.min(20, Math.floor(5000 / freqHz)));
      let s = 0;
      for (let k = 1; k <= N; k++) {
        s += Math.sin(k * phase) / k;
      }
      // 2/π scales the Gibbs-bounded series toward ±1.
      sample = (2 / Math.PI) * s;
    }

    writeInt16Sample(pcm, i, sample * peak);
  }

  const header = wavHeader(sr, pcm.length);
  return pcmToBase64(header, pcm);
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
  const peak = 32767 * 0.75;

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
