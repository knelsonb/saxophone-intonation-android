/**
 * useDrone — sustained reference-tone player that tracks the user's detected
 * pitch ± a semitone offset. TUNER screen only.
 *
 * Pitch source: `incumbentMidi` from useAudioEngine — the same locked rounded
 * MIDI the visible note readout uses. When the user changes notes, the drone
 * crossfades smoothly to the new pitch. The crossfade is implemented with
 * two AudioPlayer instances ("A" and "B"): one fades down while the other
 * fades up over 50 ms. After the crossfade, the silent player is rebuilt for
 * the next switch.
 *
 * Pitch generation: `buildDroneWavBase64(freqHz, voice, volume)` returns one
 * 2-second loop. The result is written to `${cacheDir}/drone_*.wav` (Android
 * ExoPlayer rejects data: URIs) and handed to `expo-audio.createAudioPlayer`
 * with `loop = true`.
 *
 * Hold logic: when `incumbentMidi` goes null (the user stopped playing), the
 * drone keeps holding its last pitch. The drone only stops when the user
 * toggles it OFF.
 *
 * Lifecycle: AppState 'background' silences both players (sets volume=0) but
 * remembers the toggle state; the next foreground re-applies the volume.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { createAudioPlayer } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import { buildDroneWavBase64, midiToFrequency } from './audioGen';
import type { DroneVoice } from './audioGen';

const CROSSFADE_MS = 50;

// Duck envelope — used when the engine suspects mic leakage chase. We drop
// the active player to `DUCK_DEPTH` of its target volume over a short fade,
// hold for `holdMs`, then fade back. Tunable in case the perceptual chop
// turns out wrong-feeling on devices with different speaker EQ.
const DUCK_DEPTH = 0.3;
const DUCK_FADE_IN_MS = 15;
const DUCK_FADE_OUT_MS = 25;

export interface DroneState {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
  /** Effective MIDI the drone is currently sounding (after offset). Null while pitchless and idle. */
  currentMidi: number | null;
  /** Effective Hz the drone is currently sounding. Null while idle. */
  currentHz: number | null;
  /**
   * v1.0 BUG-4 — recording-mute coordination. When muted=true, both player
   * slots are silenced (volume=0) but kept playing so unmute is instant.
   * The previous target volume is restored on unmute. Does not affect
   * `enabled` — the user's toggle is preserved across mute/unmute.
   */
  setMuted: (muted: boolean) => void;
}

export interface UseDroneArgs {
  incumbentMidi: number | null;
  a4Hz: number;
  voice: DroneVoice;
  /** Volume 0..1. Live — changes apply on the next pitch switch. */
  volume: number;
  /** Signed semitone offset added to incumbentMidi before synth. */
  semitones: number;
  /**
   * Drone-chase guard wiring (v0.9.1). Engine reads the drone's currently
   * sounding MIDI to vote-exclude it from incumbent voting; engine calls
   * back into the drone's duck handler when it suspects mic leakage chase.
   * Both are required when chase guard is active; pass no-ops to disable.
   */
  setDroneCurrentMidi: (midi: number | null) => void;
  installDroneDuckHandler: (fn: ((ms: number) => void) | null) => void;
}

interface DronePlayerSlot {
  player: AudioPlayer | null;
  // Cache key — `${voice}_${midi}_${volumeRounded}` — so we don't regen
  // identical WAVs when the user toggles back and forth.
  key: string | null;
}

function freqOf(midi: number, a4Hz: number): number {
  return midiToFrequency(midi, a4Hz);
}

function wavFileFor(voice: DroneVoice, freqHz: number, volume: number): File {
  // Bucket the volume to 0.05 so we don't blow out the cache. Frequency
  // bucket: just round to the nearest 0.01 Hz — chromatic notes are well
  // separated and freq from MIDI is deterministic, so this is effectively
  // unique-per-(midi, a4Hz).
  const v100 = Math.round(volume * 20); // 0..20
  const fInt = Math.round(freqHz * 100);
  return new File(Paths.cache, `drone_${voice}_${fInt}_v${v100}.wav`);
}

function ensureWavFile(voice: DroneVoice, midi: number, a4Hz: number, volume: number): string | null {
  try {
    const f = freqOf(midi, a4Hz);
    const file = wavFileFor(voice, f, volume);
    if (!file.exists) {
      const b64 = buildDroneWavBase64(f, voice, volume);
      file.create();
      file.write(b64, { encoding: 'base64' });
    }
    return file.uri;
  } catch {
    return null;
  }
}

