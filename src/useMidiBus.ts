/**
 * useMidiBus — single-owner MIDI bus over @local/raw-audio-output.
 *
 * v1.3.0 Wave 1A (per `docs/v1.3-state-machine-scrub.md` §6.5 and
 * `docs/v1.3-council-decisions.md`). The bus is the SOLE owner of the
 * raw-audio-output synth singleton. Consumer hooks (useDrone, usePitchPipes,
 * useMetronome) talk to the bus through channel-role handles; they never
 * import the synth module directly.
 *
 * This file is the React-bound thin wrapper. All bus mechanics live in
 * `useMidiBusCore.ts` so the Node test runner can exercise the core
 * contracts without pulling in the native module.
 *
 * Architectural invariants — see `useMidiBusCore.ts` for the full doc;
 * U21 / U23 / G13 are codified there and tested in
 * `src/__tests__/useMidiBus.test.ts`.
 */

import { useEffect, useMemo, useState } from 'react';
import synth from '@local/raw-audio-output';
import { log } from './log';
import {
  createMidiBusCore,
  type MidiBusCore,
  type MidiBusState,
  type SynthPort,
} from './useMidiBusCore';

// Re-export the public surface so callers can import from a single module.
export {
  CHANNEL_OF_ROLE,
  createMidiBusCore,
  type ChannelRole,
  type ChannelHandle,
  type MidiBusState,
  type BusEvent,
  type BusEventKind,
  type SynthPort,
  type DrumFallbackPort,
  type MidiBusCore,
  type MidiBusCoreOptions,
} from './useMidiBusCore';

/**
 * React-bound MIDI bus. Owns the synth singleton lifecycle for the lifetime
 * of the hook (typically App.tsx). Subsequent consumer hooks (useDrone,
 * usePitchPipes, useMetronome) reserve channels from the returned object.
 *
 * The current Wave 1A landing creates the bus WITHOUT a drum-WAV fallback
 * port; useMetronome is still off-bus and owns its own WAV players until
 * Wave 1C migrates it. The G13 routing logic in the core is therefore a
 * no-op until a fallback port is injected (Wave 1C concern).
 */
export function useMidiBus(): MidiBusState {
  // `ready` is the only reactive surface. The rest of the bus is imperative.
  const [ready, setReady] = useState<boolean>(() => {
    try {
      return synth.isReady();
    } catch {
      return false;
    }
  });

  // Construct the core exactly once per hook instance. The unmount effect
  // below tears it down explicitly so we don't rely on useMemo's "may
  // forget" semantics for cleanup.
  const core = useMemo<MidiBusCore>(() => {
    return createMidiBusCore({
      synth: synth as SynthPort,
      drumFallback: null, // Wave 1C — useMetronome migration owns this wiring.
      logger: log,
      onReadyChange: (next) => {
        // The ready-edge fires from inside the prepareAsync resolution path,
        // well outside any noteOn call stack, so a microtask hop here is
        // safe and matches React's render-scheduling expectations. U21
        // applies to LISTENERS on noteOn/etc., not to the ready latch.
        Promise.resolve().then(() => setReady(next));
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Final teardown.
  useEffect(() => {
    return () => {
      core.dispose();
    };
  }, [core]);

  // v1.3.4 B1 — split identity from reactive value. The INTERFACE object is
  // built once from `core` (stable useMemo with no `ready` dep) so consumers
  // with `[bus, ...]` deps never see identity churn when `ready` flips.
  // `ready` is stitched in as a plain own-property in a second step: the
  // getter approach inside the first memo would re-close over a stale
  // `ready` binding — plain property assignment is simpler and correct.
  const stableInterface = useMemo(
    () => ({
      reserve:         core.reserve.bind(core),
      setMasterMute:   core.setMasterMute.bind(core),
      setMasterGain:   core.setMasterGain.bind(core),
      on:              core.on.bind(core),
      // v1.4 — Belt 1 + Belt 2 surface.
      clearScheduled:  core.clearScheduled.bind(core),
      getCurrentFrame: core.getCurrentFrame.bind(core),
      atMsToAtFrame:   core.atMsToAtFrame.bind(core),
      // v1.4 wave-3 — force-repeg surface for AppState resume.
      repegFrameClock: core.repegFrameClock.bind(core),
    }),
    [core],
  );

  // Returned object: stable interface + current ready value. Object identity
  // changes only when `stableInterface` or `ready` changes. `stableInterface`
  // never changes (core is mount-stable), so identity flips only on the
  // ready → true transition — a single, unavoidable edge.
  return useMemo<MidiBusState>(
    () => ({ ...stableInterface, ready }),
    [stableInterface, ready],
  );
}
