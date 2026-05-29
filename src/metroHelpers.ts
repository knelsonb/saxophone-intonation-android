/**
 * metroHelpers — pure, native-free metronome helpers.
 *
 * Extracted from useMetronome.ts (#26). Everything here is a pure function,
 * a plain constant, or a type: NO React, NO react-native, NO native imports.
 * useMetronome.ts re-imports and re-exports these so existing
 * `from './useMetronome'` import sites (components, screens, tests) keep working
 * unchanged — behaviour is identical, only the home of the pure layer moved.
 *
 * The type-only imports below (MetroProfile, EditableProfile / patch,
 * ChannelRole) are erased at compile time, so this module pulls in no
 * AsyncStorage / RN runtime dependency.
 */
import type { MetroProfile } from './storage/prefs';
import type { ChannelRole } from './useMidiBusCore';
import type { EditableProfile, EditableProfilePatch } from './components/ProfileEditorAccordion';

// v1.2 — TimeSig is a tagged union. The denominator is for notation only;
// beats-per-bar = numerator regardless of denominator (the existing 6/8
// preset already counts six eighth-notes per bar at the displayed BPM —
// custom inherits that). Future engineers WILL try to make 6/8 sound like
// 6/8 — do not let them.
export type TimeSigPreset = '2/4' | '3/4' | '4/4' | '6/8';
export type TimeSig =
  | { kind: 'preset'; value: TimeSigPreset }
  | { kind: 'custom'; num: number; den: 2 | 4 | 8 | 16 | 32 };

const TIME_SIG_PRESET_BEATS: Record<TimeSigPreset, number> = {
  '2/4': 2,
  '3/4': 3,
  '4/4': 4,
  '6/8': 6,
};

/** Beats-per-bar — numerator for custom, hard-coded count for presets. */
export function beatsPerBar(ts: TimeSig): number {
  if (ts.kind === 'preset') return TIME_SIG_PRESET_BEATS[ts.value];
  return ts.num;
}

/**
 * v1.2 — per-beat instrument. Velocity carried in the type for forward-compat
 * with v1.3's per-cell-velocity UI (§15.Q11.4); v1.2 surfaces no velocity UI.
 *
 * v1.3 (G14) — `channel` is RESERVED for v1.4 multi-channel patterns
 * (e.g. fire a kick on 'drums' AND a cowbell on 'aux1' from the same cell).
 * v1.3 ALWAYS omits this field; the dispatcher unconditionally routes to
 * the 'drums' channel handle reserved on hook mount. The field is typed
 * here purely for forward-compatibility so future profile JSON written
 * by v1.4 doesn't have to widen the schema.
 */
export interface BeatInstrument {
  /** GM percussion note 35..81 (channel 9). */
  midi: number;
  /** MIDI velocity 1..127. */
  velocity: number;
  /**
   * v1.4-reserved per-cell channel override. v1.3 ignores this field; do
   * not populate it from any v1.3 code path. See council G14.
   */
  channel?: ChannelRole;
}

// v1.2 — subdivision mode. Mutually exclusive (§15.Q11.2).
export type Subdivision = 'off' | '8th' | '16th' | 'triplet';

export const SUBS_PER_BEAT: Record<Subdivision, number> = {
  'off':     1,
  '8th':     2,
  '16th':    4,
  'triplet': 3,
};

// v1.2 — hard-coded GM drum defaults. Wave 2 may import these from
// src/drumVoices.ts (created by Ent); hard-coding here avoids a build-time
// dependency on a not-yet-landed sibling.
export const DEFAULT_BEAT_1_MIDI = 36;      // Bass Drum 1
export const DEFAULT_BEAT_1_VELOCITY = 110; // accented downbeat
export const DEFAULT_BEAT_N_MIDI = 76;      // High Wood Block (§15.Q11.1)
export const DEFAULT_BEAT_N_VELOCITY = 90;
export const DEFAULT_SUB_MIDI = 42;         // Closed Hi-Hat
export const DEFAULT_SUB_VELOCITY = 70;     // §15.Q11.9

// Distinct GM percussion voice per beat so every position in the bar is
// audibly identifiable — kick on 1, then snare / tom / cowbell. Cycles for
// bars longer than 4. Pairs with the per-beat pendulum-bob colour and the
// numeral so the player can hear, see, AND feel where they are in the measure.
const DEFAULT_BEAT_VOICES: BeatInstrument[] = [
  { midi: 36, velocity: 110 }, // 1 — Bass Drum 1 (kick), accented downbeat
  { midi: 38, velocity: 95 },  // 2 — Acoustic Snare
  { midi: 50, velocity: 95 },  // 3 — High Tom
  { midi: 56, velocity: 95 },  // 4 — Cowbell
];

