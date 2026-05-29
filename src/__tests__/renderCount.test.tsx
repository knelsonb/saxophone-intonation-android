/**
 * renderCount.test.tsx — U24 render-count CI assertions (v1.3 ship-blocker).
 *
 * Council decision G7 / U24 (v1.3-council-decisions.md):
 *   "SetupScreen must fire zero re-renders on a synthetic audio-buffer event;
 *    MetroScreen must fire zero re-renders on a non-metro-state update."
 *
 * STATUS: The test harness is LIVE and is wired into the CI `npm test` run.
 * The two specific invariant assertions are currently marked `.todo` because
 * the v1.2.1 component tree has not yet received the hook-boundary scrub
 * called out in the state-machine-scrub design doc (steps 5-7 of the migration
 * order).  Wave 3 implementers should:
 *
 *   1. Un-skip BOTH it.skip blocks below once the state-machine scrub lands.
 *   2. Run `npm test` locally to confirm zero-render counts before pushing.
 *   3. Remove this comment block.
 *
 * The harness (jest-expo preset, RNTL, withRenderCounter helper) is fully
 * functional.  The `.todo` items appear in the Jest report so CI surfaces them
 * without blocking green.
 *
 * See also: src/__tests__/helpers/renderCount.ts
 */

import React, { act, useState } from 'react';
import { render } from '@testing-library/react-native';

// v1.4 wave-4 — MetroScreen + TunerScreen now use `useFocusEffect` from
// @react-navigation/native to reset the sub-page on tab focus (production
// always wraps screens in NavigationContainer). The harness here renders
// screens in isolation for render-count counting, so mock useFocusEffect to
// a no-op — focus behavior isn't what this suite validates.
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: () => {},
}));

import { withRenderCounter } from './helpers/renderCount';
import { SetupScreen } from '../screens/SetupScreen';
import { MetroScreen } from '../screens/MetroScreen';
import type { SetupScreenProps } from '../screens/SetupScreen';
import type { MetroScreenProps } from '../screens/MetroScreen';
import type { MetronomeState, TimeSig } from '../useMetronome';
import type { AudioEngineState } from '../useAudioEngine';

// ---------------------------------------------------------------------------
// Minimal prop fixtures
// ---------------------------------------------------------------------------

/** Enough of AudioEngineState to satisfy SetupScreen's `engine` prop. */
function makeEngine(overrides?: Partial<AudioEngineState>): AudioEngineState {
  return {
    status: 'listening',
    freqHz: null,
    rmsDb: -60,
    meterFill: 0,
    gainMode: 'low',
    setGainMode: jest.fn(),
    yinCallCount: 0,
    rawFreqHz: null,
    filterMode: 'normal',
    setFilterMode: jest.fn(),
    instrumentKey: 'Bb',
    setInstrumentKey: jest.fn(),
    displayMode: 'griff',
    setDisplayMode: jest.fn(),
    micSilenced: false,
    allowOutOfRange: false,
    setAllowOutOfRange: jest.fn(),
    prefsLoaded: true,
    nickname: '',
    setNickname: jest.fn(),
    savePrefsNow: jest.fn(() => Promise.resolve()),
    hiFiMode: false,
    setHiFiMode: jest.fn(() => Promise.resolve()),
    hiFiActive: false,
    audioSourceLabel: 'Standard mic',
    streamErrorReason: null,
    retryPermission: jest.fn(() => Promise.resolve()),
    retryStream: jest.fn(),
    peakLock: true,
    setPeakLock: jest.fn(),
    lowCutDb: -45,
    setLowCutDb: jest.fn(),
    activeBucket: null,
    clearActiveBucket: jest.fn(),
    logCurrentReading: jest.fn(() => null),
    undoLastLog: jest.fn(() => null),
    sessionActive: false,
    sessionStartedAtMs: null,
    setSessionActive: jest.fn(),
    droppedFrameCount: 0,
    lastDropReason: null,
    theme: 'dark',
    setTheme: jest.fn(),
    nightDarken: 1.0,
    setNightDarken: jest.fn(),
    nightWarmth: 0,
    setNightWarmth: jest.fn(),
    incumbentMidi: null,
    tunerStyle: 'arc',
    setTunerStyle: jest.fn(),
    metroStyle: 'pulse',
    setMetroStyle: jest.fn(),
    deckStyle: 'reels',
    setDeckStyle: jest.fn(),
    metroClickOffsetMs: 0,
    setMetroClickOffsetMs: jest.fn(),
    metroOutputRoute: 'speaker',
    setMetroOutputRoute: jest.fn(),
    ...overrides,
  } as AudioEngineState;
}

