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
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';

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
  REF_HZ_DEFAULT,
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
import { useDeck } from './src/useDeck';
import { useDrone } from './src/useDrone';
import type { DroneVoice } from './src/audioGen';

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
  if (!fontsLoaded) {
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

  // ----- top-level state -----

  // Tab state is owned by react-navigation now — we don't keep a local copy.
  // The TabBar at the bottom of the navigator reads its active route from
  // the navigator's state via the BottomTabBarProps adapter at the foot of
  // this file.

  const [refHz, setRefHz] = useState(REF_HZ_DEFAULT);

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
  const [droneVoice, setDroneVoiceState] = useState<DroneVoice>(DEFAULT_PREFS.droneVoice);
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
      setRefHz(p.refHz);
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

  // Persist refHz + minN on background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') {
        engine.savePrefsNow({ refHz, minNVisible: minN }).catch(() => {});
      }
    });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refHz, minN]);

  const handleMinNChange = useCallback((n: number) => {
    setMinN(n);
    engine.savePrefsNow({ minNVisible: n }).catch(() => {});
  }, [engine]);

  // Drone-pref setters.
  const persistDronePref = useCallback(async (
    patch: Partial<{ droneVoice: DroneVoice; droneVolume: number; droneSemitones: number; }>,
  ) => {
    try {
      const current = await loadPrefs();
      await savePrefs({ ...current, ...patch });
    } catch { /* best-effort */ }
  }, []);
  const setDroneVoice = useCallback((v: DroneVoice) => {
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

  const mf = Math.max(IDLE_GLOW, engine.meterFill);
  const elapsed = (Date.now() - peakTs.current) / 1000;
  const decayed = Math.max(IDLE_GLOW, peakVal.current - PEAK_DECAY_PER_SEC * elapsed);
  const newPeak = Math.max(decayed, mf);
  peakVal.current = newPeak;
  peakTs.current = Date.now();
  Animated.spring(fillAnim, { toValue: mf, useNativeDriver: false, damping: 10, stiffness: 260, mass: 0.2 }).start();
  Animated.timing(peakAnim, { toValue: newPeak, duration: 60, useNativeDriver: false }).start();

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

  // ----- Sub-hooks: metronome, deck, drone -----

  const metro = useMetronome({
    clickOffsetMs: engine.metroClickOffsetMs,
    outputRoute: engine.metroOutputRoute,
  });
  const deck = useDeck();
  const drone = useDrone({
    incumbentMidi: engine.incumbentMidi,
    a4Hz: refHz,
    voice: droneVoice,
    volume: droneVolume,
    semitones: droneSemitones,
    setDroneCurrentMidi: engine.setDroneCurrentMidi,
    installDroneDuckHandler: engine.installDroneDuckHandler,
  });

  // Permission gate short-circuits the entire tabbed UI.
  if (engine.status === 'mic-denied' || engine.status === 'stream-failed') {
    return (
      <PermissionGate
        refHz={refHz}
        status={engine.status}
        reason={engine.streamErrorReason}
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
      carState={carState}
      callState={callState}
      onClaimMic={handleClaimMic}
      onReleaseMic={() => AutoMicClaim.endTunerCallAsync().catch(() => {})}
    />
  );
  const renderMetroScreen = () => (
    <MetroScreen metro={metro} metroStyle={engine.metroStyle} outputRoute={engine.metroOutputRoute} />
  );
  const renderDeckScreen = () => (
    <DeckScreen deck={deck} deckStyle={engine.deckStyle} />
  );
  const renderSetupScreen = () => (
    <SetupScreen
      engine={engine}
      refHz={refHz}
      setRefHz={(v) => {
        setRefHz(v);
        engine.savePrefsNow({ refHz: v }).catch(() => {});
      }}
      showDebugOverlay={showDebugOverlay}
      setShowDebugOverlay={handleSetShowDebugOverlay}
      onOpenPipes={() => setPipesOpen(true)}
      onOpenRangeEditor={() => setRangeEditorOpen(true)}
      onEditHornName={() => { setHornNameDraft(engine.nickname); setHornNameEdit(true); }}
      droneVoice={droneVoice}
      setDroneVoice={setDroneVoice}
    />
  );

  return (
    <View style={styles.rootTabbed}>
      {/* Persistent header — TopBar + banners stay visible across all tabs
          (architecturally, they sit OUTSIDE the navigator). */}
      <View style={styles.faceplateHeader}>
        <TopBar
          status={engine.status}
          streamErrorReason={engine.streamErrorReason}
          refHz={refHz}
          setRefHz={(v) => {
            setRefHz(v);
            engine.savePrefsNow({ refHz: v }).catch(() => {});
          }}
          compact={!isLandscape}
          badgeText={badgeText}
          displayMode={displayMode}
          setDisplayMode={engine.setDisplayMode ?? (() => {})}
          onBadgePress={() => setPickerOpen(true)}
          onTablePress={() => setTableOpen(true)}
          onPipesPress={() => setPipesOpen(true)}
          hornName={engine.nickname}
        />
        {showSilenceBanner && (
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
      <NavigationContainer>
        <Tab.Navigator
          initialRouteName="tuner"
          screenOptions={{
            headerShown: false,
            sceneStyle: { backgroundColor: C.face, paddingHorizontal: 24 },
          }}
          tabBar={(p) => <NavTabBar {...p} />}
        >
          <Tab.Screen name="tuner">{renderTunerScreen}</Tab.Screen>
          <Tab.Screen name="metro">{renderMetroScreen}</Tab.Screen>
          <Tab.Screen name="deck">{renderDeckScreen}</Tab.Screen>
          <Tab.Screen name="setup">{renderSetupScreen}</Tab.Screen>
        </Tab.Navigator>
      </NavigationContainer>

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
 */
function NavTabBar(props: BottomTabBarProps) {
  const active = props.state.routes[props.state.index].name as TabKey;
  return (
    <TabBar
      active={active}
      onChange={(next) => {
        props.navigation.navigate(next as never);
      }}
    />
  );
}
