/**
 * useDrone — sustained reference-tone player that tracks the user's detected
 * pitch ± a semitone offset. TUNER screen only.
 *
 * v1.3 Wave 2A — bus migration. useDrone no longer imports `@local/raw-audio-
 * output`; all MIDI traffic flows through a `MidiBusState` handle reserved
 * for the `'drone'` role on mount. The hook is now a pure consumer of the
 * v1.3 MIDI bus (see `useMidiBus.ts`, `useMidiBusCore.ts`).
 *
 * Behaviour preserved from v1.1:
 *   - One indefinitely-sustained note per anchor.
 *   - Pitch chase via per-channel pitch-bend (±12 semitone envelope).
 *   - Re-anchor (noteOff → noteOn) when bend would exceed ±12.
 *   - Voice change → noteOff → programChange → noteOn re-attack so TSF picks
 *     up the new patch immediately rather than waiting for the next note-on.
 *   - A4 baseline pitch-bend so a drone tracking 442 Hz reference sounds at
 *     442, not TSF-default 440. Formula:
 *         1200 * log2(a4Hz / 440) / 100   semitones
 *
 * Removed in v1.3 Wave 2A (G12 + bus migration):
 *   - `mutedRef`, `setMuted`, background/foreground gain juggling. The bus
 *     owns master-mute (useDeck calls `bus.setMasterMute` directly during
 *     recording) and AppState gain handling at the synth singleton level.
 *     v1.0.1 BUG-4 (drone-bleed-during-record) is now bus-layer coordination,
 *     not this hook's concern.
 *   - `applyGain` / `targetVolumeRef` flowing into `synth.setMasterGain`.
 *     `setMasterGain` on the bus is GLOBAL — useDrone cannot use it for a
 *     per-channel slider without clobbering the metronome / pipes. Drone
 *     volume is now applied as a per-noteOn velocity scalar (vel * volume),
 *     so each consumer keeps its own gain envelope without fighting siblings.
 *   - Direct synth lifecycle (`prepareAsync`, `start`, `addReadyListener`).
 *     The bus owns the singleton; useDrone reserves a channel and trusts
 *     bus dispatch to drop ops issued before `bus.ready`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { midiToFrequency } from './audioGen';
import { resolveDroneVoice, DRONE_DEFAULT_VOICE } from './droneVoices';
import type { DroneVoice } from './droneVoices';
import type { ChannelHandle, MidiBusState } from './useMidiBus';
import { log } from './log';

// Full MIDI velocity for the held drone note. The `volume` arg is multiplied
// in at dispatch (per-channel scalar — see file header).
const DRONE_BASE_VELOCITY = 127;

// Chase-suspicion duck envelope. The duck temporarily lowers the drone's
// velocity so a misheard mic-bleed doesn't drag incumbent voting. Implemented
// as a re-issued noteOn at reduced velocity — TSF retriggers the envelope but
// the previous voice releases naturally, giving a soft attenuation rather
// than a click.
const DUCK_DEPTH = 0.3;
const DUCK_RAMP_IN_MS = 15;

// Compute the A4 reference pitch-bend in semitones. Baseline bend that maps
// MIDI A4 (440 Hz in TSF) onto the user's a4Hz preference.
function a4BendSemitones(a4Hz: number): number {
  if (!Number.isFinite(a4Hz) || a4Hz <= 0) return 0;
  return (1200 * Math.log2(a4Hz / 440)) / 100; // cents → semitones
}

// Clamp to MIDI velocity range (the bus also clamps, but we want a clean
// number to pass through and to feed the duck math).
function clampVel127(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 127) return 127;
  return v;
}

export interface DroneState {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
  /** Effective MIDI the drone is currently sounding (after offset). Null while idle. */
  currentMidi: number | null;
  /** Effective Hz the drone is currently sounding. Null while idle. */
  currentHz: number | null;
}