// Default voice for beat index i (0-based). The kick (the accent) lands ONLY
// on the downbeat; every other beat cycles through the NON-downbeat voices
// (snare/tom/cowbell). This keeps a single, unambiguous "1" — naively cycling
// `i % 4` would replay the kick on beat 5 of a 6/8 bar, planting a phantom
// second downbeat.
function defaultVoiceForBeat(i: number): BeatInstrument {
  if (i <= 0) return { ...DEFAULT_BEAT_VOICES[0] };
  const nonDownbeat = DEFAULT_BEAT_VOICES.length - 1; // snare, tom, cowbell
  return { ...DEFAULT_BEAT_VOICES[1 + ((i - 1) % nonDownbeat)] };
}

const DRUM_MIDI_LO = 35;
const DRUM_MIDI_HI = 81;

export const BPM_MIN = 30;
export const BPM_MAX = 300;
export const BPM_DEFAULT = 100;

export const MIN_NUMERATOR = 1;
export const MAX_NUMERATOR = 32; // §15.Q11.5
export const ALLOWED_DENOMINATORS: readonly (2 | 4 | 8 | 16 | 32)[] = [2, 4, 8, 16, 32];

export function clampBpm(n: number): number {
  if (!Number.isFinite(n)) return BPM_DEFAULT;
  return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(n)));
}

export function clampNumerator(n: number): number {
  if (!Number.isFinite(n)) return 4;
  return Math.max(MIN_NUMERATOR, Math.min(MAX_NUMERATOR, Math.trunc(n)));
}

export function clampDrumMidi(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_BEAT_N_MIDI;
  const t = Math.trunc(n);
  return Math.max(DRUM_MIDI_LO, Math.min(DRUM_MIDI_HI, t));
}

// v1.2 — default pattern for N beats: kick on 1, click on 2..N.
export function buildDefaultPattern(beats: number): BeatInstrument[] {
  const out: BeatInstrument[] = new Array(beats);
  for (let i = 0; i < beats; i++) {
    out[i] = defaultVoiceForBeat(i);
  }
  return out;
}

// v1.2 — resize an existing pattern to a new beat count without losing user
// assignments. If shrinking, drop the tail. If growing, fill new cells with
// the default click voice (matches the default-pattern's non-downbeat slot).
export function resizePattern(old: BeatInstrument[], newBeats: number): BeatInstrument[] {
  if (newBeats <= 0) return [];
  if (old.length === newBeats) return old;
  if (old.length > newBeats) return old.slice(0, newBeats);
  const out = old.slice();
  while (out.length < newBeats) {
    out.push(defaultVoiceForBeat(out.length));
  }
  return out;
}

// v1.2 — validate a parsed pattern against current beats-per-bar. Returns
// the input if it's well-formed and length-matched, else null (caller falls
// back to the default).
export function validatePatternForBeats(p: unknown, beats: number): BeatInstrument[] | null {
  if (!Array.isArray(p) || p.length !== beats) return null;
  const out: BeatInstrument[] = [];
  for (const e of p) {
    if (typeof e !== 'object' || e === null) return null;
    const rec = e as { midi?: unknown; velocity?: unknown };
    const midi = Number(rec.midi);
    const velocity = Number(rec.velocity);
    if (!Number.isFinite(midi) || midi < DRUM_MIDI_LO || midi > DRUM_MIDI_HI) return null;
    if (!Number.isFinite(velocity) || velocity < 1 || velocity > 127) return null;
    out.push({ midi: Math.trunc(midi), velocity: Math.trunc(velocity) });
  }
  return out;
}

// v1.4 (Wave 3.5) — slot index in the editor's EditableProfile is 1..4 (1-based,
// matches the UI labels "User 1".."User 4"). The PERSISTED activeProfileSlot is
// 0-based (or -1 = none) to match the MetroProfile[] array index the hydration
// path at U22 already reads.
export type ProfileSlot = 1 | 2 | 3 | 4;
export const PROFILE_COUNT = 4;