function disposeSlot(slot: DronePlayerSlot) {
  const p = slot.player;
  if (p) {
    try { p.pause(); } catch { /* ignore */ }
    try { p.remove(); } catch { /* ignore */ }
  }
  slot.player = null;
  slot.key = null;
}

export function useDrone({
  incumbentMidi, a4Hz, voice, volume, semitones,
  setDroneCurrentMidi, installDroneDuckHandler,
}: UseDroneArgs): DroneState {
  const [enabled, setEnabledState] = useState(false);
  const [currentMidi, setCurrentMidi] = useState<number | null>(null);

  // Two-slot crossfade. activeSlot holds the audible player; otherSlot is
  // the one we're fading to next. We swap on every pitch change.
  const slotARef = useRef<DronePlayerSlot>({ player: null, key: null });
  const slotBRef = useRef<DronePlayerSlot>({ player: null, key: null });
  const activeIsARef = useRef(true);
  const crossfadeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const targetVolumeRef = useRef(volume);
  targetVolumeRef.current = volume;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const a4Ref = useRef(a4Hz);
  a4Ref.current = a4Hz;
  const semitoneRef = useRef(semitones);
  semitoneRef.current = semitones;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Held MIDI — drone pitch sticks to this even when incumbentMidi goes null,
  // so a brief silence between notes doesn't kill the drone.
  const heldMidiRef = useRef<number | null>(null);

  // v1.0.1 — moved up from below AppState so transitionTo + volume-prop effect
  // can gate on it without temporal-dead-zone hand-wringing. mutedRef=true
  // means "deck is recording; force every player.volume write to 0".
  const mutedRef = useRef(false);

  // Stable refs for the engine wiring callbacks — keeps `transitionTo`
  // dependency list short and avoids unnecessary callback recreation when
  // the parent re-renders (engine's useCallback identity is stable, but the
  // ref hop is cheap insurance).
  const setDroneCurrentMidiRef = useRef(setDroneCurrentMidi);
  setDroneCurrentMidiRef.current = setDroneCurrentMidi;
  const installDroneDuckHandlerRef = useRef(installDroneDuckHandler);
  installDroneDuckHandlerRef.current = installDroneDuckHandler;

  // Stop any in-flight crossfade timer.
  const cancelCrossfade = useCallback(() => {
    if (crossfadeTimerRef.current !== null) {
      clearInterval(crossfadeTimerRef.current);
      crossfadeTimerRef.current = null;
    }
  }, []);

  // ---------- duck-on-suspicion envelope ----------
  //
  // Brief 3-stage volume ramp on the audible slot: fade down → hold at
  // DUCK_DEPTH → fade back to target. Three setTimeouts get the job done
  // without re-entering setInterval (a fresh duck overrides a stale one
  // by clearing the previous timers first).
  const duckTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cancelDuckTimers = useCallback(() => {
    for (const t of duckTimersRef.current) clearTimeout(t);
    duckTimersRef.current = [];
  }, []);
  const requestDuck = useCallback((holdMs: number) => {
    // Identify the audible slot at the moment of the request — same slot
    // we'll ramp back up after the hold. If the active slot flips during
    // the hold (e.g. an in-flight crossfade completes), we still operate
    // on the original audible slot since that's the one currently emitting
    // sound. The crossfade's own fade-down on this slot will reach 0
    // independently — we just keep the duck-down setting in the meantime.
    if (!enabledRef.current) return;
    // v1.0.1 — muted (recording) implies no audible drone; a duck event would
    // raise volume above 0. Bail; chase-guard is irrelevant while we're silent.
    if (mutedRef.current) return;
    const target = targetVolumeRef.current;
    const slot = activeIsARef.current ? slotARef.current : slotBRef.current;
    const p = slot.player;
    if (!p) return;
    cancelDuckTimers();
    try { p.volume = target * DUCK_DEPTH; } catch { /* ignore */ }
    const restoreAt = DUCK_FADE_IN_MS + Math.max(0, holdMs);
    const finalAt = restoreAt + DUCK_FADE_OUT_MS;
    // Hold timer — we re-affirm DUCK_DEPTH halfway through in case a
    // crossfade tick raced past us. Cheap insurance.
    // v1.0.1 — re-check muted at firing time: setMuted(true) mid-duck must
    // not be undone by a stale timer.
    duckTimersRef.current.push(setTimeout(() => {
      if (mutedRef.current) { try { p.volume = 0; } catch { /* ignore */ } return; }
      try { p.volume = target * DUCK_DEPTH; } catch { /* ignore */ }
    }, DUCK_FADE_IN_MS));
    // Restore timer — push the slot back to full target volume.
    duckTimersRef.current.push(setTimeout(() => {
      if (mutedRef.current) { try { p.volume = 0; } catch { /* ignore */ } return; }
      try { p.volume = target; } catch { /* ignore */ }
    }, restoreAt));
    // Final cleanup — clears the timers array so the ref doesn't grow.
    duckTimersRef.current.push(setTimeout(() => {
      duckTimersRef.current = [];
    }, finalAt));
  }, [cancelDuckTimers]);

  // Install / uninstall the duck handler with the engine on mount / unmount.
  useEffect(() => {
    installDroneDuckHandlerRef.current?.(requestDuck);
    return () => {
      try { installDroneDuckHandlerRef.current?.(null); } catch { /* ignore */ }
      cancelDuckTimers();
    };
  }, [requestDuck, cancelDuckTimers]);

  // Stop everything. Caller is responsible for clearing held state if needed.
  const stopAll = useCallback(() => {
    cancelCrossfade();
    disposeSlot(slotARef.current);
    disposeSlot(slotBRef.current);
    activeIsARef.current = true;
  }, [cancelCrossfade]);

  // Begin a crossfade from the current active slot to a freshly-built next
  // slot. If no active slot yet, just start the new player at target volume
  // (cold start, no fade — first audible note shouldn't have a 50 ms ramp-in
  // since we'd be ramping from -inf to volume anyway).
  //
  // v1.0.1 — INVARIANT: while `mutedRef.current` is true (deck recording),
  // every `player.volume` write here resolves to 0. The state-machine
  // bookkeeping (key swap, slot flip, currentMidi publish, crossfade timer)
  // still advances so unmute lands in a consistent state.
  const transitionTo = useCallback((midi: number) => {
    const v = voiceRef.current;
    const vol = targetVolumeRef.current;
    const uri = ensureWavFile(v, midi, a4Ref.current, vol);
    if (!uri) return;

    const cur = activeIsARef.current ? slotARef.current : slotBRef.current;
    const nxt = activeIsARef.current ? slotBRef.current : slotARef.current;
    const cacheKey = `${v}_${midi}_${Math.round(vol * 20)}`;

    // No-op if active is already on this key.
    if (cur.player && cur.key === cacheKey) return;

    // v1.0.1 — mute-aware volume scaler. 1.0 normally, 0 while recording.
    const muteGain = mutedRef.current ? 0 : 1;

    // Build the next player (or reuse if already on the same key).
    if (!nxt.player || nxt.key !== cacheKey) {
      disposeSlot(nxt);
      try {
        const p = createAudioPlayer({ uri });
        p.loop = true;
        p.volume = 0;
        p.play();
        nxt.player = p;
        nxt.key = cacheKey;
      } catch {
        return;
      }
    } else {
      // Already prepared with correct content. Make sure it's playing at 0.
      try { nxt.player.volume = 0; nxt.player.play(); } catch { /* ignore */ }
    }

    // First-ever transition: skip the fade. Just set volume to target.
    if (!cur.player) {
      try { nxt.player.volume = vol * muteGain; } catch { /* ignore */ }
      activeIsARef.current = !activeIsARef.current;
      setCurrentMidi(midi);
      // Publish to engine immediately — the chase guard relies on this ref
      // being accurate the moment the new pitch becomes audible.
      try { setDroneCurrentMidiRef.current?.(midi); } catch { /* ignore */ }
      return;
    }

    // Crossfade. 5 ticks of 10 ms — linear ramp, simple and clickless.
    cancelCrossfade();
    const STEPS = 5;
    const stepMs = CROSSFADE_MS / STEPS;
    let i = 0;
    const startVol = vol;
    crossfadeTimerRef.current = setInterval(() => {
      i += 1;
      const t = i / STEPS;
      // v1.0.1 — re-check muted on every tick: setMuted(true) mid-crossfade
      // must also silence the in-flight ramp.
      const g = mutedRef.current ? 0 : 1;
      try {
        if (cur.player) cur.player.volume = Math.max(0, startVol * (1 - t)) * g;
      } catch { /* ignore */ }
      try {
        if (nxt.player) nxt.player.volume = Math.max(0, Math.min(1, startVol * t)) * g;
      } catch { /* ignore */ }
      if (i >= STEPS) {
        cancelCrossfade();
        // Park the old player at volume 0; we'll rebuild next time.
        try { if (cur.player) cur.player.volume = 0; } catch { /* ignore */ }
      }
    }, stepMs);

    activeIsARef.current = !activeIsARef.current;
    setCurrentMidi(midi);
    try { setDroneCurrentMidiRef.current?.(midi); } catch { /* ignore */ }
  }, [cancelCrossfade]);

  // When the user toggles ON or OFF.
  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    if (!v) {
      stopAll();
      cancelDuckTimers();
      setCurrentMidi(null);
      // Engine must stop excluding any MIDI from voting once the drone is
      // silent — otherwise a stale exclusion could keep the user's pitch
      // off the incumbent.
      try { setDroneCurrentMidiRef.current?.(null); } catch { /* ignore */ }
    }
  }, [stopAll, cancelDuckTimers]);

  const toggle = useCallback(() => {
    setEnabled(!enabledRef.current);
  }, [setEnabled]);

  // React to incumbentMidi changes + semitones changes. When enabled and a
  // pitch is held, transition the drone to (heldMidi + semitones).
  useEffect(() => {
    if (incumbentMidi !== null) heldMidiRef.current = incumbentMidi;
  }, [incumbentMidi]);

  useEffect(() => {
    if (!enabled) return;
    const heldRaw = heldMidiRef.current;
    if (heldRaw === null) return;
    const target = Math.max(0, Math.min(127, heldRaw + semitones));
    transitionTo(target);
  }, [enabled, incumbentMidi, semitones, voice, a4Hz, transitionTo]);

  // Live volume changes — apply directly to the active player without
  // rebuilding (the WAV's headroom can absorb the change up to ±20%).
  // For larger swings we let the next transition pick a freshly-built file
  // since the cache is keyed by quantized volume.
  // v1.0.1 — skip the player write while muted (targetVolumeRef is already
  // kept current at the top of the hook, so unmute restores the slider value).
  useEffect(() => {
    if (!enabled) return;
    if (mutedRef.current) return;
    const cur = activeIsARef.current ? slotARef.current : slotBRef.current;
    try {
      if (cur.player) cur.player.volume = volume;
    } catch { /* ignore */ }
  }, [volume, enabled]);

  // Lifecycle: silence on background, restore on foreground.
  const wasEnabledRef = useRef(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        wasEnabledRef.current = enabledRef.current;
        if (enabledRef.current) {
          // Mute both slots without disposing — recover quickly on return.
          try { if (slotARef.current.player) slotARef.current.player.volume = 0; } catch { /* ignore */ }
          try { if (slotBRef.current.player) slotBRef.current.player.volume = 0; } catch { /* ignore */ }
        }
      } else if (next === 'active' && wasEnabledRef.current) {
        // v1.0 NOTE-3 — don't restore volume if still muted (deck recording).
        if (!mutedRef.current) {
          const cur = activeIsARef.current ? slotARef.current : slotBRef.current;
          try { if (cur.player) cur.player.volume = targetVolumeRef.current; } catch { /* ignore */ }
        }
        wasEnabledRef.current = false;
      }
    });
    return () => sub.remove();
  }, []);

  // Final teardown.
  useEffect(() => {
    return () => {
      cancelCrossfade();
      cancelDuckTimers();
      disposeSlot(slotARef.current);
      disposeSlot(slotBRef.current);
      try { setDroneCurrentMidiRef.current?.(null); } catch { /* ignore */ }
    };
  }, [cancelCrossfade, cancelDuckTimers]);

  const setMuted = useCallback((muted: boolean) => {
    if (mutedRef.current === muted) return;
    mutedRef.current = muted;
    if (muted) {
      // Silence both slots; keep them playing for instant resume.
      try { if (slotARef.current.player) slotARef.current.player.volume = 0; } catch { /* ignore */ }
      try { if (slotBRef.current.player) slotBRef.current.player.volume = 0; } catch { /* ignore */ }
    } else {
      // Restore only the active (audible) slot to the current target.
      if (!enabledRef.current) return;
      const cur = activeIsARef.current ? slotARef.current : slotBRef.current;
      try { if (cur.player) cur.player.volume = targetVolumeRef.current; } catch { /* ignore */ }
    }
  }, []);

  // v1.0 CRITICAL-2 — stable object identity so callers' useEffect dep arrays
  // don't fire at audio rate. Primitives / null are cheap to compare; the
  // callbacks are already useCallback-wrapped with their own stable deps.
  return useMemo(() => ({
    enabled,
    setEnabled,
    toggle,
    currentMidi,
    currentHz: currentMidi !== null ? freqOf(currentMidi, a4Hz) : null,
    setMuted,
  }), [enabled, setEnabled, toggle, currentMidi, a4Hz, setMuted]);
}
