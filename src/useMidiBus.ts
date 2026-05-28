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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import synth from '@local/raw-audio-output';
import { log } from './log';
import {
  createMidiBusCore,
  routeLatencyMs,
  type MetroOutputRoute,
  type MidiBusCore,
  type MidiBusState,
  type SynthPort,
} from './useMidiBusCore';

// Re-export the public surface so callers can import from a single module.
export {
  CHANNEL_OF_ROLE,
  createMidiBusCore,
  routeLatencyMs,
  type MetroOutputRoute,
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
    // Peg the frame clock at the device-native output rate the synth actually
    // renders at (queried from the native module). If we render at 48 kHz but
    // peg at 44.1 kHz, every scheduled atFrame is off by 8.8%. Read once at
    // construction (synchronous native Function, same as isReady() above);
    // falls back to the core's default if the port doesn't expose it (tests).
    let nativeSampleRate: number | undefined;
    try {
      nativeSampleRate = synth.getSampleRate?.();
    } catch {
      nativeSampleRate = undefined;
    }
    log.i('Bus', 'frame-clock sampleRate', { nativeSampleRate: nativeSampleRate ?? 'default(44100)' });
    return createMidiBusCore({
      synth: synth as SynthPort,
      drumFallback: null, // Wave 1C — useMetronome migration owns this wiring.
      logger: log,
      sampleRate: nativeSampleRate,
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

  // v1.4.x P3 — audio route recovery. Two failure modes after a headphone /
  // Bluetooth / USB plug or unplug:
  //   (a) the AudioTrack keeps running but briefly pauses → the render-frame
  //       counter stalls → the bus's frame-clock peg goes stale and the drift
  //       gate refuses to re-peg → scheduled noteOnAt commands land out-of-
  //       window and drop (silent + still). Fix: force-repeg on the native
  //       `audioRouteChanged` signal so the next beats anchor to the live clock.
  //   (b) the track dies (ERROR_DEAD_OBJECT / INVALID_OPERATION) → the render
  //       thread exits and the counter freezes forever. Fix: rebuild via the
  //       existing, tested stop()/start() path, then drop the stale queue and
  //       force-repeg. Throttled to avoid restart storms on a flapping device.
  // v1.4.x #167 — automatic output-latency compensation. useMetronome (audio
  // scheduling) and PendulumDisplay (arm phase-lead) read getCompensationLatencyMs()
  // to align audio + visuals to the HEARD moment. We MEASURE the real write->hear
  // latency (synth.getOutputLatencyMs, from getTimestamp) but HOLD it: a change is
  // only committed when it moves more than a 30 ms deadband, and the watchdog only
  // resyncs after a sustained >5 s excursion. So the held value is piecewise-
  // constant — its measurement jitter never reaches the animation. 0 until the
  // first valid measurement (consumers fall back to their per-route guess).
  const compLatencyRef = useRef(0);
  // #167 — the user's selected output route, pushed in by App.tsx via
  // setOutputRoute (the route name is NOT in the native route-change event,
  // which carries only {kind}). Held in a ref — NEVER a memo dep — so a route
  // change updates the cold-start guess with zero re-render and never churns
  // the build-once bus interface (mirrors compLatencyRef's pattern).
  const routeRef = useRef<MetroOutputRoute>('speaker');
  const outOfSyncSinceRef = useRef<number | null>(null);
  const LAT_DEADBAND_MS = 30;
  const LAT_DEBOUNCE_MS = 5000;
  const commitLatency = useCallback((force: boolean): void => {
    let raw = -1;
    try { raw = synth.getOutputLatencyMs?.() ?? -1; } catch { raw = -1; }
    if (raw < 0) return; // not warm / unsupported — keep the held value
    const held = compLatencyRef.current;
    if (force || Math.abs(raw - held) > LAT_DEADBAND_MS) {
      compLatencyRef.current = raw;
      outOfSyncSinceRef.current = null;
      log.i('Bus', 'latency-comp set', { heldMs: Math.round(raw), prevMs: Math.round(held), force });
    }
  }, []);

  const lastRecoveryRef = useRef(0);
  useEffect(() => {
    // #167 — track the settle-remeasure timers so they can't fire commitLatency
    // (a native-bridge call) after this effect/component tears down.
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    const scheduleMeasure = () => {
      const id = setTimeout(() => { pendingTimers.delete(id); commitLatency(true); }, 900);
      pendingTimers.add(id);
    };
    const routeSub = synth.addRouteChangeListener?.((e) => {
      log.d('Bus', 'audioRouteChanged — force-repeg frame clock', e);
      try { core.repegFrameClock({ force: true }); } catch { /* ignore */ }
      // #167 — a route change is a known latency step (speaker<->BT etc.).
      // Re-measure after the new route settles, then commit if it moved.
      scheduleMeasure();
    });
    const errSub = synth.addErrorListener((e) => {
      const reason = e?.reason ?? '';
      if (!/DEAD_OBJECT|INVALID_OPERATION/.test(reason)) return;
      const now = Date.now();
      if (now - lastRecoveryRef.current < 3000) {
        log.w('Bus', 'render-error recovery throttled', { reason });
        return;
      }
      lastRecoveryRef.current = now;
      log.w('Bus', 'render thread died — rebuilding AudioTrack + re-peg', { reason });
      try { synth.stop(); } catch { /* ignore */ }
      try { synth.start(); } catch { /* ignore */ }
      try { core.clearScheduled(); } catch { /* ignore */ }
      try { core.repegFrameClock({ force: true }); } catch { /* ignore */ }
      // #167 — fresh AudioTrack = fresh buffer/HAL config; re-measure latency.
      scheduleMeasure();
    });
    return () => {
      try { routeSub?.remove(); } catch { /* ignore */ }
      try { errSub.remove(); } catch { /* ignore */ }
      pendingTimers.forEach(clearTimeout);
      pendingTimers.clear();
    };
  }, [core, commitLatency]);

  // #167 — latency watchdog. Low-rate poll (NO per-frame getTimestamp): the
  // native side already computes latency ~1 Hz; we just sample the cached value.
  // Holds the compensation steady inside a 30 ms deadband; only resyncs when the
  // measured latency sits >30 ms off the held value for >5 s continuously (a
  // sustained change, not a transient). Plus a one-shot settle-measure on mount.
  useEffect(() => {
    const initial = setTimeout(() => commitLatency(true), 1500);
    const watchdog = setInterval(() => {
      let raw = -1;
      try { raw = synth.getOutputLatencyMs?.() ?? -1; } catch { raw = -1; }
      if (raw < 0) { outOfSyncSinceRef.current = null; return; }
      const held = compLatencyRef.current;
      if (Math.abs(raw - held) > LAT_DEADBAND_MS) {
        const now = Date.now();
        if (outOfSyncSinceRef.current == null) {
          outOfSyncSinceRef.current = now;
        } else if (now - outOfSyncSinceRef.current > LAT_DEBOUNCE_MS) {
          log.w('Bus', 'latency-comp watchdog resync', { rawMs: Math.round(raw), heldMs: Math.round(held) });
          commitLatency(true);
        }
      } else {
        outOfSyncSinceRef.current = null;
      }
    }, 1000);
    return () => { clearTimeout(initial); clearInterval(watchdog); };
  }, [commitLatency]);

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
      // v1.4.x #167 — EFFECTIVE output-latency compensation (ms): the held
      // measurement once warm, else the per-route cold-start guess. Both
      // consumers read this one value so audio + visuals always compensate by
      // the same amount. O(1) — two ref derefs + a map lookup, no JNI.
      getCompensationLatencyMs: () => {
        const held = compLatencyRef.current;
        return held > 0 ? held : routeLatencyMs(routeRef.current);
      },
      // #167 — receive the user's route selection (see routeRef). Plain ref
      // write: updates the cold-start guess without re-rendering or rebuilding
      // this interface.
      setOutputRoute: (route: MetroOutputRoute) => { routeRef.current = route; },
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
