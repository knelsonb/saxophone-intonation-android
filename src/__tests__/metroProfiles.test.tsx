/**
 * metroProfiles.test.tsx — unit coverage for the metro-profile persistence
 * serialization layer in src/storage/prefs.ts.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Metro-profile persistence was the single CRITICAL finding of the v1.4
 * polish audit (frodo): user profiles were lost on restart. The fix lifted
 * the 4 profiles into useMetronome and round-trips them through the
 * `metroProfilesJson` pref via `serializeMetroProfiles` (write) and
 * `loadMetroProfiles` (read/validate). Before this file there was ZERO unit
 * coverage of that round-trip or of its U22 safety invariant.
 *
 * This is a JEST test (.test.tsx), NOT a legacy `.test.ts` node script:
 *   - scripts/legacy-tests.js globs only `*.test.ts`, so it skips this file.
 *   - jest (jest-expo preset) mocks `@react-native-async-storage/async-storage`,
 *     so we can import the REAL functions from prefs.ts and test the actual
 *     production code (no re-implemented copy that can silently drift).
 *
 * SCOPE / HONESTY: this verifies the serialization LOGIC (the heart of
 * "profiles survive a save→hydrate round-trip"). The full cold-restart
 * integration (AsyncStorage write → process death → re-read → live state)
 * is a separate on-device/instrumented concern (task #14) and is NOT claimed
 * here.
 */

import { loadMetroProfiles, serializeMetroProfiles } from '../storage/prefs';
import type { MetroProfile } from '../storage/prefs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fully-valid 4/4 profile (pattern length 4 == numerator). */
function validProfile(overrides?: Partial<MetroProfile>): MetroProfile {
  return {
    name: 'User 1',
    bpm: 120,
    timeSig: '4/4',
    pattern: [
      { midi: 36, velocity: 110 },
      { midi: 76, velocity: 90 },
      { midi: 76, velocity: 90 },
      { midi: 76, velocity: 90 },
    ],
    subdivisions: 'off',
    subMidi: 42,
    subVel: 70,
    ...overrides,
  };
}