export interface UseDroneArgs {
  /** v1.3 MIDI bus. The drone reserves the `'drone'` channel role on mount. */
  bus: MidiBusState;
  incumbentMidi: number | null;
  a4Hz: number;
  /** v1.1 — DroneVoice.id string (resolved internally via resolveDroneVoice). */
  voice: string;
  /** Volume 0..1. Live — multiplied into noteOn velocity. */
  volume: number;
  /** Signed semitone offset added to incumbentMidi before synth. */
  semitones: number;
  /**
   * Drone-chase guard wiring. Engine reads the drone's currently sounding
   * MIDI to vote-exclude it from incumbent voting; engine calls back into
   * the drone's duck handler when it suspects mic leakage chase. Pass no-ops
   * to disable.
   */
  setDroneCurrentMidi: (midi: number | null) => void;
  installDroneDuckHandler: (fn: ((ms: number) => void) | null) => void;
}

export function useDrone({
  bus,
  incumbentMidi,
  a4Hz,
  voice,
  volume,
  semitones,
  setDroneCurrentMidi,
  installDroneDuckHandler,
}: UseDroneArgs): DroneState {
  const [enabled, setEnabledState] = useState(false);
  const [currentMidi, setCurrentMidi] = useState<number | null>(null);

  // Live-prop refs (so callbacks can read the freshest value without re-binding).
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const voiceIdRef = useRef(voice);
  voiceIdRef.current = voice;
  const a4Ref = useRef(a4Hz);
  a4Ref.current = a4Hz;
  const semitoneRef = useRef(semitones);
  semitoneRef.current = semitones;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Held MIDI — drone pitch sticks to this even when incumbentMidi goes null.
  const heldMidiRef = useRef<number | null>(null);

  // The MIDI note we actually issued noteOn for. Pitch-bend slides relative
  // to this anchor. When the chase target drifts outside ±12 of the anchor
  // (combined with the A4 baseline bend), we re-anchor: noteOff old; noteOn
  // new; reset bend.
  const sustainedMidiRef = useRef<number | null>(null);

  // Bus channel handle. Reserved on mount, released on unmount. May be null
  // if the bus denied the claim (U23 — silent, log only). When null, every
  // dispatch path early-returns; the hook becomes a no-op until remount.
  const channelRef = useRef<ChannelHandle | null>(null);

  // Track which program we last pushed so a voice change can short-circuit
  // when nothing changed (e.g. the effect re-runs because `enabled` toggled).
  const lastProgramRef = useRef<number | null>(null);

  // Stable refs for engine wiring callbacks.
  const setDroneCurrentMidiRef = useRef(setDroneCurrentMidi);
  setDroneCurrentMidiRef.current = setDroneCurrentMidi;
  const installDroneDuckHandlerRef = useRef(installDroneDuckHandler);
  installDroneDuckHandlerRef.current = installDroneDuckHandler;

  // v1.3.4 — trailing-throttle state for the live-volume effect. Prevents
  // flooding the C++ command queue during 60Hz slider drags (L2 perf fix).
  // lastVolApplyAtRef: timestamp of the most recent noteOn we actually fired.
  // volTrailingTimerRef: one-shot timer that catches the final slider position
  // when a throttled call was dropped.
  const lastVolApplyAtRef = useRef(0);
  const volTrailingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Duck timers (chase-guard suspicion). Drop velocity to DUCK_DEPTH for
  // `holdMs`, then restore. Implemented by re-issuing noteOn at the ducked
  // velocity (TSF retriggers; previous voice releases). No per-channel
  // setMasterGain because the bus's master-gain is global.
  const duckTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // v1.3.4 — monotonic duck epoch. Each requestDuck() captures the current
  // epoch and gates its restore callback on it still matching. cancelDuckTimers
  // bumps the epoch so any in-flight callback (already-dequeued but not yet
  // executed) becomes a no-op even when clearTimeout couldn't catch it. Fixes
  // the duck-restore-after-voice-change race that overwrote the new noteOn's
  // velocity with the stale duck-tail's full-volume restore.
  const duckEpochRef = useRef(0);
  const cancelDuckTimers = useCallback(() => {
    duckEpochRef.current += 1; // invalidates any in-flight restore callback
    for (const t of duckTimersRef.current) clearTimeout(t);
    duckTimersRef.current = [];
  }, []);

  // ---------- channel reservation (mount) ----------
  useEffect(() => {
    const handle = bus.reserve('drone');
    if (handle === null) {
      // U23 — silent fallback; bus has already logged the denial. The hook
      // operates as a no-op until next remount.
      log.w('useDrone', 'channel-claim-denied');
      return;
    }
    channelRef.current = handle;
    return () => {
      try {
        handle.release();
      } catch {
        /* ignore */
      }
      channelRef.current = null;
    };
    // bus identity is stable for the lifetime of the app per useMidiBus
    // contract; deps intentionally exclude it to avoid spurious re-claims.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- internal dispatch helpers ----------

  // Compute current effective velocity (0..127) for noteOn, accounting for
  // the user's volume slider. Bus applies master-mute on top.
  const effectiveVelocity = useCallback((scale: number = 1): number => {
    const v01 = Math.max(0, Math.min(1, volumeRef.current));
    return clampVel127(DRONE_BASE_VELOCITY * v01 * scale);
  }, []);

  // Re-anchor: noteOff the previously sustained MIDI (if any), noteOn the
  // new one, reset the chase delta. Caller is responsible for any subsequent
  // pitch-bend (e.g. the A4 baseline). Updates currentMidi state + publishes
  // to the engine.
  const anchorOn = useCallback(
    (midi: number) => {
      const ch = channelRef.current;
      if (!ch) return;
      const prev = sustainedMidiRef.current;
      if (prev !== null && prev !== midi) {
        ch.noteOff(prev);
      }
      if (prev !== midi) {
        ch.noteOn(midi, effectiveVelocity());
        sustainedMidiRef.current = midi;
      }
      setCurrentMidi(midi);
      try {
        setDroneCurrentMidiRef.current?.(midi);
      } catch {
        /* ignore */
      }
    },
    [effectiveVelocity],
  );

  // Slide to a new effective target MIDI. Uses pitch-bend if the (delta + A4
  // baseline) fits inside ±12; otherwise re-anchors (noteOff + noteOn).
  const slideTo = useCallback(
    (targetMidi: number) => {
      const ch = channelRef.current;
      if (!ch) return;
      const anchor = sustainedMidiRef.current;
      const a4Bend = a4BendSemitones(a4Ref.current);

      if (anchor === null) {
        // Cold start — pick the target as the new anchor, apply A4 bend.
        anchorOn(targetMidi);
        ch.pitchBend(a4Bend);
        return;
      }

      const chaseDelta = targetMidi - anchor;
      const totalBend = chaseDelta + a4Bend;
      if (totalBend > 12 || totalBend < -12) {
        // Outside ±12 — re-anchor to the new target and apply just the A4 bend.
        anchorOn(targetMidi);
        ch.pitchBend(a4Bend);
        return;
      }

      // Smooth slide. The anchor MIDI stays put; we just bend the channel.
      ch.pitchBend(totalBend);
      // currentMidi reflects what the LISTENER hears — i.e. the bent target.
      setCurrentMidi(targetMidi);
      try {
        setDroneCurrentMidiRef.current?.(targetMidi);
      } catch {
        /* ignore */
      }
    },
    [anchorOn],
  );

  // ---------- duck-on-suspicion envelope ----------
  // Re-issue noteOn at DUCK_DEPTH * normal velocity for `holdMs`, then restore.
  // The bus has no per-channel volume scalar (master-gain is global and would
  // clobber the metronome), so velocity-reissue is the cleanest approximation.
  const requestDuck = useCallback(
    (holdMs: number) => {
      if (!enabledRef.current) return;
      const ch = channelRef.current;
      if (!ch) return;
      const sus = sustainedMidiRef.current;
      if (sus === null) return;
      cancelDuckTimers();
      // v1.3.4 — capture our duck epoch AFTER cancelDuckTimers bumps it; any
      // restore callback below is valid only while duckEpochRef matches this
      // value. A subsequent cancelDuckTimers (e.g. voice-change effect at
      // useDrone.ts:371) bumps the epoch and the in-flight callback bails.
      const myEpoch = duckEpochRef.current;
      // Drop in. The re-noteOn retriggers TSF but the previous voice releases
      // naturally, giving a soft duck rather than a click.
      ch.noteOn(sus, effectiveVelocity(DUCK_DEPTH));
      const restoreAt = DUCK_RAMP_IN_MS + Math.max(0, holdMs);
      duckTimersRef.current.push(
        setTimeout(() => {
          // v1.3.4 — epoch guard. clearTimeout in cancelDuckTimers can't
          // recall a callback already dequeued by the event loop; without
          // this check, a duck restore that fires AFTER a voice-change's
          // new noteOn would overwrite velocity at full level (DUCK_DEPTH→1
          // jump on a freshly-attacked voice).
          if (duckEpochRef.current !== myEpoch) return;
          const curCh = channelRef.current;
          const curSus = sustainedMidiRef.current;
          if (!curCh || curSus === null) return;
          if (!enabledRef.current) return;
          curCh.noteOn(curSus, effectiveVelocity(1));
        }, restoreAt),
      );
      duckTimersRef.current.push(
        setTimeout(() => {
          // Same epoch guard — leaves duckTimersRef alone if a newer duck
          // already replaced it.
          if (duckEpochRef.current !== myEpoch) return;
          duckTimersRef.current = [];
        }, restoreAt + DUCK_RAMP_IN_MS),
      );
    },
    [cancelDuckTimers, effectiveVelocity],
  );

  // Install / uninstall duck handler.
  useEffect(() => {
    installDroneDuckHandlerRef.current?.(requestDuck);
    return () => {
      try {
        installDroneDuckHandlerRef.current?.(null);
      } catch {
        /* ignore */
      }
      cancelDuckTimers();
    };
  }, [requestDuck, cancelDuckTimers]);

  // ---------- enable / toggle ----------
  const setEnabled = useCallback(
    (v: boolean) => {
      setEnabledState(v);
      if (!v) {
        cancelDuckTimers();
        enabledRef.current = false;
        const ch = channelRef.current;
        const sus = sustainedMidiRef.current;
        if (ch) {
          if (sus !== null) ch.noteOff(sus);
          ch.allNotesOff();
        }
        sustainedMidiRef.current = null;
        lastProgramRef.current = null;
        setCurrentMidi(null);
        try {
          setDroneCurrentMidiRef.current?.(null);
        } catch {
          /* ignore */
        }
      }
      // The follow-up effect (incumbent/semitones/voice/a4) will spin the
      // note up if v=true and a held pitch exists.
    },
    [cancelDuckTimers],
  );

  const toggle = useCallback(() => {
    setEnabled(!enabledRef.current);
  }, [setEnabled]);

  // Track incumbentMidi → heldMidi.
  useEffect(() => {
    if (incumbentMidi !== null) heldMidiRef.current = incumbentMidi;
  }, [incumbentMidi]);

  // Apply pitch (chase). Runs on every incumbentMidi/semitones/a4/enabled
  // change. The bus drops dispatch silently when synth isn't ready yet, so
  // we don't need to gate on a ready latch here — once the bus flips ready,
  // any subsequent effect run (e.g. from a refHz tweak) will land audibly.
  useEffect(() => {
    if (!enabled) return;
    const ch = channelRef.current;
    if (!ch) return;
    const heldRaw = heldMidiRef.current;
    if (heldRaw === null) return;
    // First spin-up: push the program so the right patch is loaded before
    // the noteOn lands.
    const vRec = resolveDroneVoice(voiceIdRef.current);
    if (lastProgramRef.current !== vRec.program) {
      ch.setProgram(vRec.program);
      lastProgramRef.current = vRec.program;
    }
    const target = Math.max(0, Math.min(127, heldRaw + semitones));
    slideTo(target);
  }, [enabled, incumbentMidi, semitones, a4Hz, slideTo]);

  // Voice change. noteOff → programChange → noteOn for a clean re-attack.
  // (See file header for rationale on morph-vs-reattack — TSF's mid-note
  // programChange leaves the prior sample playing through its release tail,
  // so the user wouldn't hear the new timbre until the next note-on.)
  useEffect(() => {
    if (!enabled) return;
    const ch = channelRef.current;
    if (!ch) return;
    // Cancel any in-flight duck restore before the re-attack, otherwise
    // the duck's restore timer fires AFTER the noteOn and overwrites velocity.
    cancelDuckTimers();
    const vRec = resolveDroneVoice(voice);
    if (lastProgramRef.current === vRec.program) {
      // Same patch as last apply — nothing to do (this effect re-runs when
      // `enabled` flips true and the pitch effect above already issued the
      // initial programChange + noteOn).
      return;
    }
    const sus = sustainedMidiRef.current;
    if (sus !== null) ch.noteOff(sus);
    ch.setProgram(vRec.program);
    lastProgramRef.current = vRec.program;
    if (sus !== null) {
      ch.noteOn(sus, effectiveVelocity(1));
      // sustainedMidiRef.current stays the same; re-apply A4 bend + chase.
      const heldRaw = heldMidiRef.current;
      if (heldRaw !== null) {
        const target = Math.max(0, Math.min(127, heldRaw + semitoneRef.current));
        const totalBend = target - sus + a4BendSemitones(a4Ref.current);
        ch.pitchBend(totalBend);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, enabled]);

  // Live volume → re-issue noteOn at new velocity so the slider feels
  // responsive. Skip when idle (no anchor to re-issue against).
  //
  // v1.3.4 — trailing-throttle: at most ~20Hz (50ms gate) during rapid drags
  // so the C++ command queue isn't flooded at 60Hz slider rate. A trailing-
  // edge one-shot timer catches the final slider position when a call was
  // dropped, guaranteeing the drone lands on the user's intended volume even
  // if every intermediate position was throttled out.
  useEffect(() => {
    if (!enabled) return;
    const ch = channelRef.current;
    if (!ch) return;
    const sus = sustainedMidiRef.current;
    if (sus === null) return;

    // Clear any pending trailing-edge shot — this new value supersedes it.
    if (volTrailingTimerRef.current !== null) {
      clearTimeout(volTrailingTimerRef.current);
      volTrailingTimerRef.current = null;
    }

    const now = Date.now();
    const sinceLastMs = now - lastVolApplyAtRef.current;
    const THROTTLE_MS = 50;

    if (sinceLastMs >= THROTTLE_MS) {
      // Enough time has passed — fire immediately.
      lastVolApplyAtRef.current = now;
      ch.noteOn(sus, effectiveVelocity(1));
    } else {
      // Too soon — schedule a trailing-edge shot that lands after the
      // remaining throttle window expires. If another change arrives before
      // it fires, the timer above will cancel it and this logic re-runs.
      const remaining = THROTTLE_MS - sinceLastMs;
      volTrailingTimerRef.current = setTimeout(() => {
        volTrailingTimerRef.current = null;
        if (!enabledRef.current) return;
        const liveCh = channelRef.current;
        const liveSus = sustainedMidiRef.current;
        if (!liveCh || liveSus === null) return;
        lastVolApplyAtRef.current = Date.now();
        liveCh.noteOn(liveSus, effectiveVelocity(1));
      }, remaining);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, enabled, effectiveVelocity]);

  // ---------- final teardown ----------
  useEffect(() => {
    return () => {
      cancelDuckTimers();
      // v1.3.4 — cancel any pending trailing-edge volume timer so it doesn't
      // fire a noteOn after unmount against a released channel.
      if (volTrailingTimerRef.current !== null) {
        clearTimeout(volTrailingTimerRef.current);
        volTrailingTimerRef.current = null;
      }
      // Channel release (in the reserve-effect cleanup) calls allNotesOff
      // and frees the channel atomically — no per-op teardown needed here.
      sustainedMidiRef.current = null;
      lastProgramRef.current = null;
      try {
        setDroneCurrentMidiRef.current?.(null);
      } catch {
        /* ignore */
      }
    };
  }, [cancelDuckTimers]);

  // Stable identity so caller useEffect dep arrays don't fire at audio rate.
  return useMemo(
    () => ({
      enabled,
      setEnabled,
      toggle,
      currentMidi,
      currentHz: currentMidi !== null ? midiToFrequency(currentMidi, a4Hz) : null,
    }),
    [enabled, setEnabled, toggle, currentMidi, a4Hz],
  );
}

// Re-export voice catalog for convenience — App.tsx and SetupScreen pull
// these without a second import path.
export { resolveDroneVoice, DRONE_DEFAULT_VOICE };
export type { DroneVoice };
