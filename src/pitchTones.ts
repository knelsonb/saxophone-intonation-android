/**
 * pitchTones.ts — tone generation helpers for the pitch pipes feature.
 *
 * Tone approach: generate a PCM sine wave buffer and encode it as a
 * base64 WAV data URI. The buffer length is chosen so an integer number
 * of complete cycles fits exactly, eliminating click at the loop point.
 *
 * Example (A4 = 440 Hz, sampleRate = 44100):
 *   samplesPerCycle = 44100 / 440 = 100.227…
 *   We want N cycles such that N * samplesPerCycle is closest to ~50 cycles.
 *   cycleTarget = 50 → totalSamples = round(50 * 100.227) = 5011
 *   Actual frequency = 50 * 44100 / 5011 = 439.83 Hz — error < 0.04 %.
 *
 * Playback note: Android's ExoPlayer does NOT support data: URIs.
 * Building this URI here is correct and cheap; callers that want actual
 * audio output must write the WAV bytes to a temp file via expo-file-system
 * (not currently a project dep) and pass a file:// URI to createAudioPlayer.
 * See PitchPipes.tsx for the wiring point.
 *
 * TODO: When expo-file-system is added as a dep, replace the fallback
 *       visual-only mode in PitchPipes.tsx with:
 *         const path = FileSystem.cacheDirectory + `tone_${midi}.wav`;
 *         await FileSystem.writeAsStringAsync(path, buildWavBase64(freq, refHz), { encoding: 'base64' });
 *         player.replace({ uri: path });
 *       Without that step, no audio plays on Android — only the UI indicator activates.
 */

const SAMPLE_RATE = 44100;
const CYCLE_TARGET = 50; // number of complete cycles per buffer
const AMPLITUDE = 0.7;   // 0.0–1.0; headroom below full scale

/** Concert A4 MIDI number. */
const MIDI_A4 = 69;

/**
 * Converts a MIDI note number to frequency in Hz using a given A4 reference.
 * Standard equal temperament: f = refA4 * 2^((midi - 69) / 12).
 */
export function midiToFrequency(midi: number, a4Hz: number): number {
  return a4Hz * Math.pow(2, (midi - MIDI_A4) / 12);
}

/**
 * Builds a WAV file encoded as a base64 string (no data: URI prefix) for
 * a sine tone at the given frequency and reference A4.
 *
 * The buffer is tuned so an integer number of cycles fits exactly,
 * so looping the file produces a click-free tone.
 */
