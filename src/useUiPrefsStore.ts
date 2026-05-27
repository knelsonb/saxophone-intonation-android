/**
 * useUiPrefsStore — persisted UI-side preferences.
 *
 * Owns every pref that has NOTHING to do with audio-engine internals:
 * visual styles, calibration values, drone appearance, display toggles.
 * This is Wave 1B of the v1.3 state-machine scrub (design doc §2.1 / §4).
 *
 * Architecture constraints (per council-decisions.md):
 *  - G3:  single debounced writer (250 ms), `prefs.update()` is the canonical path.
 *  - G5:  both per-field setters AND update() escape hatch.
 *  - U22: metroProfilesJson validated before overwriting legacy fields (see
 *         loadMetroProfiles() in src/storage/prefs.ts — called by useMetronome,
 *         not here; this hook does NOT own metroPatternJson).
 *  - Identity: returned object is useMemo-wrapped; dep list is all scalars +
 *    all setters (which are stable [] useCallback's), so the object identity
 *    only changes when the user actually changes a pref.
 *
 * Off-limits: this hook must never import useAudioEngine or any audio module.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { loadPrefs, savePrefs, DEFAULT_PREFS } from './storage/prefs';
import type { ThemeName } from './theme';

// ---------------------------------------------------------------------------
// Field types (re-export subset so consumers don't need to reach into prefs)
// ---------------------------------------------------------------------------

export type TunerStyleKey  = 'arc' | 'strobe' | 'led';
export type MetroStyleKey  = 'pulse' | 'pendulum' | 'flash';
export type DeckStyleKey   = 'reels' | 'vu' | 'waveform';
export type MetroRoute     = 'speaker' | 'wired' | 'bluetooth';
export type DisplayModeKey = 'griff' | 'klingend';
export type FilterModeKey  = 'fast' | 'normal' | 'slow';
export type GainModeKey    = 'low' | 'high';

// ---------------------------------------------------------------------------
// UiPrefsFields — the plain-data subset (no setters).
// Matches §4.1 of the design doc with the current-wave scope (Wave 1B).
// ---------------------------------------------------------------------------

export interface UiPrefsFields {
  // ---- Display + ergonomics ----
  theme:           ThemeName;
  nightDarken:     number;          // 0.4..1.0
  nightWarmth:     number;          // -1..1
  displayMode:     DisplayModeKey;

  // ---- Visualization styles ----
  tunerStyle:      TunerStyleKey;
  metroStyle:      MetroStyleKey;
  deckStyle:       DeckStyleKey;

  // ---- Metro calibration (not scheduler state) ----
  metroClickOffsetMs:  number;      // -50..50
  metroOutputRoute:    MetroRoute;

  // ---- Debug flag ----
  showDebugOverlay: boolean;

  // ---- Pipes voice (v1.3 — GM patch 0..127, default 80 Synth Lead Square per U25) ----
  pipesVoice: number;
}

// ---------------------------------------------------------------------------
// UiPrefsState — the full hook return surface (G5: fields + setters + update)
// ---------------------------------------------------------------------------

export interface UiPrefsState extends UiPrefsFields {
  /** False until the first loadPrefs() resolves on mount. */
  prefsLoaded: boolean;

  // Per-field setters — thin wrappers around update() for ergonomic call sites.
  setTheme:               (t: ThemeName)       => void;
  setNightDarken:         (v: number)          => void;
  setNightWarmth:         (v: number)          => void;
  setDisplayMode:         (m: DisplayModeKey)  => void;
  setTunerStyle:          (s: TunerStyleKey)   => void;
  setMetroStyle:          (s: MetroStyleKey)   => void;
  setDeckStyle:           (s: DeckStyleKey)    => void;
  setMetroClickOffsetMs:  (ms: number)         => void;
  setMetroOutputRoute:    (r: MetroRoute)      => void;
  setShowDebugOverlay:    (v: boolean)         => void;
  setPipesVoice:          (program: number)    => void;

  /**
   * Batch patch — canonical write path.
   * Merges `patch` into in-memory state immediately (synchronous) and
   * schedules a 250 ms debounced AsyncStorage write.
   * Returns void; callers do NOT await.
   */
  update: (patch: Partial<UiPrefsFields>) => void;

  /**
   * Flush any pending debounced write immediately (no-op if nothing pending).
   * Called automatically on AppState 'background'; exposed for tests.
   */
  flush: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useUiPrefsStore(): UiPrefsState {

  // ---- State ----
  const [prefsLoaded,        setPrefsLoaded]        = useState(false);
  const [theme,              setThemeState]          = useState<ThemeName>(DEFAULT_PREFS.theme);
  const [nightDarken,        setNightDarkenState]    = useState(DEFAULT_PREFS.nightDarken);
  const [nightWarmth,        setNightWarmthState]    = useState(DEFAULT_PREFS.nightWarmth);
  const [displayMode,        setDisplayModeState]    = useState<DisplayModeKey>(DEFAULT_PREFS.displayMode);
  const [tunerStyle,         setTunerStyleState]     = useState<TunerStyleKey>(DEFAULT_PREFS.tunerStyle);
  const [metroStyle,         setMetroStyleState]     = useState<MetroStyleKey>(DEFAULT_PREFS.metroStyle);
  const [deckStyle,          setDeckStyleState]      = useState<DeckStyleKey>(DEFAULT_PREFS.deckStyle);
  const [metroClickOffsetMs, setMetroClickOffsetMsState] = useState(DEFAULT_PREFS.metroClickOffsetMs);
  const [metroOutputRoute,   setMetroOutputRouteState]   = useState<MetroRoute>(DEFAULT_PREFS.metroOutputRoute);
  const [showDebugOverlay,   setShowDebugOverlayState]   = useState(DEFAULT_PREFS.showDebugOverlay);
  const [pipesVoice,         setPipesVoiceState]         = useState(DEFAULT_PREFS.pipesVoice);

  // ---- Debounce refs ----
  // pendingSaveRef accumulates field patches between debounce fires.
  // timerRef is the pending setTimeout id (null when idle).
  const pendingSaveRef = useRef<Partial<UiPrefsFields> | null>(null);
  const timerRef       = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- flush — write pendingSave to AsyncStorage immediately ----
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
      // Best-effort. AsyncStorage errors must never reach the UI.
    }
  }, []);

  // ---- update — the canonical write path (G3 / G5) ----
  const update = useCallback((patch: Partial<UiPrefsFields>): void => {
    // 1. Apply in-memory state changes synchronously.
    if ('theme'              in patch) setThemeState(patch.theme!);
    if ('nightDarken'        in patch) setNightDarkenState(patch.nightDarken!);
    if ('nightWarmth'        in patch) setNightWarmthState(patch.nightWarmth!);
    if ('displayMode'        in patch) setDisplayModeState(patch.displayMode!);
    if ('tunerStyle'         in patch) setTunerStyleState(patch.tunerStyle!);
    if ('metroStyle'         in patch) setMetroStyleState(patch.metroStyle!);
    if ('deckStyle'          in patch) setDeckStyleState(patch.deckStyle!);
    if ('metroClickOffsetMs' in patch) setMetroClickOffsetMsState(patch.metroClickOffsetMs!);
    if ('metroOutputRoute'   in patch) setMetroOutputRouteState(patch.metroOutputRoute!);
    if ('showDebugOverlay'   in patch) setShowDebugOverlayState(patch.showDebugOverlay!);
    if ('pipesVoice'         in patch) setPipesVoiceState(patch.pipesVoice!);

    // 2. Accumulate into pending save (merge; later fields win over earlier ones).
    pendingSaveRef.current = { ...(pendingSaveRef.current ?? {}), ...patch };

    // 3. Reset the 250 ms debounce timer.
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const toBeSaved = pendingSaveRef.current;
      if (toBeSaved === null) return;
      pendingSaveRef.current = null;
      // Fire-and-forget; errors are swallowed inside savePrefs.
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

  // ---- Per-field setters (G5 — thin wrappers around update) ----

  const setTheme = useCallback((t: ThemeName): void => {
    update({ theme: t });
  }, [update]);

  const setNightDarken = useCallback((v: number): void => {
    const clamped = Math.max(0.4, Math.min(1.0, v));
    update({ nightDarken: clamped });
  }, [update]);

  const setNightWarmth = useCallback((v: number): void => {
    const clamped = Math.max(-1.0, Math.min(1.0, v));
    update({ nightWarmth: clamped });
  }, [update]);

  const setDisplayMode = useCallback((m: DisplayModeKey): void => {
    update({ displayMode: m });
  }, [update]);

  const setTunerStyle = useCallback((s: TunerStyleKey): void => {
    update({ tunerStyle: s });
  }, [update]);

  const setMetroStyle = useCallback((s: MetroStyleKey): void => {
    update({ metroStyle: s });
  }, [update]);

  const setDeckStyle = useCallback((s: DeckStyleKey): void => {
    update({ deckStyle: s });
  }, [update]);

  const setMetroClickOffsetMs = useCallback((ms: number): void => {
    // Clamp and round to 5 ms step (mirrors useAudioEngine's setter).
    const clamped = Math.max(-50, Math.min(50, Math.round(ms / 5) * 5));
    update({ metroClickOffsetMs: clamped });
  }, [update]);

  const setMetroOutputRoute = useCallback((r: MetroRoute): void => {
    update({ metroOutputRoute: r });
  }, [update]);

  const setShowDebugOverlay = useCallback((v: boolean): void => {
    update({ showDebugOverlay: v });
  }, [update]);

  const setPipesVoice = useCallback((program: number): void => {
    // GM patch range 0..127, integer. Clamp + round defensively so a slider
    // bound to a continuous value can't poison the persisted field.
    if (!Number.isFinite(program)) return;
    const clamped = Math.max(0, Math.min(127, Math.round(program)));
    update({ pipesVoice: clamped });
  }, [update]);

  // ---- Hydration on mount ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await loadPrefs();
        if (cancelled) return;
        setThemeState(p.theme);
        setNightDarkenState(p.nightDarken);
        setNightWarmthState(p.nightWarmth);
        setDisplayModeState(p.displayMode);
        setTunerStyleState(p.tunerStyle);
        setMetroStyleState(p.metroStyle);
        setDeckStyleState(p.deckStyle);
        setMetroClickOffsetMsState(p.metroClickOffsetMs);
        setMetroOutputRouteState(p.metroOutputRoute);
        setShowDebugOverlayState(p.showDebugOverlay);
        setPipesVoiceState(p.pipesVoice);
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
  // flush is stable (useCallback with no deps that change).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Memoized return surface (v1.2.1 lesson: stable identity) ----
  return useMemo((): UiPrefsState => ({
    prefsLoaded,
    theme,
    nightDarken,
    nightWarmth,
    displayMode,
    tunerStyle,
    metroStyle,
    deckStyle,
    metroClickOffsetMs,
    metroOutputRoute,
    showDebugOverlay,
    pipesVoice,
    setTheme,
    setNightDarken,
    setNightWarmth,
    setDisplayMode,
    setTunerStyle,
    setMetroStyle,
    setDeckStyle,
    setMetroClickOffsetMs,
    setMetroOutputRoute,
    setShowDebugOverlay,
    setPipesVoice,
    update,
    flush,
  }), [
    prefsLoaded,
    theme,
    nightDarken,
    nightWarmth,
    displayMode,
    tunerStyle,
    metroStyle,
    deckStyle,
    metroClickOffsetMs,
    metroOutputRoute,
    showDebugOverlay,
    pipesVoice,
    setTheme,
    setNightDarken,
    setNightWarmth,
    setDisplayMode,
    setTunerStyle,
    setMetroStyle,
    setDeckStyle,
    setMetroClickOffsetMs,
    setMetroOutputRoute,
    setShowDebugOverlay,
    setPipesVoice,
    update,
    flush,
  ]);
}