/** Exactly 4 valid profiles — the only shape loadMetroProfiles accepts. */
function fourValid(): MetroProfile[] {
  return [
    validProfile({ name: 'User 1', bpm: 60, timeSig: '4/4' }),
    validProfile({
      name: 'User 2',
      bpm: 90,
      timeSig: '3/4',
      pattern: [
        { midi: 36, velocity: 110 },
        { midi: 76, velocity: 90 },
        { midi: 76, velocity: 90 },
      ],
    }),
    validProfile({
      name: 'Waltz',
      bpm: 180,
      timeSig: '6/8',
      pattern: [
        { midi: 36, velocity: 110 },
        { midi: 76, velocity: 80 },
        { midi: 76, velocity: 80 },
        { midi: 42, velocity: 100 },
        { midi: 76, velocity: 80 },
        { midi: 76, velocity: 80 },
      ],
      subdivisions: 'triplet',
    }),
    validProfile({
      name: 'Odd',
      bpm: 300,
      timeSig: 'custom',
      pattern: [
        { midi: 36, velocity: 120 },
        { midi: 76, velocity: 70 },
        { midi: 76, velocity: 70 },
        { midi: 76, velocity: 70 },
        { midi: 76, velocity: 70 },
      ],
      subdivisions: '16th',
      subMidi: 37,
      subVel: 50,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Round-trip fidelity — the core "survives persist → hydrate" guarantee
// ---------------------------------------------------------------------------

describe('metro profiles — serialize/load round-trip', () => {
  it('round-trips 4 valid profiles losslessly (the restart-survival core)', () => {
    const input = fourValid();
    const json = serializeMetroProfiles(input);
    expect(typeof json).toBe('string');
    const out = loadMetroProfiles(json);
    expect(out).toEqual(input);
  });

  it('preserves every preset time-sig and its matching pattern length', () => {
    for (const ts of ['2/4', '3/4', '4/4', '6/8'] as const) {
      const num = { '2/4': 2, '3/4': 3, '4/4': 4, '6/8': 6 }[ts];
      const pattern = Array.from({ length: num }, (_, i) => ({
        midi: i === 0 ? 36 : 76,
        velocity: i === 0 ? 110 : 90,
      }));
      const input = [
        validProfile({ timeSig: ts, pattern }),
        validProfile({ timeSig: ts, pattern }),
        validProfile({ timeSig: ts, pattern }),
        validProfile({ timeSig: ts, pattern }),
      ];
      const out = loadMetroProfiles(serializeMetroProfiles(input));
      expect(out).not.toBeNull();
      expect(out![0].timeSig).toBe(ts);
      expect(out![0].pattern).toHaveLength(num);
    }
  });

  it('accepts an already-parsed array (not just a JSON string)', () => {
    // loadMetroProfiles takes `unknown` and handles both forms.
    const input = fourValid();
    expect(loadMetroProfiles(input)).toEqual(input);
  });

  it('round-trips inclusive boundary values (bpm 20/300, midi 35/81, vel 1/127)', () => {
    // validateProfile uses strict < / > comparisons, so the bounds themselves
    // are VALID. An off-by-one regression (<= / >=) would null these out and
    // the toEqual below would fail.
    const bounds = validProfile({
      name: 'Bounds',
      bpm: 20,
      timeSig: '4/4',
      pattern: [
        { midi: 35, velocity: 1 },
        { midi: 81, velocity: 127 },
        { midi: 35, velocity: 127 },
        { midi: 81, velocity: 1 },
      ],
      subMidi: 35,
      subVel: 1,
    });
    const input = [
      bounds,
      validProfile({ bpm: 300, subMidi: 81, subVel: 127 }),
      validProfile(),
      validProfile(),
    ];
    expect(loadMetroProfiles(serializeMetroProfiles(input))).toEqual(input);
  });

  it('tolerates unknown keys on load but serialize drops them (forward-compat)', () => {
    const withExtra = fourValid().map((p) => ({ ...p, futureFlag: true }));
    const loaded = loadMetroProfiles(JSON.stringify(withExtra));
    expect(loaded).not.toBeNull();
    expect((loaded![0] as Record<string, unknown>).futureFlag).toBe(true);
    // Re-serializing yields only the canonical shape — unknown keys are stripped.
    const reloaded = loadMetroProfiles(serializeMetroProfiles(loaded!));
    expect(reloaded).not.toBeNull();
    expect((reloaded![0] as Record<string, unknown>).futureFlag).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// U22 / F7 safety invariant — a single bad profile aborts the WHOLE load,
// so the caller falls back to legacy fields and NEVER overwrites the user's
// working settings with a partially-applied / defaulted array.
// ---------------------------------------------------------------------------

describe('metro profiles — U22 reject-and-fall-back invariant (returns null)', () => {
  it('rejects non-array JSON', () => {
    expect(loadMetroProfiles(JSON.stringify({ not: 'an array' }))).toBeNull();
    expect(loadMetroProfiles(JSON.stringify(42))).toBeNull();
    expect(loadMetroProfiles(JSON.stringify('string'))).toBeNull();
    // null / undefined passed directly (not as a JSON string) must also fall back.
    expect(loadMetroProfiles(null)).toBeNull();
    expect(loadMetroProfiles(undefined)).toBeNull();
  });

  it('rejects the wrong profile count (must be exactly 4)', () => {
    expect(loadMetroProfiles(serializeMetroProfiles(fourValid().slice(0, 3)))).toBeNull();
    expect(
      loadMetroProfiles(serializeMetroProfiles([...fourValid(), validProfile()])),
    ).toBeNull();
    expect(loadMetroProfiles('[]')).toBeNull();
  });

  it('rejects malformed JSON and the empty string', () => {
    expect(loadMetroProfiles('not json {')).toBeNull();
    expect(loadMetroProfiles('')).toBeNull();
  });

  it('rejects when ONE profile in an otherwise-valid 4 is bad (no partial apply)', () => {
    const mutators: Array<(p: MetroProfile[]) => void> = [
      (p) => { p[0] = { ...p[0], name: '' }; },                       // empty name
      (p) => { p[1] = { ...p[1], bpm: 19 }; },                        // bpm below 20
      (p) => { p[1] = { ...p[1], bpm: 301 }; },                       // bpm above 300
      (p) => { p[2] = { ...p[2], bpm: 120.5 }; },                     // non-integer bpm
      (p) => { p[2] = { ...p[2], timeSig: '5/4' as unknown as MetroProfile['timeSig'] }; }, // bad time-sig
      (p) => { p[3] = { ...p[3], subdivisions: 'quintuplet' as unknown as MetroProfile['subdivisions'] }; },
      (p) => { p[0] = { ...p[0], subMidi: 34 }; },                    // subMidi below 35
      (p) => { p[0] = { ...p[0], subVel: 200 }; },                    // subVel above 127
      (p) => { p[1] = { ...p[1], pattern: [{ midi: 200, velocity: 90 }, { midi: 76, velocity: 90 }, { midi: 76, velocity: 90 }] }; }, // midi out of range
      (p) => { p[1] = { ...p[1], pattern: [{ midi: 76, velocity: 0 }, { midi: 76, velocity: 90 }, { midi: 76, velocity: 90 }] }; },   // velocity below 1
      (p) => { (p as unknown[])[2] = null; },                          // a null where a profile object must be
    ];
    for (const mutate of mutators) {
      const profiles = fourValid();
      mutate(profiles);
      // Build the JSON by hand so serialize's clamping doesn't sanitize the
      // bad value away — we want loadMetroProfiles to face the raw bad data.
      expect(loadMetroProfiles(JSON.stringify(profiles))).toBeNull();
    }
  });

  it('rejects a preset profile whose pattern length != its numerator', () => {
    const profiles = fourValid();
    // 4/4 profile with only 3 beats — must be rejected.
    profiles[0] = { ...validProfile({ timeSig: '4/4' }), pattern: [
      { midi: 36, velocity: 110 }, { midi: 76, velocity: 90 }, { midi: 76, velocity: 90 },
    ] };
    expect(loadMetroProfiles(JSON.stringify(profiles))).toBeNull();
  });

  it('rejects an empty pattern even for custom time-sig', () => {
    const profiles = fourValid();
    profiles[3] = { ...validProfile({ timeSig: 'custom' }), pattern: [] };
    expect(loadMetroProfiles(JSON.stringify(profiles))).toBeNull();
  });

  it('accepts a custom time-sig with an arbitrary (non-zero) pattern length', () => {
    const profiles = fourValid();
    profiles[3] = {
      ...validProfile({ timeSig: 'custom' }),
      pattern: [
        { midi: 36, velocity: 110 },
        { midi: 76, velocity: 90 },
        { midi: 76, velocity: 90 },
        { midi: 76, velocity: 90 },
        { midi: 76, velocity: 90 },
        { midi: 76, velocity: 90 },
        { midi: 76, velocity: 90 },
      ],
    };
    const out = loadMetroProfiles(JSON.stringify(profiles));
    expect(out).not.toBeNull();
    expect(out![3].pattern).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// serializeMetroProfiles — defensive clamping (dirty input → valid output).
// The inverse contract: whatever serialize WRITES must read back validated.
// ---------------------------------------------------------------------------

describe('metro profiles — serialize defensive clamping', () => {
  it('coerces an empty name to a non-empty placeholder', () => {
    const profiles = fourValid();
    profiles[0] = { ...profiles[0], name: '' };
    const out = loadMetroProfiles(serializeMetroProfiles(profiles));
    expect(out).not.toBeNull();
    expect(out![0].name).toBe('User'); // the exact placeholder prefs.ts writes
  });

  it('clamps out-of-range bpm / midi / velocity so the result re-loads as valid', () => {
    const dirty: MetroProfile[] = [
      validProfile({ bpm: 9999 }),
      validProfile({ bpm: -5 }),
      validProfile({ subMidi: 999, subVel: 999 }),
      validProfile({
        pattern: [
          { midi: 999, velocity: 999 },
          { midi: -10, velocity: -10 },
          { midi: 76, velocity: 90 },
          { midi: 76, velocity: 90 },
        ],
      }),
    ];
    const out = loadMetroProfiles(serializeMetroProfiles(dirty));
    // The whole point: serialize sanitizes, so the round-trip is never null.
    expect(out).not.toBeNull();
    // Pin the SATURATED boundary values, not just "in range" — a clamp that
    // wrongly returned the default (100) would pass a mere <=300 check.
    expect(out![0].bpm).toBe(300); // 9999 saturates at BPM_MAX
    expect(out![1].bpm).toBe(20);  // -5 saturates at BPM_MIN
    expect(out![2].subMidi).toBe(81);  // 999 → MIDI_MAX
    expect(out![2].subVel).toBe(127);  // 999 → velocity max
    expect(out![3].pattern[0]).toEqual({ midi: 81, velocity: 127 }); // 999/999 saturate high
    expect(out![3].pattern[1]).toEqual({ midi: 35, velocity: 1 });   // -10/-10 saturate low
  });

  it('truncates fractional bpm/midi to integers (validator requires integers)', () => {
    const profiles = fourValid().map((p) => ({ ...p, bpm: 137.9 }));
    const out = loadMetroProfiles(serializeMetroProfiles(profiles));
    expect(out).not.toBeNull();
    expect(Number.isInteger(out![0].bpm)).toBe(true);
    expect(out![0].bpm).toBe(137); // Math.trunc, not round (138 would be a regression)
  });
});
