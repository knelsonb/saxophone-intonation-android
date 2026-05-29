/**
 * metroScheduling.test.tsx — pure beat-structure + profile-conversion helpers
 * from src/metroHelpers.ts.
 *
 * #26 — these helpers used to live (and were `export`ed for testability) in
 * useMetronome.ts; they were extracted into the native-free ./metroHelpers
 * module. This test now imports them directly from there (useMetronome.ts still
 * re-exports them, so either import path is equivalent). It still runs under
 * jest-expo because the EditableProfile type pulls in ProfileEditorAccordion.
 *
 * WHY: wrong beats-per-bar, or a botched pattern resize, yields the WRONG beat
 * structure — a phantom downbeat or a dropped beat — a silence-over-wrong
 * failure for a metronome. The editable<->persisted conversion is the OTHER half
 * of the profile-persistence round-trip (prefs.ts load/serialize is covered by
 * metroProfiles.test.tsx); together they guard the full save/restore chain.
 *
 * SCOPE: pure logic only. The live scheduler's TIMING (sub-ms phase, latency
 * compensation, 120Hz pin) is Pixel-tier and is NOT exercised here.
 */

import {
  beatsPerBar,
  buildDefaultPattern,
  resizePattern,
  validatePatternForBeats,
  editableToMetroProfile,
  metroProfileToEditable,
  applyProfilePatch,
} from '../metroHelpers';
import type { BeatInstrument } from '../metroHelpers';
import type { EditableProfile } from '../components/ProfileEditorAccordion';

// ---------------------------------------------------------------------------
// beatsPerBar — numerator drives bar length regardless of denominator
// ---------------------------------------------------------------------------

describe('beatsPerBar', () => {
  it('returns the beat count for each preset', () => {
    expect(beatsPerBar({ kind: 'preset', value: '2/4' })).toBe(2);
    expect(beatsPerBar({ kind: 'preset', value: '3/4' })).toBe(3);
    expect(beatsPerBar({ kind: 'preset', value: '4/4' })).toBe(4);
    expect(beatsPerBar({ kind: 'preset', value: '6/8' })).toBe(6); // six eighths, NOT two
  });
  it('returns the custom numerator regardless of denominator', () => {
    expect(beatsPerBar({ kind: 'custom', num: 5, den: 8 })).toBe(5);
    expect(beatsPerBar({ kind: 'custom', num: 7, den: 16 })).toBe(7);
    expect(beatsPerBar({ kind: 'custom', num: 1, den: 4 })).toBe(1);  // MIN_NUMERATOR
    expect(beatsPerBar({ kind: 'custom', num: 32, den: 2 })).toBe(32); // MAX_NUMERATOR
  });
});

// ---------------------------------------------------------------------------
// buildDefaultPattern — single unambiguous downbeat
// ---------------------------------------------------------------------------

describe('buildDefaultPattern', () => {
  it('has exactly N cells', () => {
    for (const n of [1, 2, 3, 4, 6, 7, 12]) {
      expect(buildDefaultPattern(n)).toHaveLength(n);
    }
  });
  it('returns an empty pattern for 0 beats (edge — must not invent a beat)', () => {
    expect(buildDefaultPattern(0)).toEqual([]);
  });
  it('a single-beat bar is just the downbeat kick', () => {
    const p = buildDefaultPattern(1);
    expect(p).toHaveLength(1);
    expect(p[0].midi).toBe(36); // Bass Drum 1
  });
  it('accents ONLY the downbeat — no phantom second "1"', () => {
    const p = buildDefaultPattern(6);
    const kickMidi = p[0].midi;
    for (let i = 1; i < p.length; i++) {
      expect(p[i].midi).not.toBe(kickMidi); // the kick must appear once, on beat 0
    }
  });
  it('uses only valid GM percussion midis (35..81) and velocities (1..127)', () => {
    for (const cell of buildDefaultPattern(12)) {
      expect(cell.midi).toBeGreaterThanOrEqual(35);
      expect(cell.midi).toBeLessThanOrEqual(81);
      expect(cell.velocity).toBeGreaterThanOrEqual(1);
      expect(cell.velocity).toBeLessThanOrEqual(127);
    }
  });
});

// ---------------------------------------------------------------------------
// resizePattern — preserve user assignments across a numerator change
// ---------------------------------------------------------------------------

