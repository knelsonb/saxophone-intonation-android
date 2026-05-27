/**
 * useDrone — sustained reference-tone player that tracks the user's detected
 * pitch ± a semitone offset. TUNER screen only.
 *
 * v1.1 — TSF rewire. The looped-WAV crossfade is gone. We drive a single
 * MIDI channel on @local/raw-audio-output (TinySoundFont + GeneralUser-GS).
 * The drone holds ONE note indefinitely and uses MIDI pitch-bend to slide
 * to the next target (no audible click at the transition). When the user
 * changes patch (voice), we noteOff → programChange → noteOn for a clean
 * re-attack (see voice-change discussion below).
 *
 * Pitch source: `incumbentMidi` from useAudioEngine — the same locked rounded
 * MIDI the visible note readout uses. When `incumbentMidi` goes null the
 * drone keeps holding its last pitch (heldMidi); it only stops when the user
 * toggles OFF.
 *
 * A4 reference: TSF voices are intrinsically tuned to A4=440. We apply a
 * baseline pitch-bend of `1200 * log2(a4Hz / 440)` cents so the drone tracks
 * the user's A4 preference. Combined with the chase delta — total semitone
 * offset = (targetMidi - sustainedMidi) + (a4Cents / 100). Clamped to ±12.
 * Outside ±12 we re-anchor: noteOff old → noteOn new → reset bend.
 *
 * Lifecycle: AppState 'background' drops masterGain to 0; foreground restores.
 * Mute (deck recording) does the same. On unmount we allNotesOff + stop.
 *
 * Voice-change behavior: noteOff → programChange → noteOn. Rationale:
 * TSF's mid-note program-change leaves the previous SoundFont sample
 * playing to release (which is correct MIDI semantics, but means the new
 * patch only becomes audible on the NEXT note-on). For a drone that's
 * holding a note indefinitely, the user expects the timbre to change
 * immediately when they pick a new voice. The brief re-attack is the
 * tradeoff and reads as "switched instruments," not "click."
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import synth from '@local/raw-audio-output';
import { midiToFrequency } from './audioGen';
import { resolveDroneVoice, DRONE_DEFAULT_VOICE } from './droneVoices';
import type { DroneVoice } from './droneVoices';

// MIDI velocity for the held drone note. Full-velocity; gain shaping happens
// at synth.setMasterGain.
const DRONE_VELOCITY = 1.0;

// Single channel — channel 0 is the drone's exclusive owner. The metronome
// and any other future synth consumers must use a different channel.
const DRONE_CH = 0;

// Compute the A4 reference pitch-bend in semitones. Baseline bend that maps
// MIDI A4 (440 Hz in TSF) onto the user's a4Hz preference.
function a4BendSemitones(a4Hz: number): number {
  if (!Number.isFinite(a4Hz) || a4Hz <= 0) return 0;
  return 1200 * Math.log2(a4Hz / 440) / 100; // cents → semitones
}

// Clamp to the synth's ±12 pitch-bend range.
function clampBend(semis: number): number {
  if (semis > 12) return 12;
  if (semis < -12) return -12;
  return semis;
}

export interface DroneState {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
  /** Effective MIDI the drone is currently sounding (after offset). Null while idle. */
  currentMidi: number | null;
  /** Effective Hz the drone is currently sounding. Null while idle. */
  currentHz: number | null;
  /**
   * Recording-mute coordination. When muted=true, master gain drops to 0
   * but the held note keeps sustaining so unmute is instant. Preserves
   * `enabled` across mute/unmute.
   */
  setMuted: (muted: boolean) => void;
}