// v1.4 (Wave 3.5) — fresh-install default profiles. Lifted out of MetroScreen's
// local mock (which re-seeded on every mount) so the hook now OWNS them. Mirrors
// the v1.3 §9 defaults the screen used to build. Each slot's pattern length
// matches beatsPerBar(timeSig) so it round-trips cleanly through the persisted
// MetroProfile schema (validateProfile requires length === numerator for presets).
export function buildInitialProfiles(): EditableProfile[] {
  const sub = (): BeatInstrument => ({ midi: DEFAULT_SUB_MIDI, velocity: DEFAULT_SUB_VELOCITY });
  return [
    { slot: 1, name: 'User 1', timeSig: { kind: 'preset', value: '4/4' }, pattern: buildDefaultPattern(4), subdivisions: 'off', subdivisionVoice: sub() },
    { slot: 2, name: 'User 2', timeSig: { kind: 'preset', value: '3/4' }, pattern: buildDefaultPattern(3), subdivisions: 'off', subdivisionVoice: sub() },
    { slot: 3, name: 'User 3', timeSig: { kind: 'preset', value: '4/4' }, pattern: buildDefaultPattern(4), subdivisions: 'off', subdivisionVoice: sub() },
    { slot: 4, name: 'User 4', timeSig: { kind: 'preset', value: '4/4' }, pattern: buildDefaultPattern(4), subdivisions: 'off', subdivisionVoice: sub() },
  ];
}

// v1.4 (Wave 3.5) — EditableProfile (UI shape, 1-based slot + TimeSig union +
// nested subdivisionVoice) → MetroProfile (flat persisted shape). The persisted
// schema has NO denominator and a single flat timeSig string, so a custom sig
// collapses to 'custom' (its numerator survives implicitly as pattern.length on
// re-hydration; the denominator is notation-only and is reconstructed as 4 —
// matches the existing U22 hydration path). bpm has no source in EditableProfile
// (the editor surfaces no per-profile tempo and loadProfile never applied one),
// so we persist BPM_DEFAULT purely to satisfy validateProfile's 20..300 guard;
// it is NOT read back into live state.
export function editableToMetroProfile(p: EditableProfile): MetroProfile {
  return {
    name: p.name && p.name.length > 0 ? p.name : `User ${p.slot}`,
    bpm: BPM_DEFAULT,
    timeSig: p.timeSig.kind === 'preset' ? p.timeSig.value : 'custom',
    pattern: p.pattern.map((c) => ({
      midi: clampDrumMidi(c.midi),
      velocity: Math.max(1, Math.min(127, Math.trunc(c.velocity))),
    })),
    subdivisions: p.subdivisions,
    subMidi: clampDrumMidi(p.subdivisionVoice.midi),
    subVel: Math.max(1, Math.min(127, Math.trunc(p.subdivisionVoice.velocity))),
  };
}

// v1.4 (Wave 3.5) — MetroProfile (persisted) → EditableProfile (UI). Inverse of
// editableToMetroProfile. Reconstructs the TimeSig union from the flat string;
// a 'custom' profile derives its numerator from pattern.length (denominator → 4,
// notation-only), mirroring useMetronome's existing U22 live-state hydration.
export function metroProfileToEditable(p: MetroProfile, slot: ProfileSlot): EditableProfile {
  let timeSig: TimeSig;
  if (p.timeSig === 'custom') {
    timeSig = { kind: 'custom', num: clampNumerator(p.pattern.length), den: 4 };
  } else {
    timeSig = { kind: 'preset', value: p.timeSig };
  }
  const pattern: BeatInstrument[] = p.pattern.map((c) => ({
    midi: clampDrumMidi(c.midi),
    velocity: Math.max(1, Math.min(127, Math.trunc(c.velocity))),
  }));
  return {
    slot,
    name: p.name && p.name.length > 0 ? p.name : `User ${slot}`,
    timeSig,
    pattern,
    subdivisions: p.subdivisions,
    subdivisionVoice: {
      midi: clampDrumMidi(p.subMidi),
      velocity: Math.max(1, Math.min(127, Math.trunc(p.subVel))),
    },
  };
}

// v1.4 (Wave 3.5) — apply an EditableProfilePatch, resizing the pattern to match
// a changed time-sig (preserve overlapping cells; default-fill new tail). Mirrors
// MetroScreen's old local onUpdate merge so the editor behaviour is unchanged —
// only the OWNER of the state moved into the hook.
export function applyProfilePatch(prev: EditableProfile, patch: EditableProfilePatch): EditableProfile {
  const merged: EditableProfile = { ...prev, ...patch };
  if (patch.timeSig) {
    const newBeats = beatsPerBar(patch.timeSig);
    if (merged.pattern.length !== newBeats) {
      merged.pattern = resizePattern(merged.pattern, newBeats);
    }
  }
  return merged;
}
