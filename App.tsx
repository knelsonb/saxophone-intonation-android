/**
 * BELLCURVE — Intonation Analyzer, Android.
 *
 * App.tsx is the orchestrator. It owns:
 *   - the audio engine (useAudioEngine)
 *   - the metronome (useMetronome)
 *   - the deck recorder (useDeck)
 *   - the drone (useDrone)
 *   - the active tab
 *   - cross-tab modal state (instrument picker, intonation table, range editor, pitch pipes, horn-name editor)
 *   - the top-level theme provider
 *
 * Per-screen layout lives in `src/screens/*Screen.tsx`. Shared widgets (TopBar,
 * NoteReadout, CentArc, BottomStrip, PermissionGate, etc.) live in
 * `src/tunerWidgets.tsx`. Shared styles + constants live in
 * `src/uiShared.tsx`. The bottom four-tab bar lives in `src/components/TabBar.tsx`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Linking,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';

import { log } from './src/log';
import appJson from './app.json';
import { useAudioEngine } from './src/useAudioEngine';
import type { DisplayMode } from './src/useAudioEngine';
import { transpMap, getInstrument, rangeMap } from './src/instruments';
import {
  centsDeviation,
  centsDisplayPrecision,
  midiToNoteName,
} from './src/music';
import { loadPrefs, savePrefs, DEFAULT_PREFS } from './src/storage/prefs';
import { loadRangeOverrides } from './src/storage/rangeOverrides';
import type { RangeOverride } from './src/storage/rangeOverrides';
import { IntonationTable } from './src/components/IntonationTable';
import { RangeEditor } from './src/components/RangeEditor';
import { PitchPipes } from './src/components/PitchPipes';
import { ThemeProvider, useTheme, getPalette, applyNightFilters } from './src/theme';
import * as AutoMicClaim from './modules/auto-mic-claim';
import type { CarConnectionState, CallState } from './modules/auto-mic-claim';
import {
  makeStyles,
  IDLE_GLOW,
  PEAK_DECAY_PER_SEC,
} from './src/uiShared';
import {
  SilenceBanner,
  TunerInCarSwitch,
  TopBar,
  InstrumentPicker,
  HornNameEditor,
  PermissionGate,
  centsToTickIndex,
} from './src/tunerWidgets';
import type { NoteDisplay } from './src/tunerWidgets';
import { TabBar } from './src/components/TabBar';
import type { TabKey } from './src/components/TabBar';

// Tab navigator — created at module scope, react-navigation pattern. Routes
// are named with the same lower-case keys our TabBar interface uses, so the
// adapter at the bottom of this file can map both directions without a
// translation table.
const Tab = createBottomTabNavigator();
import { TunerScreen } from './src/screens/TunerScreen';
import { MetroScreen } from './src/screens/MetroScreen';
import { DeckScreen } from './src/screens/DeckScreen';
import { SetupScreen } from './src/screens/SetupScreen';
import { useMetronome } from './src/useMetronome';
import { useMidiBus } from './src/useMidiBus';
import synth from '@local/raw-audio-output';
import { usePitchPipes } from './src/usePitchPipes';
import { useUiPrefsStore } from './src/useUiPrefsStore';
import { useDeck } from './src/useDeck';
import { useDrone } from './src/useDrone';
// v1.1 — droneVoice is now a stable string id; the catalog lives in droneVoices.ts.

// ---------------------------------------------------------------------------
// Outer App: provides theme + delegates to AppInner.
// ---------------------------------------------------------------------------

export default function App() {
  const engine = useAudioEngine();
  // Load the bundled Ubuntu fonts before rendering anything that might use
  // the BELLCURVE wordmark or fontFamily-targeted text. Without this gate the
  // first frames render in the fallback (system) font and snap to Ubuntu when
  // it loads — the wordmark visibly reflows. Returning null until ready is
  // standard expo-font practice.
  const [fontsLoaded] = useFonts({
    'Ubuntu-Bold':    require('./assets/fonts/Ubuntu-Bold.ttf'),
    'Ubuntu-Medium':  require('./assets/fonts/Ubuntu-Medium.ttf'),
    'Ubuntu-Regular': require('./assets/fonts/Ubuntu-Regular.ttf'),
  });
  // For the night theme only, transform the palette by the user's darken +
  // warmth sliders. Memoized on the three inputs so we don't allocate a
  // fresh palette every render.
  const palette = useMemo(() => {
    const base = getPalette(engine.theme);
    if (engine.theme === 'night') {
      return applyNightFilters(base, engine.nightDarken, engine.nightWarmth);
    }
    return base;
  }, [engine.theme, engine.nightDarken, engine.nightWarmth]);
  // Pick the status-bar text/icon colour based on theme. DARK and NIGHT need
  // light icons; LIGHT needs dark icons. expo-status-bar then communicates
  // this to the Android system bar so it doesn't fight the theme.
  const statusBarStyle = engine.theme === 'light' ? 'dark' : 'light';
  // v1.4 wave-10 — L1: gate on both fonts AND prefs hydration to prevent the
  // 1-frame theme/filter flash. `prefsLoaded` flips ~100-300 ms after mount
  // once loadPrefs() resolves. We return the same bg-coloured blank View so
  // the palette.bg is already correct (engine.theme is still 'dark' default
  // here, but palette.bg is a dark colour that is safe to show).
  if (!fontsLoaded || !engine.prefsLoaded) {
    // Match the (eventual) palette's background so the splash → first-frame
    // transition doesn't flash white on a dark theme.
    return <View style={{ flex: 1, backgroundColor: palette.bg }} />;
  }
  // GestureHandlerRootView must be at the absolute root so any descendant
  // gesture-handler primitives (used by react-navigation's tab gestures and,
  // later, by @gorhom/bottom-sheet for the drag-to-dismiss modals) can claim
  // touches. Required even though we don't currently use GH directly.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider value={palette}>
          <BottomSheetModalProvider>
            <StatusBar style={statusBarStyle} />
            <AppInner engine={engine} />
          </BottomSheetModalProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function AppInner({ engine }: { engine: ReturnType<typeof useAudioEngine> }) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  const { width, height } = useWindowDimensions();
  const isLandscape = width >= height;
  // v1.2 — safe-area insets push the persistent header below the system status
  // bar + camera cutout. On the tablet, top inset is ~51dp (153px / 3x DPR).
  // Applied to faceplateHeader's paddingTop so the wordmark clears the cutout.
  const insets = useSafeAreaInsets();

  // ----- forensic logger wiring -----

  // Boot message — lets us correlate logcat sessions with ring-buffer tails.
  // v1.4 wave-5 T4 — version strings sourced from app.json (resolveJsonModule)
  // so this never drifts from the actual release version.
  useEffect(() => {
    const ver = appJson.expo.version;
    const vc = appJson.expo.android.versionCode;
    log.i('App', `BellCurve v${ver} boot, versionCode ${vc}`);
  }, []);

  // Recover last-session ring buffer and warn so the developer knows the
  // previous run logged something (useful immediately after a crash repro).
  useEffect(() => {
    log.loadLastSession().then((entries) => {
      if (entries.length > 0) {
        log.w('App', 'Recovered ' + entries.length + ' entries from last session');
      }
    }).catch(() => {});
  }, []);

  // Global unhandled-error hook — log fatal + non-fatal JS errors and persist
  // immediately so a hard crash leaves evidence in AsyncStorage.
  // v1.4 wave-5 T3 — cleanup restores the previous handler so hot-reload /
  // PermissionGate remounts don't chain handlers indefinitely.
  useEffect(() => {
    const g = globalThis as unknown as { ErrorUtils?: {
      getGlobalHandler?: () => ((err: Error, isFatal: boolean) => void) | null;
      setGlobalHandler?: (h: (err: Error, isFatal: boolean) => void) => void;
    } };
    const prev = g.ErrorUtils?.getGlobalHandler?.() ?? null;
    g.ErrorUtils?.setGlobalHandler?.(
      (err: Error, isFatal: boolean) => {
        log.e(
          'GlobalErrorHandler',
          `${isFatal ? 'FATAL ' : ''}${err?.name ?? 'Error'}: ${err?.message ?? '(no message)'}\n${err?.stack ?? '(no stack)'}`,
        );
        log.flushAsync().catch(() => {}); // belt-and-suspenders persist before crash
        if (typeof prev === 'function') prev(err, isFatal);
      },
    );
    return () => {
      if (typeof prev === 'function') {
        g.ErrorUtils?.setGlobalHandler?.(prev);
      }
    };
  }, []);

  // ----- top-level state -----

  // Tab state is owned by react-navigation now — we don't keep a local copy.
  // The TabBar at the bottom of the navigator reads its active route from
  // the navigator's state via the BottomTabBarProps adapter at the foot of
  // this file.

  // #A4-S1 — A4 is now ENGINE-owned (single source of truth). refHz is a
  // read-through of the canonical engine value; setRefHz aliases the engine's
  // live setter (immediate ref+state + debounced persist), so the +/- call
  // sites stay unchanged. Was a parallel useState that never reached the record
  // path → logged cents stale at 440 and calibration lost on restart.
  const refHz = engine.a4Hz;
  const setRefHz = engine.setA4Hz;

  // v1.2 — active tab lifted out of the navigator so the persistent TopBar
  // (rendered above NavigationContainer) can be tab-aware per U7. Mirrors the
  // navigator's active route name; updated via NavigationContainer.onStateChange.
  const [activeTab, setActiveTab] = useState<TabKey>('tuner');

  // Modals owned by App (transient overlays, not screens).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [rangeEditorOpen, setRangeEditorOpen] = useState(false);
  const [pipesOpen, setPipesOpen] = useState(false);
  const [hornNameEdit, setHornNameEdit] = useState(false);
  const [hornNameDraft, setHornNameDraft] = useState('');

  // Debug overlay toggle (mirrors a pref).
  const [showDebugOverlay, setShowDebugOverlay] = useState<boolean>(DEFAULT_PREFS.showDebugOverlay);

  // Per-instrument range overrides.
  const [rangeOverrides, setRangeOverrides] = useState<Record<string, RangeOverride>>({});

  // Min-N threshold (persisted via savePrefsNow).
  const [minN, setMinN] = useState(5);

  // Drone prefs — owned here so they can be persisted + shared across hooks.
  // v1.1 — droneVoice is the DroneVoice.id string (e.g. 'organ', 'gm-19').
  const [droneVoice, setDroneVoiceState] = useState<string>(DEFAULT_PREFS.droneVoice);
  const [droneVolume, setDroneVolumeState] = useState<number>(DEFAULT_PREFS.droneVolume);
  const [droneSemitones, setDroneSemitonesState] = useState<number>(DEFAULT_PREFS.droneSemitones);

  // Android Auto state.
  const [carState, setCarState] = useState<CarConnectionState>('disconnected');
  const [callState, setCallState] = useState<CallState>('inactive');
  useEffect(() => {
    AutoMicClaim.getCarConnectionStateAsync().then(setCarState).catch(() => {});
    AutoMicClaim.getCallStateAsync().then(setCallState).catch(() => {});
    const subs = [
      AutoMicClaim.addCarConnectionListener(setCarState),
      AutoMicClaim.addCallStateListener(setCallState),
      AutoMicClaim.addEndCallButtonListener(() => setCallState('ended')),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);
  // Push car-connection state into the engine so its mic background-stop
  // handler can skip the release when the AutoMicClaimModule deliberately
  // holds the mic for in-car tuning.
  useEffect(() => {
    engine.setCarConnected(carState === 'connected');
  }, [carState, engine.setCarConnected]);
  const handleClaimMic = useCallback(async () => {
    const granted = await AutoMicClaim.requestManageOwnCallsPermissionAsync();
    if (!granted) return;
    await AutoMicClaim.startTunerCallAsync();
  }, []);

  // Silence banner dismiss.
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const prevSilenced = useRef(false);
  useEffect(() => {
    const silenced = engine.micSilenced ?? false;
    if (silenced && !prevSilenced.current) setBannerDismissed(false);
    prevSilenced.current = silenced;
  }, [engine.micSilenced]);

  // Hydrate refHz, minN, debug overlay, drone prefs from prefs (engine
  // handles its own).
  useEffect(() => {
    if (!engine.prefsLoaded) return;
    loadPrefs().then((p) => {
      // #A4-S1 — A4 is hydrated by the engine itself; do NOT setRefHz here
      // (it would call engine.setA4Hz → re-persist on load).
      setMinN(p.minNVisible);
      setShowDebugOverlay(p.showDebugOverlay);
      setDroneVoiceState(p.droneVoice);
      setDroneVolumeState(p.droneVolume);
      setDroneSemitonesState(p.droneSemitones);
    }).catch(() => {});
  // Run once after prefsLoaded flips.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.prefsLoaded]);

  const handleSetShowDebugOverlay = useCallback((v: boolean) => {
    setShowDebugOverlay(v);
    (async () => {
      try {
        const current = await loadPrefs();
        await savePrefs({ ...current, showDebugOverlay: v });
      } catch { /* best-effort */ }
    })();
  }, []);

  // Range overrides hydration.
  useEffect(() => {
    loadRangeOverrides().then((overrides) => setRangeOverrides(overrides)).catch(() => {});
  }, []);

  // #A4-S1 — refHz debounce machinery REMOVED. A4 persistence (and its
  // debounce) now lives in engine.setA4Hz, the single owner; the +/- call sites
  // just call setRefHz (= engine.setA4Hz). This block used to own a parallel
  // debounce that wrote refHz — the very split that left the record path stale.

  // Persist minN on background. (A4 persistence is handled by engine.setA4Hz.)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') {
        engine.savePrefsNow({ minNVisible: minN }).catch(() => {});
      }
    });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minN]);

  // v1.4.x P4 — pin the display to its highest refresh rate while foregrounded
  // so the Pixel's LTPO panel doesn't down-switch (120→80→60) mid-animation and
  // judder the metronome sweep / tuner strobe. Release on background so the
  // panel returns to its adaptive default (battery). Best-effort; the native
  // side no-ops if the Activity isn't available.
  useEffect(() => {
    try { synth.setHighRefreshRate?.(true); } catch { /* ignore */ }
    const sub = AppState.addEventListener('change', (nextState) => {
      try { synth.setHighRefreshRate?.(nextState === 'active'); } catch { /* ignore */ }
    });
    return () => {
      sub.remove();
      try { synth.setHighRefreshRate?.(false); } catch { /* ignore */ }
    };
  }, []);

  const handleMinNChange = useCallback((n: number) => {
    setMinN(n);
    engine.savePrefsNow({ minNVisible: n }).catch(() => {});
  }, [engine]);

  // Drone-pref setters.
  const persistDronePref = useCallback(async (
    patch: Partial<{ droneVoice: string; droneVolume: number; droneSemitones: number; }>,
  ) => {
    try {
      const current = await loadPrefs();
      await savePrefs({ ...current, ...patch });
    } catch { /* best-effort */ }
  }, []);
  const setDroneVoice = useCallback((v: string) => {
    setDroneVoiceState(v);
    persistDronePref({ droneVoice: v });
  }, [persistDronePref]);
  const setDroneVolume = useCallback((n: number) => {
    const clamped = Math.max(0, Math.min(1, n));
    setDroneVolumeState(clamped);
    persistDronePref({ droneVolume: clamped });
  }, [persistDronePref]);
  const setDroneSemitones = useCallback((n: number) => {
    const clamped = Math.max(-12, Math.min(12, Math.round(n)));
    setDroneSemitonesState(clamped);
    persistDronePref({ droneSemitones: clamped });
  }, [persistDronePref]);

  // Meter animation refs.
  const fillAnim = useRef(new Animated.Value(IDLE_GLOW)).current;
  const peakAnim = useRef(new Animated.Value(IDLE_GLOW)).current;
  const peakVal = useRef(IDLE_GLOW);
  const peakTs = useRef(Date.now());
  // PPM/VU convention: latch the peak, hold for 2 s so the eye can read
  // it, THEN decay. Pre-v0.9.8 the peak retreated on the very next render,
  // making the indicator useless for transients.
  const peakHoldUntilRef = useRef(0);

  // v1.0 BUG-1 — peak math moved out of the render body into an effect so
  // unrelated re-renders (modal open, tab switch, etc.) can't restart
  // animations with stale intermediate state.
  useEffect(() => {
    const mf = Math.max(IDLE_GLOW, engine.meterFill);
    const nowMs = Date.now();
    let newPeak: number;
    if (mf >= peakVal.current) {
      // New peak — latch and refresh the hold window.
      newPeak = mf;
      peakHoldUntilRef.current = nowMs + 2000;
    } else if (nowMs < peakHoldUntilRef.current) {
      // Still inside the hold window — freeze.
      newPeak = peakVal.current;
    } else {
      // Decay phase — only after hold expires.
      const elapsed = (nowMs - peakTs.current) / 1000;
      newPeak = Math.max(IDLE_GLOW, peakVal.current - PEAK_DECAY_PER_SEC * elapsed);
    }
    peakVal.current = newPeak;
    peakTs.current = nowMs;
    const springAnim = Animated.spring(fillAnim, {
      toValue: mf,
      useNativeDriver: false,
      damping: 10,
      stiffness: 260,
      mass: 0.2,
    });
    const timingAnim = Animated.timing(peakAnim, {
      toValue: newPeak,
      duration: 60,
      useNativeDriver: false,
    });
    springAnim.start();
    timingAnim.start();
    return () => {
      springAnim.stop();
      timingAnim.stop();
    };
  // fillAnim/peakAnim are stable Animated.Value refs — no need to list them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.meterFill]);

  // Instrument-derived data.
  const instrumentKey: string = engine.instrumentKey ?? 'bb_tenor';
  const transp: number = transpMap[instrumentKey] ?? 0;
  const displayMode: DisplayMode = engine.displayMode ?? 'griff';

  const activeRange: [number, number] | null = useMemo(() => {
    const override = rangeOverrides[instrumentKey];
    if (override) return [override.lo, override.hi];
    const baked = rangeMap[instrumentKey];
    if (baked) return baked;
    return null;
  }, [rangeOverrides, instrumentKey]);

  // Note display.
  const noteDisplay = useMemo((): NoteDisplay | null => {
    if (engine.freqHz === null) return null;
    const { nearestMidi, cents } = centsDeviation(engine.freqHz, refHz);
    const displayedMidi = displayMode === 'klingend' ? nearestMidi : nearestMidi - transp;
    const { letter, accidental, octave } = midiToNoteName(displayedMidi);
    const precision = centsDisplayPrecision(engine.freqHz);
    return { letter, accidental, octave, cents, precision, tickIndex: centsToTickIndex(cents) };
  }, [engine.freqHz, refHz, displayMode, transp]);

  const isOutOfRange: boolean = useMemo(() => {
    if (engine.allowOutOfRange) return false;
    if (engine.freqHz === null) return false;
    if (activeRange === null) return false;
    const { nearestMidi } = centsDeviation(engine.freqHz, refHz);
    const midiFing = nearestMidi - transp;
    return midiFing < activeRange[0] || midiFing > activeRange[1];
  }, [engine.allowOutOfRange, engine.freqHz, refHz, transp, activeRange]);

  const instrumentDisplayName: string = (() => {
    const def = getInstrument(instrumentKey);
    if (def) return def.nameEn.toUpperCase();
    return instrumentKey.replace(/_/g, ' ').toUpperCase();
  })();
  const badgeText = instrumentDisplayName;

  // v1.3 — MIDI bus owns synth singleton + WAV fallback + per-channel reservation.
  // All synth consumers (drone, metronome, pipes) reserve their channel from this bus.
  const bus = useMidiBus();

  // v1.4.x #167 — feed the user's selected output route into the bus so its
  // cold-start latency guess (before AudioTrack.getTimestamp warms up) matches
  // the real path (speaker/wired/BT). The bus holds it in a ref, so this never
  // churns the build-once bus interface; both the metronome and the pendulum
  // then read one effective latency via getCompensationLatencyMs().
  useEffect(() => {
    bus.setOutputRoute?.(engine.metroOutputRoute);
  }, [bus, engine.metroOutputRoute]);

  // v1.4 wave-10 T3 — SF2 loading feedback. Show "Loading sounds…" until the
  // bus reports ready. If it hasn't resolved after 10 s, surface a persistent
  // "Synth unavailable" warning (error-states-are-mandatory axiom).
  const [synthWarnShown, setSynthWarnShown] = useState(false);
  const synthWarnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (bus.ready) {
      // Cancel any pending 10-s timeout — synth arrived in time.
      if (synthWarnTimerRef.current !== null) {
        clearTimeout(synthWarnTimerRef.current);
        synthWarnTimerRef.current = null;
      }
      setSynthWarnShown(false);
      return;
    }
    // Arm the 10-s timeout only once (first render where ready is false).
    if (synthWarnTimerRef.current !== null) return;
    synthWarnTimerRef.current = setTimeout(() => {
      setSynthWarnShown(true);
      log.w('App', 'synth-load-timeout — SF2 did not become ready within 10 s');
    }, 10_000);
  }, [bus.ready]);
  useEffect(() => {
    // v1.4 wave-10 T3 — clear timer on unmount.
    return () => {
      if (synthWarnTimerRef.current !== null) {
        clearTimeout(synthWarnTimerRef.current);
      }
    };
  }, []);
  // v1.3 — UI prefs store; v1.3.0 consumes pipesVoice from here (other fields
  // still flow via engine until Wave 3.5 migrates consumers off useAudioEngine).
  const uiPrefs = useUiPrefsStore();

  // ----- Sub-hooks: metronome, deck, drone, pipes -----

  const metro = useMetronome({
    bus,
    clickOffsetMs: engine.metroClickOffsetMs,
    outputRoute: engine.metroOutputRoute,
  });
  const deck = useDeck({ bus });
  const drone = useDrone({
    bus,
    incumbentMidi: engine.incumbentMidi,
    a4Hz: refHz,
    voice: droneVoice,
    volume: droneVolume,
    semitones: droneSemitones,
    setDroneCurrentMidi: engine.setDroneCurrentMidi,
    installDroneDuckHandler: engine.installDroneDuckHandler,
  });
  // v1.3 — pipes reserve 'pipes' channel; infinite sustain via tap-toggle.
  const pipes = usePitchPipes({ bus, a4Hz: refHz });

  // v1.3 — v1.0 BUG-4 fix moves to the bus layer (G12 council).
  // Mute the whole synth singleton while deck is recording so no MIDI consumer leaks into the mic.
  useEffect(() => {
    bus.setMasterMute(deck.mode === 'recording');
  }, [deck.mode, bus]);

  // Permission gate short-circuits the entire tabbed UI.
  if (engine.status === 'mic-denied' || engine.status === 'stream-failed') {
    return (
      // v1.0 BUG-3 — forward real badgeText + displayMode
      <PermissionGate
        refHz={refHz}
        status={engine.status}
        reason={engine.streamErrorReason}
        badgeText={badgeText}
        displayMode={displayMode}
        onOpenSettings={() => { Linking.openSettings().catch(() => {}); }}
        onRetry={() => {
          if (engine.status === 'mic-denied') {
            engine.retryPermission().catch(() => {});
          } else {
            engine.retryStream();
          }
        }}
      />
    );
  }

  const showSilenceBanner = (engine.micSilenced ?? false) && !bannerDismissed;
  // Cap portrait note glyph at 130dp — was 150dp, but on Pixel 9 Pro the
  // 150dp letter + the rest of TunerScreen overflowed the body budget by
  // ~34dp in worst-case (drone open + out-of-range pill + non-listening
  // status). 130dp keeps the readout dominant without clipping.
  const noteFontSize = isLandscape ? 180 : 130;

  // ----- Render -----

  // Inline TunerScreen wrapper — pulls all its props from the closure so we
  // don't have to add a context layer. The four wrappers below do the same.
  // react-navigation re-renders each on focus change (and on each parent
  // re-render while focused), so closure-fresh props arrive every frame.
  const renderTunerScreen = () => (
    <TunerScreen
      engine={engine}
      refHz={refHz}
      noteDisplay={noteDisplay}
      isLandscape={isLandscape}
      setRefHz={setRefHz}
      setDisplayMode={engine.setDisplayMode ?? (() => {})}
      onTablePress={() => setTableOpen(true)}
      onPipesPress={() => setPipesOpen(true)}
      noteFontSize={noteFontSize}
      isOutOfRange={isOutOfRange}
      displayMode={displayMode}
      transp={transp}
      fillAnim={fillAnim}
      peakAnim={peakAnim}
      showDebugOverlay={showDebugOverlay}
      drone={drone}
      droneVolume={droneVolume}
      droneSemitones={droneSemitones}
      setDroneVolume={setDroneVolume}
      setDroneSemitones={setDroneSemitones}
      droneVoice={droneVoice}
      setDroneVoice={setDroneVoice}
      pipesVoice={uiPrefs.pipesVoice}
      setPipesVoice={uiPrefs.setPipesVoice}
      carState={carState}
      callState={callState}
      onClaimMic={handleClaimMic}
      onReleaseMic={() => AutoMicClaim.endTunerCallAsync().catch(() => {})}
    />
  );
  const renderMetroScreen = () => (
    <MetroScreen metro={metro} metroStyle={engine.metroStyle} outputRoute={engine.metroOutputRoute} bus={bus} />
  );
  const renderDeckScreen = () => (
    <DeckScreen deck={deck} deckStyle={engine.deckStyle} />
  );
  const renderSetupScreen = () => (
    <SetupScreen
      engine={engine}
      refHz={refHz}
      setRefHz={setRefHz}
      showDebugOverlay={showDebugOverlay}
      setShowDebugOverlay={handleSetShowDebugOverlay}
      onOpenPipes={() => setPipesOpen(true)}
      onOpenRangeEditor={() => setRangeEditorOpen(true)}
      onEditHornName={() => { setHornNameDraft(engine.nickname); setHornNameEdit(true); }}
      metro={metro}
    />
  );

  return (
    <View style={[styles.rootTabbed, isLandscape && styles.rootTabbedLand]}>
      {/* Persistent chrome. PORTRAIT: full-width top band (column root).
          LANDSCAPE (#69): a fixed-width LEFT RAIL (row root) so nothing spans
          the full top — the navigator fills the rest at full height. */}
      <View
        style={[
          styles.faceplateHeader,
          isLandscape
            ? { paddingTop: insets.top, paddingLeft: insets.left }
            : { paddingTop: insets.top },
          isLandscape && styles.faceplateRail,
        ]}
      >
        <TopBar
          activeTab={activeTab}
          status={engine.status}
          streamErrorReason={engine.streamErrorReason}
          refHz={refHz}
          setRefHz={setRefHz}
          compact={!isLandscape}
          land={isLandscape}
          badgeText={badgeText}
          displayMode={displayMode}
          setDisplayMode={engine.setDisplayMode ?? (() => {})}
          onBadgePress={() => setPickerOpen(true)}
          onTablePress={() => setTableOpen(true)}
          onPipesPress={() => setPipesOpen(true)}
          hornName={engine.nickname}
        />
        {showSilenceBanner && !isLandscape && (
          <SilenceBanner onDismiss={() => setBannerDismissed(true)} />
        )}
        {/* TunerInCarSwitch was previously rendered here for every tab when
            a car was connected — wasting ~64dp on METRO/DECK/SETUP where
            you can't claim the mic anyway. Moved into TunerScreen so it
            only appears where it's actionable. */}
      </View>

      {/* Navigator. Each screen lives in its own route; the bottom TabBar
          comes from the `tabBar` prop (our existing custom TabBar via the
          NavTabBar adapter). `sceneStyle` applies the per-screen padding
          we used to get from `faceplateTabbed`. Android back from a non-
          initial tab returns to the initial tab now, which is the standard
          tab-app expectation. */}
      <NavigationContainer
        onStateChange={(state) => {
          // v1.2 — lift active route name out of the navigator so the
          // persistent TopBar (rendered outside NavigationContainer) can
          // be tab-aware per U7. Identity mapping; route names are TabKey.
          if (!state) return;
          const name = state.routes[state.index]?.name as TabKey | undefined;
          if (name && name !== activeTab) setActiveTab(name);
        }}
      >
        <Tab.Navigator
          initialRouteName="tuner"
          screenOptions={{
            headerShown: false,
            sceneStyle: { backgroundColor: C.face, paddingHorizontal: 24 },
          }}
          tabBar={(p) => (
            // v1.0 BUG-5 — thread running indicators from closed-over hooks
            <NavTabBar
              {...p}
              metroRunning={metro.running}
              deckRecording={deck.mode === 'recording'}
            />
          )}
        >
          <Tab.Screen name="tuner">{renderTunerScreen}</Tab.Screen>
          <Tab.Screen name="metro">{renderMetroScreen}</Tab.Screen>
          <Tab.Screen name="deck">{renderDeckScreen}</Tab.Screen>
          <Tab.Screen name="setup">{renderSetupScreen}</Tab.Screen>
        </Tab.Navigator>
      </NavigationContainer>

      {/* #69 landscape — SilenceBanner re-homed to the top of the content area
          (the 120dp rail is too narrow for the banner text). */}
      {showSilenceBanner && isLandscape && (
        <View style={{ position: 'absolute', top: insets.top, left: 96, right: 0 }}>
          <SilenceBanner onDismiss={() => setBannerDismissed(true)} />
        </View>
      )}

      {/* v1.4 wave-10 T3 — SF2 loading feedback. Chip visible until the bus
          reports ready; replaced by a persistent warning after 10 s.
          `pointerEvents="none"` so it never blocks touches.
          v1.4 closeout (Frodo NOTE-1) — re-anchored from bottom:80/right:16,
          which floated over the DECK SAVE/SHARE/CLEAR row and the TUNER drone
          controls (both live in the lower-right of those tabs). Top-centred,
          just under the persistent TopBar, is the one band with no interactive
          content on any tab. The 'Synth unavailable' variant now names a NEXT
          STEP ('restart the app') instead of dead-ending on the bare problem —
          drone/metro/pipes are silent and the user otherwise has no recourse. */}
      {!bus.ready && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: insets.top + 60,
            left: isLandscape ? 96 : 0,
            right: 0,
            alignItems: 'center',
          }}
        >
          <View
            style={{
              backgroundColor: synthWarnShown ? 'rgba(200,50,50,0.88)' : 'rgba(30,30,30,0.75)',
              borderRadius: 6,
              paddingHorizontal: 10,
              paddingVertical: 5,
              maxWidth: '90%',
            }}
          >
            <Text style={{ color: '#fff', fontSize: 11, fontFamily: 'Ubuntu-Regular', textAlign: 'center' }}>
              {synthWarnShown ? 'Synth unavailable — restart the app' : 'Loading sounds…'}
            </Text>
          </View>
        </View>
      )}

      {/* Modals — visible across tabs as overlays. */}
      <InstrumentPicker
        visible={pickerOpen}
        currentKey={instrumentKey}
        onSelect={(key) => {
          (engine.setInstrumentKey ?? (() => {}))(key);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
      <IntonationTable
        visible={tableOpen}
        onClose={() => setTableOpen(false)}
        instrumentKey={instrumentKey}
        displayMode={displayMode}
        a4Hz={refHz}
        minN={minN}
        onMinNChange={handleMinNChange}
        allowOutOfRange={engine.allowOutOfRange}
        onAllowOutOfRangeChange={engine.setAllowOutOfRange}
        activeRange={activeRange}
      />
      <RangeEditor
        visible={rangeEditorOpen}
        onClose={() => setRangeEditorOpen(false)}
        instrumentKey={instrumentKey}
        displayMode={displayMode}
        currentRange={activeRange ?? (rangeMap[instrumentKey] ?? [0, 127])}
        onSaved={(lo, hi) => {
          setRangeOverrides((prev) => ({ ...prev, [instrumentKey]: { lo, hi } }));
        }}
        onReset={() => {
          setRangeOverrides((prev) => {
            const next = { ...prev };
            delete next[instrumentKey];
            return next;
          });
        }}
      />
      <PitchPipes
        visible={pipesOpen}
        onClose={() => setPipesOpen(false)}
        refHz={refHz}
        instrumentKey={instrumentKey}
        pipes={pipes}
      />
      <HornNameEditor
        visible={hornNameEdit}
        initialValue={engine.nickname}
        onClose={() => setHornNameEdit(false)}
        onSave={(v) => {
          engine.setNickname(v);
          engine.savePrefsNow({ nickname: v }).catch(() => {});
          setHornNameEdit(false);
        }}
        draft={hornNameDraft}
        setDraft={setHornNameDraft}
      />
    </View>
  );
}

/**
 * Adapter — translates react-navigation's BottomTabBarProps to our custom
 * TabBar's `{ active, onChange }` interface. The route names registered on
 * Tab.Navigator are already our TabKey values, so the mapping is identity.
 *
 * `navigation.navigate(route)` is the standard way to switch tabs; it also
 * lets Android's back button restore the previous tab (the navigator owns
 * a history stack for tab switches when you opt in via `backBehavior`).
 *
 * v1.0 BUG-5 — metroRunning / deckRecording are passed from AppInner via
 * the closure captured in the inline arrow passed to `tabBar`.
 */
function NavTabBar(props: BottomTabBarProps & { metroRunning?: boolean; deckRecording?: boolean }) {
  const active = props.state.routes[props.state.index].name as TabKey;
  return (
    <TabBar
      active={active}
      onChange={(next) => {
        props.navigation.navigate(next as never);
      }}
      metroRunning={props.metroRunning}
      deckRecording={props.deckRecording}
    />
  );
}