describe('resizePattern', () => {
  // index 1 is a deliberately user-edited cell to prove preservation.
  const base = (): BeatInstrument[] => [
    { midi: 36, velocity: 110 },
    { midi: 81, velocity: 33 },
    { midi: 50, velocity: 95 },
    { midi: 56, velocity: 95 },
  ];

  it('returns [] for a non-positive beat count', () => {
    expect(resizePattern(base(), 0)).toEqual([]);
    expect(resizePattern(base(), -3)).toEqual([]);
  });
  it('returns the SAME array reference when the length already matches', () => {
    const p = base();
    expect(resizePattern(p, 4)).toBe(p); // no needless copy/realloc
  });
  it('shrinks by dropping the tail, preserving the head', () => {
    const p = base();
    const out = resizePattern(p, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(p[0]);
    expect(out[1]).toEqual(p[1]); // user edit preserved
  });
  it('grows by preserving user cells and default-filling the new tail', () => {
    const p = base();
    const out = resizePattern(p, 6);
    expect(out).toHaveLength(6);
    expect(out[1]).toEqual(p[1]);              // user edit preserved
    expect(out[4].midi).toBe(38);              // defaultVoiceForBeat(4) = snare (cycle wraps)
    expect(out[5].midi).toBe(50);              // defaultVoiceForBeat(5) = tom
    expect(out[4].midi).not.toBe(out[0].midi); // and definitely NOT a phantom downbeat
  });
  it('grows by exactly one (the common "bump the numerator" case)', () => {
    const p = base(); // length 4
    const out = resizePattern(p, 5);
    expect(out).toHaveLength(5);
    expect(out.slice(0, 4)).toEqual(p); // all originals preserved
    expect(out[4].midi).toBe(38);       // new cell defaulted to snare, not a kick
  });
  it('grows from an empty source by laying down fresh defaults', () => {
    const out = resizePattern([], 3);
    expect(out).toHaveLength(3);
    expect(out[0].midi).toBe(36); // downbeat kick at index 0
  });
});

// ---------------------------------------------------------------------------
// validatePatternForBeats — strict parse against a beat count
// ---------------------------------------------------------------------------

describe('validatePatternForBeats', () => {
  const good: BeatInstrument[] = [
    { midi: 36, velocity: 110 },
    { midi: 38, velocity: 95 },
    { midi: 50, velocity: 95 },
    { midi: 56, velocity: 95 },
  ];
  it('accepts a well-formed pattern of the right length', () => {
    expect(validatePatternForBeats(good, 4)).toEqual(good);
  });
  it('rejects a length mismatch', () => {
    expect(validatePatternForBeats(good, 3)).toBeNull();
    expect(validatePatternForBeats(good, 5)).toBeNull();
  });
  it('rejects non-arrays and malformed cells', () => {
    expect(validatePatternForBeats('nope', 4)).toBeNull();
    expect(validatePatternForBeats([{ midi: 200, velocity: 90 }], 1)).toBeNull(); // midi > 81
    expect(validatePatternForBeats([{ midi: 34, velocity: 90 }], 1)).toBeNull();  // midi < 35
    expect(validatePatternForBeats([{ midi: 40, velocity: 200 }], 1)).toBeNull(); // vel > 127
    expect(validatePatternForBeats([{ midi: 40, velocity: 0 }], 1)).toBeNull();   // vel < 1
    expect(validatePatternForBeats([null], 1)).toBeNull();
  });
  it('truncates fractional midi / velocity to integers', () => {
    const out = validatePatternForBeats([{ midi: 40.9, velocity: 90.9 }], 1);
    expect(out).not.toBeNull();
    expect(out![0]).toEqual({ midi: 40, velocity: 90 });
  });
  it('accepts the inclusive boundary values (midi 35/81, velocity 1/127)', () => {
    expect(validatePatternForBeats([{ midi: 35, velocity: 1 }], 1)).toEqual([{ midi: 35, velocity: 1 }]);
    expect(validatePatternForBeats([{ midi: 81, velocity: 127 }], 1)).toEqual([{ midi: 81, velocity: 127 }]);
  });
  it('rejects values one step outside the bounds (fence-post)', () => {
    expect(validatePatternForBeats([{ midi: 82, velocity: 90 }], 1)).toBeNull(); // midi just over
    expect(validatePatternForBeats([{ midi: 40, velocity: 128 }], 1)).toBeNull(); // vel just over
  });
});

// ---------------------------------------------------------------------------
// editable <-> persisted conversion — the OTHER half of profile persistence
// ---------------------------------------------------------------------------

function ed(overrides?: Partial<EditableProfile>): EditableProfile {
  return {
    slot: 1,
    name: 'My Groove',
    timeSig: { kind: 'preset', value: '4/4' },
    pattern: [
      { midi: 36, velocity: 110 },
      { midi: 38, velocity: 95 },
      { midi: 50, velocity: 95 },
      { midi: 56, velocity: 95 },
    ],
    subdivisions: 'off',
    subdivisionVoice: { midi: 42, velocity: 70 },
    ...overrides,
  };
}

describe('editable <-> persisted conversion round-trip', () => {
  it('round-trips a preset profile losslessly (editable → persisted → editable)', () => {
    const before = ed({
      slot: 2,
      name: 'Swing',
      timeSig: { kind: 'preset', value: '3/4' },
      pattern: [
        { midi: 36, velocity: 110 },
        { midi: 38, velocity: 95 },
        { midi: 50, velocity: 95 },
      ],
      subdivisions: 'triplet',
      subdivisionVoice: { midi: 44, velocity: 60 },
    });
    const persisted = editableToMetroProfile(before);
    const after = metroProfileToEditable(persisted, 2);
    expect(after).toEqual(before);
  });

  it('custom profile: numerator survives (as pattern length); denominator is notation-only → 4', () => {
    const before = ed({ timeSig: { kind: 'custom', num: 5, den: 8 }, pattern: buildDefaultPattern(5) });
    const persisted = editableToMetroProfile(before);
    expect(persisted.timeSig).toBe('custom');
    const after = metroProfileToEditable(persisted, 1);
    expect(after.timeSig.kind).toBe('custom');
    if (after.timeSig.kind === 'custom') {
      expect(after.timeSig.num).toBe(5); // numerator preserved via pattern.length
      expect(after.timeSig.den).toBe(4); // documented: denominator is notation-only, reset to 4
    }
    expect(after.pattern).toEqual(before.pattern);
    expect(after.subdivisions).toBe(before.subdivisions);
    expect(after.name).toBe(before.name);
    expect(after.subdivisionVoice).toEqual(before.subdivisionVoice);
  });

  it('drops the v1.4-reserved per-cell `channel` field on round-trip (v1.3 omits it)', () => {
    const before = ed();
    before.pattern[0] = {
      ...before.pattern[0],
      channel: ('drums' as unknown as NonNullable<BeatInstrument['channel']>),
    };
    const after = metroProfileToEditable(editableToMetroProfile(before), 1);
    expect(after.pattern[0].channel).toBeUndefined();
  });

  it('coerces an empty name to "User <slot>" in both directions', () => {
    const persisted = editableToMetroProfile(ed({ slot: 3, name: '' }));
    expect(persisted.name).toBe('User 3');
    const after = metroProfileToEditable({ ...persisted, name: '' }, 4);
    expect(after.name).toBe('User 4');
  });

  it('persisted bpm is always BPM_DEFAULT (editable carries no per-profile tempo)', () => {
    expect(editableToMetroProfile(ed()).bpm).toBe(100);
  });

  it('clamps out-of-range drum midi / velocity on the way to persisted', () => {
    const before = ed({
      pattern: [
        { midi: 999, velocity: 999 },
        { midi: -5, velocity: 0 },
        { midi: 50, velocity: 95 },
        { midi: 56, velocity: 95 },
      ],
      subdivisionVoice: { midi: 999, velocity: 0 },
    });
    const p = editableToMetroProfile(before);
    expect(p.pattern[0].midi).toBe(81);     // 999 → MIDI_HI
    expect(p.pattern[1].midi).toBe(35);     // -5 → MIDI_LO
    expect(p.pattern[0].velocity).toBe(127); // 999 → max
    expect(p.pattern[1].velocity).toBe(1);   // 0 → min
    expect(p.subMidi).toBe(81);  // 999 → MIDI_HI
    expect(p.subVel).toBe(1);    // 0 → min
  });
});

// ---------------------------------------------------------------------------
// applyProfilePatch — editing a profile, with pattern resize on time-sig change
// ---------------------------------------------------------------------------

describe('applyProfilePatch', () => {
  it('shrinks the pattern when the numerator drops, preserving the head', () => {
    const prev = ed({ timeSig: { kind: 'preset', value: '4/4' }, pattern: buildDefaultPattern(4) });
    const next = applyProfilePatch(prev, { timeSig: { kind: 'preset', value: '3/4' } });
    expect(beatsPerBar(next.timeSig)).toBe(3);
    expect(next.pattern).toHaveLength(3);
    expect(next.pattern[0]).toEqual(prev.pattern[0]);
  });
  it('grows the pattern when the numerator rises, default-filling the tail', () => {
    const prev = ed({ timeSig: { kind: 'preset', value: '3/4' }, pattern: buildDefaultPattern(3) });
    const next = applyProfilePatch(prev, { timeSig: { kind: 'preset', value: '4/4' } });
    expect(next.pattern).toHaveLength(4);
    expect(next.pattern.slice(0, 3)).toEqual(prev.pattern);
  });
  it('leaves the pattern untouched for a non-timeSig patch (e.g. rename)', () => {
    const prev = ed();
    const next = applyProfilePatch(prev, { name: 'Renamed' });
    expect(next.name).toBe('Renamed');
    expect(next.pattern).toBe(prev.pattern); // same reference — not resized
  });
  it('does NOT resize when the new time-sig has the same beat count (4/8 → 4/4)', () => {
    const prev = ed({ timeSig: { kind: 'custom', num: 4, den: 8 }, pattern: buildDefaultPattern(4) });
    const next = applyProfilePatch(prev, { timeSig: { kind: 'preset', value: '4/4' } });
    expect(next.pattern).toBe(prev.pattern);
  });
  it('when a patch carries BOTH timeSig and a wrong-length pattern, resizes the patched-in pattern to fit', () => {
    // Characterizes the merge order: the patched pattern is spread in first, then
    // resized to the new numerator. (Documents current behaviour; flags any change.)
    const prev = ed({ timeSig: { kind: 'preset', value: '4/4' }, pattern: buildDefaultPattern(4) });
    const next = applyProfilePatch(prev, {
      timeSig: { kind: 'preset', value: '4/4' },
      pattern: buildDefaultPattern(3),
    });
    expect(next.pattern).toHaveLength(4);
  });
});