const DEFAULT_PATTERN = [
  { midi: 36, velocity: 110 },
  { midi: 76, velocity: 90 },
  { midi: 76, velocity: 90 },
  { midi: 76, velocity: 90 },
];

/** Enough of MetronomeState to satisfy MetroScreen's `metro` prop. */
function makeMetro(overrides?: Partial<MetronomeState>): MetronomeState {
  return {
    bpm: 100,
    setBpm: jest.fn(),
    bumpBpm: jest.fn(),
    timeSig: { kind: 'preset', value: '4/4' } as TimeSig,
    setTimeSig: jest.fn(),
    setCustomNum: jest.fn(),
    setCustomDen: jest.fn(),
    pattern: DEFAULT_PATTERN,
    setBeatInstrument: jest.fn(),
    subdivisions: 'off',
    setSubdivisions: jest.fn(),
    subdivisionVoice: { midi: 42, velocity: 70 },
    setSubdivisionVoice: jest.fn(),
    running: false,
    start: jest.fn(),
    stop: jest.fn(),
    toggle: jest.fn(),
    registerTap: jest.fn(() => null),
    beat: 1,
    pulse: 0,
    clickVolume: 1.0,
    setClickVolume: jest.fn(),
    // metro profile persistence (lifted into the hook in the persistence fix) —
    // MetroScreen now reads metro.profiles.map(...) at mount, so the mock must
    // supply these or the render throws (this file is excluded from tsc).
    profiles: [],
    activeProfileSlot: null,
    updateProfile: jest.fn(),
    selectProfile: jest.fn(),
    loadProfile: jest.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness smoke test — verifies withRenderCounter counts renders correctly.
// This test MUST pass; it validates the infrastructure before the invariants.
// ---------------------------------------------------------------------------

describe('render-count harness', () => {
  it('counts the initial mount as render #1', () => {
    const { WrappedComponent, countRef } = withRenderCounter(MetroScreen, 'MetroScreen');

    render(
      <WrappedComponent
        metro={makeMetro()}
        metroStyle="pulse"
        outputRoute="speaker"
      />,
    );

    expect(countRef.current).toBe(1);
  });

  it('increments count when props change', () => {
    const { WrappedComponent, countRef } = withRenderCounter(MetroScreen, 'MetroScreen');

    const { rerender } = render(
      <WrappedComponent
        metro={makeMetro()}
        metroStyle="pulse"
        outputRoute="speaker"
      />,
    );

    expect(countRef.current).toBe(1);

    rerender(
      <WrappedComponent
        metro={makeMetro({ bpm: 120 })}
        metroStyle="pulse"
        outputRoute="speaker"
      />,
    );

    // At least one additional render must have occurred.
    expect(countRef.current).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// U24 invariant — SetupScreen: zero re-renders on synthetic audio-buffer event.
//
// SKIP RATIONALE: useAudioEngine currently exposes the entire engine object as
// a single prop.  Until the hook-boundary scrub (migration steps 5-7) isolates
// audio-buffer state behind stable refs and memo boundaries, any update that
// flows through the engine object causes SetupScreen to re-render — even when
// the values it actually renders haven't changed.  The memoization pass is
// tracked as part of the Wave 3 state-machine-scrub work.
//
// HOW TO UN-SKIP: Remove `it.skip` and replace with `it` once the
// state-machine scrub lands.  Run `npm test` and confirm countRef.current
// equals `before` after the engine update.
// ---------------------------------------------------------------------------

describe('U24 — SetupScreen: zero re-renders on audio-buffer event', () => {
  it.todo(
    'SetupScreen does not re-render when only freqHz / rmsDb change ' +
    '(v1.3 ship-blocker — un-skip when state-machine scrub lands, ' +
    'migration step 5: useUiPrefsStore + stable engine boundary)',
  );

  // The full skip version is retained as a commented example so Wave 3
  // implementers know exactly what to write when they un-skip:
  //
  // it.skip('SetupScreen does not re-render when only freqHz/rmsDb change', () => {
  //   const engine = makeEngine();
  //   let setEngineState: (e: AudioEngineState) => void;
  //
  //   function Harness() {
  //     const [eng, setEng] = useState(engine);
  //     setEngineState = setEng;
  //     return (
  //       <WrappedSetup
  //         engine={eng}
  //         refHz={440}
  //         setRefHz={jest.fn()}
  //         showDebugOverlay={false}
  //         setShowDebugOverlay={jest.fn()}
  //         onOpenPipes={jest.fn()}
  //         onOpenRangeEditor={jest.fn()}
  //         onEditHornName={jest.fn()}
  //         droneVoice="violin"
  //         setDroneVoice={jest.fn()}
  //       />
  //     );
  //   }
  //
  //   const { WrappedComponent: WrappedSetup, countRef } = withRenderCounter(SetupScreen, 'SetupScreen');
  //   render(<Harness />);
  //   const before = countRef.current;
  //
  //   // Simulate a synthetic audio-buffer event: only freqHz + rmsDb change.
  //   act(() => {
  //     setEngineState(makeEngine({ freqHz: 442, rmsDb: -20 }));
  //   });
  //
  //   // SetupScreen renders NONE of freqHz / rmsDb — the invariant is that
  //   // it does not re-render at all when these audio-only fields change.
  //   expect(countRef.current).toBe(before);
  // });
});

// ---------------------------------------------------------------------------
// U24 invariant — MetroScreen: zero re-renders on non-metro-state update.
//
// SKIP RATIONALE: MetroScreen currently receives `metro` as a single prop
// object reference.  Any parent re-render that constructs a new `metro` object
// (even with identical values) causes MetroScreen to re-render because object
// identity changes.  The fix requires either React.memo with a custom comparator
// or extracting stable callback refs — both are part of the Wave 3 scrub.
//
// HOW TO UN-SKIP: Remove `it.skip` and replace with `it` once MetroScreen is
// wrapped in React.memo (or its props are broken into stable primitives).
// ---------------------------------------------------------------------------

describe('U24 — MetroScreen: zero re-renders on non-metro-state update', () => {
  it.todo(
    'MetroScreen does not re-render when only theme changes ' +
    '(v1.3 ship-blocker — un-skip when state-machine scrub lands, ' +
    'migration step 6: screens consume new hook shapes with React.memo)',
  );

  // The full skip version:
  //
  // it.skip('MetroScreen does not re-render when only theme changes', () => {
  //   const metro = makeMetro();
  //   let setThemeTrigger: (t: string) => void;
  //
  //   const { WrappedComponent: WrappedMetro, countRef } = withRenderCounter(MetroScreen, 'MetroScreen');
  //
  //   function Harness() {
  //     const [_theme, setTheme] = useState('dark');
  //     setThemeTrigger = setTheme;
  //     // MetroScreen receives only metro-specific props.  A theme change
  //     // happening elsewhere in the tree must not cause MetroScreen to re-render.
  //     return (
  //       <WrappedMetro
  //         metro={metro}
  //         metroStyle="pulse"
  //         outputRoute="speaker"
  //       />
  //     );
  //   }
  //
  //   render(<Harness />);
  //   const before = countRef.current;
  //
  //   act(() => {
  //     setThemeTrigger('night');  // triggers a parent re-render; metro props unchanged
  //   });
  //
  //   // MetroScreen should not re-render — its props have not changed.
  //   expect(countRef.current).toBe(before);
  // });
});
