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
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { createAudioPlayer } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import { buildDroneWavBase64, midiToFrequency } from './audioGen';
import type { DroneVoice } from './audioGen';

const CROSSFADE_MS = 50;

export interface DroneState {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
  /** Effective MIDI the drone is currently sounding (after offset). Null while pitchless and idle. */
  currentMidi: number | null;
  /** Effective Hz the drone is currently sounding. Null while idle. */
  currentHz: number | null;
}

export interface UseDroneArgs {
  incumbentMidi: number | null;
  a4Hz: number;
  voice: DroneVoice;
  /** Volume 0..1. Live — changes apply on the next pitch switch. */
  volume: number;
  /** Signed semitone offset added to incumbentMidi before synth. */
  semitones: number;
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

export function useDrone({ incumbentMidi, a4Hz, voice, volume, semitones }: UseDroneArgs): DroneState {
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

  // Stop any in-flight crossfade timer.
  const cancelCrossfade = useCallback(() => {
    if (crossfadeTimerRef.current !== null) {
      clearInterval(crossfadeTimerRef.current);
      crossfadeTimerRef.current = null;
    }
  }, []);

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
      try { nxt.player.volume = vol; } catch { /* ignore */ }
      activeIsARef.current = !activeIsARef.current;
      setCurrentMidi(midi);
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
      try {
        if (cur.player) cur.player.volume = Math.max(0, startVol * (1 - t));
      } catch { /* ignore */ }
      try {
        if (nxt.player) nxt.player.volume = Math.max(0, Math.min(1, startVol * t));
      } catch { /* ignore */ }
      if (i >= STEPS) {
        cancelCrossfade();
        // Park the old player at volume 0; we'll rebuild next time.
        try { if (cur.player) cur.player.volume = 0; } catch { /* ignore */ }
      }
    }, stepMs);

    activeIsARef.current = !activeIsARef.current;
    setCurrentMidi(midi);
  }, [cancelCrossfade]);

  // When the user toggles ON or OFF.
  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    if (!v) {
      stopAll();
      setCurrentMidi(null);
    }
  }, [stopAll]);

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
  useEffect(() => {
    if (!enabled) return;
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
        const cur = activeIsARef.current ? slotARef.current : slotBRef.current;
        try { if (cur.player) cur.player.volume = targetVolumeRef.current; } catch { /* ignore */ }
        wasEnabledRef.current = false;
      }
    });
    return () => sub.remove();
  }, []);

  // Final teardown.
  useEffect(() => {
    return () => {
      cancelCrossfade();
      disposeSlot(slotARef.current);
      disposeSlot(slotBRef.current);
    };
  }, [cancelCrossfade]);

  const currentHz = currentMidi !== null ? freqOf(currentMidi, a4Hz) : null;

  return {
    enabled,
    setEnabled,
    toggle,
    currentMidi,
    currentHz,
  };
}