export function buildWavBase64(midi: number, a4Hz: number): string {
  const freq = midiToFrequency(midi, a4Hz);

  // Choose total sample count to fit integer cycles.
  const samplesPerCycle = SAMPLE_RATE / freq;
  const totalSamples = Math.round(CYCLE_TARGET * samplesPerCycle);

  // PCM data: 16-bit signed little-endian mono.
  const pcmBytes = new Uint8Array(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    const sample = Math.round(AMPLITUDE * 32767 * Math.sin((2 * Math.PI * i) / samplesPerCycle));
    // Clamp to int16 range.
    const s = Math.max(-32768, Math.min(32767, sample));
    // Little-endian write.
    pcmBytes[i * 2]     = s & 0xff;
    pcmBytes[i * 2 + 1] = (s >> 8) & 0xff;
  }

  const dataSize = pcmBytes.length;
  const headerSize = 44;
  const buf = new Uint8Array(headerSize + dataSize);
  const view = new DataView(buf.buffer);

  // RIFF header
  buf[0] = 0x52; buf[1] = 0x49; buf[2] = 0x46; buf[3] = 0x46; // "RIFF"
  view.setUint32(4, 36 + dataSize, true);                        // chunk size
  buf[8] = 0x57; buf[9] = 0x41; buf[10] = 0x56; buf[11] = 0x45; // "WAVE"

  // fmt sub-chunk
  buf[12] = 0x66; buf[13] = 0x6d; buf[14] = 0x74; buf[15] = 0x20; // "fmt "
  view.setUint32(16, 16, true);           // sub-chunk size (PCM)
  view.setUint16(20, 1, true);            // audio format (PCM = 1)
  view.setUint16(22, 1, true);            // num channels (mono)
  view.setUint32(24, SAMPLE_RATE, true);  // sample rate
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate (sampleRate * channels * bitsPerSample/8)
  view.setUint16(32, 2, true);            // block align (channels * bitsPerSample/8)
  view.setUint16(34, 16, true);           // bits per sample

  // data sub-chunk
  buf[36] = 0x64; buf[37] = 0x61; buf[38] = 0x74; buf[39] = 0x61; // "data"
  view.setUint32(40, dataSize, true);

  buf.set(pcmBytes, 44);

  // Base64-encode using JS's btoa (available in Hermes / RN runtime).
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Tuning note map — the primary pitch each instrument family tunes to.
// sounding_midi is concert pitch (C instrument perspective).
// label is what appears on the pitch pipe pad as the highlighted note.
// ---------------------------------------------------------------------------

interface TuningNote {
  /** Concert-pitch MIDI of the tuning note. */
  sounding_midi: number;
  /** Display label, e.g. "Bb4" or "A4". */
  label: string;
}

// Instrument key → tuning note. Covers the major families in the catalog.
// Bb instruments tune to their written Bb (concert Ab or Bb depending on octave).
// The standard band tuning note for Bb instruments is concert Bb4 (midi 70).
// Eb instruments tune to concert Eb4/Eb5. C instruments tune to A4 or concert C.
const TUNING_NOTE_MAP: Record<string, TuningNote> = {
  // Bb saxophones — tune concert Bb4
  bb_soprano:           { sounding_midi: 70, label: 'Bb4' },
  bb_tenor:             { sounding_midi: 70, label: 'Bb4' },
  bb_bass:              { sounding_midi: 58, label: 'Bb3' },
  // Eb saxophones — tune concert Eb4
  eb_sopranino:         { sounding_midi: 63, label: 'Eb4' },
  eb_alto:              { sounding_midi: 63, label: 'Eb4' },
  eb_bari:              { sounding_midi: 63, label: 'Eb4' },
  eb_contrabass:        { sounding_midi: 51, label: 'Eb3' },
  // Bb clarinets
  clar_bb:              { sounding_midi: 70, label: 'Bb4' },
  clar_bass_bb:         { sounding_midi: 58, label: 'Bb3' },
  clar_contrabass_bb:   { sounding_midi: 46, label: 'Bb2' },
  // Eb clarinets
  clar_eb:              { sounding_midi: 63, label: 'Eb4' },
  clar_alto_eb:         { sounding_midi: 63, label: 'Eb4' },
  clar_contraalto_eb:   { sounding_midi: 51, label: 'Eb3' },
  // Other clarinets — tune concert A4
  clar_a:               { sounding_midi: 69, label: 'A4' },
  clar_c:               { sounding_midi: 69, label: 'A4' },
  clar_d:               { sounding_midi: 69, label: 'A4' },
  clar_basset_f:        { sounding_midi: 65, label: 'F4' },
  // Flutes (C instruments) — A4
  flute_c:              { sounding_midi: 69, label: 'A4' },
  flute_piccolo:        { sounding_midi: 81, label: 'A5' },
  flute_alto_g:         { sounding_midi: 69, label: 'A4' },
  flute_bass_c:         { sounding_midi: 57, label: 'A3' },
  // Trumpets
  trp_bb:               { sounding_midi: 70, label: 'Bb4' },
  trp_c:                { sounding_midi: 69, label: 'A4' },
  trp_d:                { sounding_midi: 69, label: 'A4' },
  trp_e:                { sounding_midi: 64, label: 'E4' },
  trp_eb:               { sounding_midi: 63, label: 'Eb4' },
  trp_f:                { sounding_midi: 65, label: 'F4' },
  trp_a:                { sounding_midi: 69, label: 'A4' },
  trp_bass_bb:          { sounding_midi: 58, label: 'Bb3' },
  trp_piccolo_bb:       { sounding_midi: 70, label: 'Bb4' },
  trp_piccolo_a:        { sounding_midi: 69, label: 'A4' },
  cornet_bb:            { sounding_midi: 70, label: 'Bb4' },
  flugel_bb:            { sounding_midi: 70, label: 'Bb4' },
  // Horns
  horn_f:               { sounding_midi: 65, label: 'F4' },
  horn_bb:              { sounding_midi: 70, label: 'Bb4' },
  horn_eb_alto:         { sounding_midi: 63, label: 'Eb4' },
  mellophone_f:         { sounding_midi: 65, label: 'F4' },
  // Trombones / C instruments
  tbn_tenor:            { sounding_midi: 69, label: 'A4' },
  tbn_bass:             { sounding_midi: 57, label: 'A3' },
  tbn_alto_eb:          { sounding_midi: 63, label: 'Eb4' },
  tbn_contrabass:       { sounding_midi: 57, label: 'A3' },
  // Low brass
  euph_bc:              { sounding_midi: 57, label: 'A3' },
  euph_tc:              { sounding_midi: 70, label: 'Bb4' },
  baritone_bc:          { sounding_midi: 57, label: 'A3' },
  baritone_tc:          { sounding_midi: 70, label: 'Bb4' },
  tuba_f:               { sounding_midi: 53, label: 'F3' },
  tuba_eb:              { sounding_midi: 51, label: 'Eb3' },
  tuba_cc:              { sounding_midi: 48, label: 'C3' },
  tuba_bbb:             { sounding_midi: 46, label: 'Bb2' },
  sousaphone_bbb:       { sounding_midi: 46, label: 'Bb2' },
  // Double reeds
  oboe:                 { sounding_midi: 69, label: 'A4' },
  oboe_damore:          { sounding_midi: 66, label: 'F#4' },
  english_horn:         { sounding_midi: 62, label: 'D4' },
  bassoon:              { sounding_midi: 57, label: 'A3' },
  contrabassoon:        { sounding_midi: 45, label: 'A2' },
  // Strings
  violin:               { sounding_midi: 69, label: 'A4' },
  viola:                { sounding_midi: 69, label: 'A4' },
  cello:                { sounding_midi: 57, label: 'A3' },
  double_bass:          { sounding_midi: 57, label: 'A3' },
  // Generic
  c:                    { sounding_midi: 69, label: 'A4' },
  piano:                { sounding_midi: 69, label: 'A4' },
  voice:                { sounding_midi: 69, label: 'A4' },
};

/**
 * Returns the primary tuning note for the given instrument key, or null if
 * the instrument is not in the tuning map (e.g. plucked strings with open
 * tuning that varies by player preference).
 */
export function tuningNoteForInstrument(instrumentKey: string): TuningNote | null {
  return TUNING_NOTE_MAP[instrumentKey] ?? null;
}

// ---------------------------------------------------------------------------
// Chromatic scale helpers — 12 notes in one octave, MIDI-based.
// The pitch pipes show notes C4–B4 by default (standard tuning reference octave).
// ---------------------------------------------------------------------------

export interface ChromaticNote {
  /** Display name, e.g. "C", "C#", "Bb". */
  name: string;
  /** MIDI note number for the standard octave (around A4 = 440). */
  midi: number;
}

/** One octave of concert-pitch chromatic notes starting at C4 (midi 60). */
export const CHROMATIC_OCTAVE: ChromaticNote[] = [
  { name: 'C',  midi: 60 },
  { name: 'C#', midi: 61 },
  { name: 'D',  midi: 62 },
  { name: 'D#', midi: 63 },
  { name: 'E',  midi: 64 },
  { name: 'F',  midi: 65 },
  { name: 'F#', midi: 66 },
  { name: 'G',  midi: 67 },
  { name: 'G#', midi: 68 },
  { name: 'A',  midi: 69 },
  { name: 'A#', midi: 70 },
  { name: 'B',  midi: 71 },
];
