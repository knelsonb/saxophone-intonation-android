/**
 * Music / pitch helpers — pure TypeScript, no native dependencies.
 *
 * Ported from sax_audio_engine.py and sax_intonation_gui.py (desktop v0.5.6).
 *
 * CENT PRECISION TIERS (centsDisplayPrecision)
 * --------------------------------------------
 * The desktop computes a continuous formula and compares against two thresholds:
 *
 *   floor = 173.0 * freqHz / sampleRate          (sax_intonation_gui.py:658)
 *   CENT_PREC_TENTHS_MAX = 0.3                    (sax_intonation_gui.py:648)
 *   CENT_PREC_HALVES_MAX = 0.7                    (sax_intonation_gui.py:649)
 *
 *   floor <= 0.3  → display to 0.1 ¢  (tenths)
 *   floor <= 0.7  → display to 0.5 ¢  (halves)
 *   floor >  0.7  → display to 1.0 ¢  (wholes)
 *
 * At 44 100 Hz the tier crossovers land at:
 *   0.3 = 173 * f / 44100  →  f ≈ 76.5 Hz   (below Eb3 on alto)
 *   0.7 = 173 * f / 44100  →  f ≈ 178.5 Hz  (between F#3 and G3)
 *
 * The Android side always receives 44 100 Hz buffers initially, so the
 * function accepts sampleRate as an argument to stay sample-rate-agnostic.
 * The default of 44100 is a safe fallback.
 */

/** A4 tuning reference, Hz. */
const A4_DEFAULT_HZ = 440.0;

// Cent precision thresholds — must match sax_intonation_gui.py:648-649.
const CENT_PREC_TENTHS_MAX = 0.3;
const CENT_PREC_HALVES_MAX = 0.7;

// One semitone name per half-step index 0-11 (C = 0). Uses sharps.
const NOTE_NAMES: ReadonlyArray<string> = [
  'C', 'C#', 'D', 'D#', 'E', 'F',
  'F#', 'G', 'G#', 'A', 'A#', 'B',
];

export interface NoteNameResult {
  letter: string;
  accidental: '' | '#' | 'b';
  octave: number;
}

export interface CentsDeviationResult {
  nearestMidi: number;
  cents: number;
}

/**
 * Convert a frequency to a fractional MIDI note number.
 *
 * MIDI 69 = A4 = a4Hz. Returns non-integer values; round to snap to nearest
 * semitone.
 *
 * @param freqHz Frequency in Hz (must be > 0)
 * @param a4Hz   Tuning reference for A4 (default 440)
 */
export function freqToMidi(freqHz: number, a4Hz: number = A4_DEFAULT_HZ): number {
  return 69.0 + 12.0 * Math.log2(freqHz / a4Hz);
}

/**
 * Convert a (rounded) MIDI number to a note name.
 *
 * Uses scientific pitch notation: A4 = MIDI 69, C4 = MIDI 60.
 * Accidentals are always expressed as sharps (no enharmonic respelling).
 *
 * @param midi Integer MIDI note number (fractional inputs are rounded)
 */
export function midiToNoteName(midi: number): NoteNameResult {
  const midiInt: number = Math.round(midi);
  // Pitch class 0-11, where 0 = C.
  const pc: number = ((midiInt % 12) + 12) % 12;
  // Scientific octave: C4 = MIDI 60 → octave = floor(60/12) - 1 = 4.
  const octave: number = Math.floor(midiInt / 12) - 1;
  const fullName: string = NOTE_NAMES[pc];
  const letter: string = fullName[0];
  const accidental: '' | '#' | 'b' = fullName.length > 1 ? '#' : '';
  return { letter, accidental, octave };
}

/**
 * Compute the deviation in cents from the nearest semitone.
 *
 * Returns cents in [-50, +50]. Positive values mean the pitch is sharp
 * relative to equal temperament at the given A4 reference.
 *
 * @param freqHz Measured frequency in Hz
 * @param a4Hz   Tuning reference for A4 (default 440)
 */
export function centsDeviation(
  freqHz: number,
  a4Hz: number = A4_DEFAULT_HZ,
): CentsDeviationResult {
  const mf: number = freqToMidi(freqHz, a4Hz);
  const nearestMidi: number = Math.round(mf);
  const cents: number = (mf - nearestMidi) * 100.0;
  return { nearestMidi, cents };
}

/**
 * Return the appropriate cent display precision for a given frequency.
 *
 * Mirrors desktop `cent_precision_floor` + tier logic from
 * sax_intonation_gui.py:652-658 and format_cents at lines 661-688.
 *
 * The precision is frequency- and sample-rate-adaptive: higher frequencies
 * have larger periods, so parabolic interpolation in YIN provides better
 * sub-sample resolution per cent, enabling finer display.
 *
 * At 44 100 Hz:
 *   freqHz < ~76.5 Hz  → 1.0 ¢  (tiers match; low notes, wide periods)
 *   freqHz < ~178.5 Hz → 0.5 ¢
 *   freqHz ≥ ~178.5 Hz → 0.1 ¢
 *
 * NOTE: the brief cited memory-based tiers of 100/400 Hz — those are
 * approximations. The exact crossovers from the desktop source are used here.
 *
 * @param freqHz     Frequency in Hz
 * @param sampleRate Sample rate in Hz (default 44100)
 */
export function centsDisplayPrecision(
  freqHz: number,
  sampleRate: number = 44100,
): 0.1 | 0.5 | 1.0 {
  if (freqHz <= 0 || sampleRate <= 0) {
    return 1.0;
  }
  const floor: number = (173.0 * freqHz) / sampleRate;
  if (floor <= CENT_PREC_TENTHS_MAX) {
    return 0.1;
  }
  if (floor <= CENT_PREC_HALVES_MAX) {
    return 0.5;
  }
  return 1.0;
}
