/**
 * useDronePrefs — persisted drone-specific UI preferences.
 *
 * Sibling hook to useUiPrefsStore (Wave 1B, v1.3 state-machine scrub).
 * Owns the three prefs that currently live in App.tsx (§3.3 of the design
 * doc) with the same debounced-writer / per-field-setter contract (G3 / G5).
 *
 * Drone operational state (currentMidi, muted, duck envelope) stays in
 * useDrone. Only the user-facing appearance prefs live here.
 *
 * Same shape as useUiPrefsStore:
 *   - Per-field setters for ergonomic call sites.
 *   - update(patch) escape hatch for batch writes.
 *   - flush() for AppState background synchronous drain.
 *   - useMemo-wrapped return for identity stability.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { loadPrefs, savePrefs, DEFAULT_PREFS } from './storage/prefs';
import { DRONE_DEFAULT_VOICE } from './droneVoices';

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

export interface DronePrefsFields {
  /** Stable DroneVoice.id string (e.g. 'organ', 'cello', 'gm-19'). */
  droneVoice:     string;
  /** 0..1 playback gain. */
  droneVolume:    number;
  /** Signed semitone offset applied to detected MIDI. -12..12, integer. */
  droneSemitones: number;
}

// ---------------------------------------------------------------------------
// DronePrefsState — hook return surface
// ---------------------------------------------------------------------------

export interface DronePrefsState extends DronePrefsFields {
  /** False until the first loadPrefs() resolves on mount. */
  prefsLoaded: boolean;

  setDroneVoice:     (id: string) => void;
  setDroneVolume:    (v: number)  => void;
  setDroneSemitones: (n: number)  => void;

  /**
   * Batch patch — canonical write path.
   * Merges patch into in-memory state immediately (synchronous) and
   * schedules a 250 ms debounced AsyncStorage write.
   * Returns void; callers do NOT await.
   */
  update: (patch: Partial<DronePrefsFields>) => void;

  /**
   * Flush any pending debounced write immediately.
   * Exposed for AppState background and tests.
   */
  flush: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useDronePrefs(): DronePrefsState {

  // ---- State ----
  const [prefsLoaded,    setPrefsLoaded]       = useState(false);
  const [droneVoice,     setDroneVoiceState]   = useState<string>(DRONE_DEFAULT_VOICE.id);
  const [droneVolume,    setDroneVolumeState]  = useState(DEFAULT_PREFS.droneVolume);
  const [droneSemitones, setDroneSemitonesState] = useState(DEFAULT_PREFS.droneSemitones);

  // ---- Debounce refs ----
  const pendingSaveRef = useRef<Partial<DronePrefsFields> | null>(null);
  const timerRef       = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- flush ----
  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingSaveRef.current;
    if (pending === null) return;
    pendingSaveRef.current = null;
    try {
      const current = await loadPrefs();
      await savePrefs({ ...current, ...pending });
    } catch {
      // Best-effort.
    }
  }, []);

  // ---- update — canonical write path ----
  const update = useCallback((patch: Partial<DronePrefsFields>): void => {
    // 1. Synchronous in-memory update.
    if ('droneVoice'     in patch) setDroneVoiceState(patch.droneVoice!);
    if ('droneVolume'    in patch) setDroneVolumeState(patch.droneVolume!);
    if ('droneSemitones' in patch) setDroneSemitonesState(patch.droneSemitones!);

    // 2. Accumulate patch.
    pendingSaveRef.current = { ...(pendingSaveRef.current ?? {}), ...patch };

    // 3. Reset 250 ms debounce.
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const toBeSaved = pendingSaveRef.current;
      if (toBeSaved === null) return;
      pendingSaveRef.current = null;
      (async () => {
        try {
          const current = await loadPrefs();
          await savePrefs({ ...current, ...toBeSaved });
        } catch {
          // Best-effort.
        }
      })();
    }, 250);
  }, []);

  // ---- Per-field setters ----

  const setDroneVoice = useCallback((id: string): void => {
    // Pass through unknown ids — resolveDroneVoice() handles them at the
    // consumer site (same contract as prefs.ts migrateDroneVoiceId).
    update({ droneVoice: id });
  }, [update]);

  const setDroneVolume = useCallback((v: number): void => {
    const clamped = Math.max(0.0, Math.min(1.0, v));
    update({ droneVolume: clamped });
  }, [update]);

  const setDroneSemitones = useCallback((n: number): void => {
    const clamped = Math.max(-12, Math.min(12, Math.trunc(n)));
    update({ droneSemitones: clamped });
  }, [update]);

  // ---- Hydration on mount ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await loadPrefs();
        if (cancelled) return;
        setDroneVoiceState(p.droneVoice);
        setDroneVolumeState(p.droneVolume);
        setDroneSemitonesState(p.droneSemitones);
        setPrefsLoaded(true);
      } catch {
        if (!cancelled) setPrefsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  // Run exactly once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- AppState background → flush ----
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') {
        flush().catch(() => {});
      }
    });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Memoized return ----
  return useMemo((): DronePrefsState => ({
    prefsLoaded,
    droneVoice,
    droneVolume,
    droneSemitones,
    setDroneVoice,
    setDroneVolume,
    setDroneSemitones,
    update,
    flush,
  }), [
    prefsLoaded,
    droneVoice,
    droneVolume,
    droneSemitones,
    setDroneVoice,
    setDroneVolume,
    setDroneSemitones,
    update,
    flush,
  ]);
}