export interface UseDroneArgs {
  incumbentMidi: number | null;
  a4Hz: number;
  /** v1.1 — DroneVoice.id string (resolved internally via resolveDroneVoice). */
  voice: string;
  /** Volume 0..1. Live — applies via setMasterGain. */
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
  incumbentMidi, a4Hz, voice, volume, semitones,
  setDroneCurrentMidi, installDroneDuckHandler,
}: UseDroneArgs): DroneState {
  const [enabled, setEnabledState] = useState(false);
  const [currentMidi, setCurrentMidi] = useState<number | null>(null);

  // Live-prop refs (so callbacks can read the freshest value without re-binding).
  const targetVolumeRef = useRef(volume);
  targetVolumeRef.current = volume;
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

  // Mute (deck-recording coordination). Synced through setMasterGain.
  const mutedRef = useRef(false);

  // Synth ready latch. We attempt prepareAsync on mount; until it resolves,
  // any noteOn / programChange we issue is silent (per Gandalf's contract,
  // safe — produces no audio rather than crashing). When the listener fires,
  // we re-apply the desired state if `enabled` is already true.
  const readyRef = useRef(false);

  // Stable refs for engine wiring callbacks.
  const setDroneCurrentMidiRef = useRef(setDroneCurrentMidi);
  setDroneCurrentMidiRef.current = setDroneCurrentMidi;
  const installDroneDuckHandlerRef = useRef(installDroneDuckHandler);
  installDroneDuckHandlerRef.current = installDroneDuckHandler;

  // Duck timers (chase-guard suspicion). Per v1.0 the duck temporarily lowers
  // the audible drone so a misheard mic-bleed doesn't drag incumbent voting.
  // v1.1 — implemented as masterGain ramps. Three setTimeouts: drop → restore.
  const duckTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cancelDuckTimers = useCallback(() => {
    for (const t of duckTimersRef.current) clearTimeout(t);
    duckTimersRef.current = [];
  }, []);

  // ---------- gain application helper ----------
  // Resolves the effective masterGain based on muted/background state, then
  // writes via synth.setMasterGain. Callers do NOT call setMasterGain
  // directly — they update refs and call this.
  const backgroundRef = useRef(false);
  const applyGain = useCallback(() => {
    if (!enabledRef.current || mutedRef.current || backgroundRef.current) {
      try { synth.setMasterGain(0); } catch { /* ignore */ }
      return;
    }
    try { synth.setMasterGain(targetVolumeRef.current); } catch { /* ignore */ }
  }, []);

  // Re-anchor: noteOff the previously sustained MIDI (if any), noteOn the
  // new one, reset the chase delta. Caller is responsible for any subsequent
  // pitch-bend (e.g. the A4 baseline). Updates currentMidi state + publishes
  // to the engine.
  const anchorOn = useCallback((midi: number) => {
    const prev = sustainedMidiRef.current;
    if (prev !== null && prev !== midi) {
      try { synth.noteOff(DRONE_CH, prev); } catch { /* ignore */ }
    }
    if (prev !== midi) {
      try { synth.noteOn(DRONE_CH, midi, DRONE_VELOCITY); } catch { /* ignore */ }
      sustainedMidiRef.current = midi;
    }
    setCurrentMidi(midi);
    try { setDroneCurrentMidiRef.current?.(midi); } catch { /* ignore */ }
  }, []);

  // Slide to a new effective target MIDI. Uses pitch-bend if the (delta + A4
  // baseline) fits inside ±12; otherwise re-anchors (noteOff + noteOn).
  const slideTo = useCallback((targetMidi: number) => {
    const anchor = sustainedMidiRef.current;
    const a4Cents = a4Ref.current;
    const a4Bend = a4BendSemitones(a4Cents);

    if (anchor === null) {
      // Cold start — pick the target as the new anchor, apply A4 bend.
      anchorOn(targetMidi);
      try { synth.pitchBend(DRONE_CH, clampBend(a4Bend)); } catch { /* ignore */ }
      return;
    }

    const chaseDelta = targetMidi - anchor;
    const totalBend = chaseDelta + a4Bend;
    if (totalBend > 12 || totalBend < -12) {
      // Outside ±12 — re-anchor to the new target and apply just the A4 bend.
      anchorOn(targetMidi);
      try { synth.pitchBend(DRONE_CH, clampBend(a4Bend)); } catch { /* ignore */ }
      return;
    }

    // Smooth slide. The anchor MIDI stays put; we just bend the channel.
    try { synth.pitchBend(DRONE_CH, clampBend(totalBend)); } catch { /* ignore */ }
    // currentMidi reflects what the LISTENER hears — i.e. the bent target.
    setCurrentMidi(targetMidi);
    try { setDroneCurrentMidiRef.current?.(targetMidi); } catch { /* ignore */ }
  }, [anchorOn]);

  // ---------- prepare + ready listener ----------
  useEffect(() => {
    let cancelled = false;
    // Idempotent — multiple hooks calling this are safe per Gandalf's design.
    synth.prepareAsync().then((ok) => {
      if (cancelled) return;
      if (ok) {
        readyRef.current = true;
        try { synth.start(); } catch { /* ignore */ }
        // Apply current desired state. If enabled and we have a held pitch,
        // bring up the note now.
        if (enabledRef.current && heldMidiRef.current !== null) {
          const target = Math.max(0, Math.min(127, heldMidiRef.current + semitoneRef.current));
          // Initial patch.
          const vId = voiceIdRef.current;
          const vRec = resolveDroneVoice(vId);
          try { synth.programChange(DRONE_CH, vRec.program); } catch { /* ignore */ }
          anchorOn(target);
          const a4Bend = a4BendSemitones(a4Ref.current);
          try { synth.pitchBend(DRONE_CH, clampBend(a4Bend)); } catch { /* ignore */ }
        }
        applyGain();
      }
    }).catch(() => { /* synth stays silent */ });

    const sub = synth.addReadyListener((e) => {
      if (!e.ok) return;
      readyRef.current = true;
    });

    return () => {
      cancelled = true;
      try { sub.remove(); } catch { /* ignore */ }
    };
    // anchorOn/applyGain are stable useCallback; safe to omit (initial setup only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- duck-on-suspicion envelope ----------
  // Drop masterGain to DUCK_DEPTH * target for `holdMs`, then restore.
  const requestDuck = useCallback((holdMs: number) => {
    if (!enabledRef.current) return;
    if (mutedRef.current) return; // already silent
    if (backgroundRef.current) return;
    const DUCK_DEPTH = 0.3;
    const FADE_IN_MS = 15;
    const FADE_OUT_MS = 25;
    cancelDuckTimers();
    const target = targetVolumeRef.current;
    try { synth.setMasterGain(target * DUCK_DEPTH); } catch { /* ignore */ }
    const restoreAt = FADE_IN_MS + Math.max(0, holdMs);
    duckTimersRef.current.push(setTimeout(() => {
      // Re-affirm the duck halfway through in case something else nudged gain.
      if (mutedRef.current || backgroundRef.current) {
        try { synth.setMasterGain(0); } catch { /* ignore */ }
        return;
      }
      try { synth.setMasterGain(target * DUCK_DEPTH); } catch { /* ignore */ }
    }, FADE_IN_MS));
    duckTimersRef.current.push(setTimeout(() => {
      // Restore — applyGain re-derives the right value from the current
      // muted/background state.
      applyGain();
    }, restoreAt));
    duckTimersRef.current.push(setTimeout(() => {
      duckTimersRef.current = [];
    }, restoreAt + FADE_OUT_MS));
  }, [cancelDuckTimers, applyGain]);

  // Install / uninstall duck handler.
  useEffect(() => {
    installDroneDuckHandlerRef.current?.(requestDuck);
    return () => {
      try { installDroneDuckHandlerRef.current?.(null); } catch { /* ignore */ }
      cancelDuckTimers();
    };
  }, [requestDuck, cancelDuckTimers]);

  // ---------- enable / toggle ----------
  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    if (!v) {
      cancelDuckTimers();
      // v1.1 — route through applyGain so the "all gain writes via applyGain"
      // invariant (line 152-154) holds. enabledRef sync first so applyGain
      // resolves to 0 on this path.
      enabledRef.current = false;
      applyGain();
      const sus = sustainedMidiRef.current;
      if (sus !== null) {
        try { synth.noteOff(DRONE_CH, sus); } catch { /* ignore */ }
      }
      try { synth.allNotesOff(DRONE_CH); } catch { /* ignore */ }
      sustainedMidiRef.current = null;
      setCurrentMidi(null);
      try { setDroneCurrentMidiRef.current?.(null); } catch { /* ignore */ }
    }
    // The follow-up effect (incumbent/semitones/voice/a4) will spin the
    // note up if v=true and a held pitch exists.
  }, [cancelDuckTimers]);

  const toggle = useCallback(() => {
    setEnabled(!enabledRef.current);
  }, [setEnabled]);

  // Track incumbentMidi → heldMidi.
  useEffect(() => {
    if (incumbentMidi !== null) heldMidiRef.current = incumbentMidi;
  }, [incumbentMidi]);

  // Apply pitch (chase). Runs on every incumbentMidi/semitones/a4 change.
  useEffect(() => {
    if (!enabled) return;
    if (!readyRef.current) return; // mount effect will spin up when ready
    const heldRaw = heldMidiRef.current;
    if (heldRaw === null) return;
    const target = Math.max(0, Math.min(127, heldRaw + semitones));
    slideTo(target);
    // Gain may need to come back if we were stopped.
    applyGain();
  }, [enabled, incumbentMidi, semitones, a4Hz, slideTo, applyGain]);

  // Voice change. noteOff → programChange → noteOn for a clean re-attack.
  // (See file header for rationale on morph-vs-reattack — TSF's mid-note
  // programChange leaves the prior sample playing through its release tail,
  // so the user wouldn't hear the new timbre until the next note-on.)
  useEffect(() => {
    if (!enabled) return;
    if (!readyRef.current) return;
    // v1.1 — cancel any in-flight duck restore before the re-attack, otherwise
    // the duck's restore timer fires AFTER the noteOn and overwrites applyGain.
    cancelDuckTimers();
    const vRec = resolveDroneVoice(voice);
    const sus = sustainedMidiRef.current;
    if (sus !== null) {
      try { synth.noteOff(DRONE_CH, sus); } catch { /* ignore */ }
    }
    try { synth.programChange(DRONE_CH, vRec.program); } catch { /* ignore */ }
    if (sus !== null) {
      try { synth.noteOn(DRONE_CH, sus, DRONE_VELOCITY); } catch { /* ignore */ }
      // sustainedMidiRef.current stays the same; re-apply A4 bend + chase.
      const heldRaw = heldMidiRef.current;
      if (heldRaw !== null) {
        const target = Math.max(0, Math.min(127, heldRaw + semitoneRef.current));
        const totalBend = (target - sus) + a4BendSemitones(a4Ref.current);
        try { synth.pitchBend(DRONE_CH, clampBend(totalBend)); } catch { /* ignore */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, enabled]);

  // Live volume → setMasterGain (via applyGain so mute/background still wins).
  useEffect(() => {
    applyGain();
  }, [volume, enabled, applyGain]);

  // ---------- AppState background/foreground ----------
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        backgroundRef.current = true;
        try { synth.setMasterGain(0); } catch { /* ignore */ }
      } else if (next === 'active') {
        backgroundRef.current = false;
        applyGain();
      }
    });
    return () => sub.remove();
  }, [applyGain]);

  // ---------- final teardown ----------
  useEffect(() => {
    return () => {
      cancelDuckTimers();
      try { synth.setMasterGain(0); } catch { /* ignore */ }
      try { synth.allNotesOff(DRONE_CH); } catch { /* ignore */ }
      // We intentionally do NOT stop() the synth here — other consumers
      // (future metronome / pitch-pipe wiring) may share the same engine.
      // Per Gandalf's contract, allNotesOff + setMasterGain(0) is the
      // hook-local "stop" for the drone channel.
      sustainedMidiRef.current = null;
      try { setDroneCurrentMidiRef.current?.(null); } catch { /* ignore */ }
    };
  }, [cancelDuckTimers]);

  // Mute (deck recording).
  const setMuted = useCallback((muted: boolean) => {
    if (mutedRef.current === muted) return;
    mutedRef.current = muted;
    applyGain();
  }, [applyGain]);

  // Stable identity so caller useEffect dep arrays don't fire at audio rate.
  return useMemo(() => ({
    enabled,
    setEnabled,
    toggle,
    currentMidi,
    currentHz: currentMidi !== null ? midiToFrequency(currentMidi, a4Hz) : null,
    setMuted,
  }), [enabled, setEnabled, toggle, currentMidi, a4Hz, setMuted]);
}

// Re-export voice catalog for convenience — App.tsx and SetupScreen pull
// these without a second import path.
export { resolveDroneVoice, DRONE_DEFAULT_VOICE };
export type { DroneVoice };
