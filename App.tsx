/**
 * Intonation Analyzer — Android, chunk 4 of 5.
 *
 * Adds intonation table view, per-instrument range editor, refHz lifted to
 * prefs, allow-out-of-range display-layer filter, and min-N stepper.
 *
 * Visual language: Peterson-amber (#d6b86a), near-black faceplate, restrained
 * typography, generous letter-spacing. No new dependencies.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  DimensionValue,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { useAudioEngine } from './src/useAudioEngine';
import type { GainMode, DisplayMode, AudioEngineState } from './src/useAudioEngine';
import type { FilterMode } from './src/filterModes';
import { FAMILIES, transpMap, getInstrument, rangeMap } from './src/instruments';
import {
  centsDeviation,
  centsDisplayPrecision,
  midiToNoteName,
} from './src/music';
import { loadPrefs } from './src/storage/prefs';
import { loadRangeOverrides } from './src/storage/rangeOverrides';
import type { RangeOverride } from './src/storage/rangeOverrides';
import { IntonationTable } from './src/components/IntonationTable';
import { RangeEditor } from './src/components/RangeEditor';
import { PitchPipes } from './src/components/PitchPipes';
import * as AutoMicClaim from './modules/auto-mic-claim';
import type { CarConnectionState, CallState } from './modules/auto-mic-claim';

// v0.6.0 — consumed defensively so file compiles before Gandalf's PR merges.
type HiFiEngine = AudioEngineState & {
  hiFiMode: boolean;
  setHiFiMode: (v: boolean) => Promise<void>;
  hiFiActive: boolean;
  audioSourceLabel: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = 'INTONATION ANALYZER';
const APP_VERSION = '0.6.1';
const STAGE_LABEL = 'raw audio · unprocessed · 5 of 5';

// TENOR_TRANSPOSE has been removed. Transposition is now read from
// transpMap[engine.instrumentKey] at display time. Desktop convention:
// transp is NEGATIVE for instruments that sound below fingered pitch.
// To convert sounding MIDI to fingered: fingeredMidi = soundingMidi - transp
// e.g. Bb tenor transp = -14 → fingeredMidi = soundingMidi - (-14) = soundingMidi + 14.

const REF_HZ_MIN = 430;
const REF_HZ_MAX = 450;
const REF_HZ_DEFAULT = 440;

const CENT_TICK_COUNT = 21; // -50, -45, …, 0, …, +45, +50
const CENT_RANGE = 50;

const PEAK_DECAY_PER_SEC = 0.6;
const IDLE_GLOW = 0.02;

// dBFS scale endpoints for tick-position math (must match hook's 'low' map).
const METER_FLOOR_DB = -60;
const METER_CEIL_DB = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tickPct(db: number): number {
  const n = (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB);
  return Math.max(0, Math.min(100, n * 100));
}

function formatCents(cents: number, precision: 0.1 | 0.5 | 1.0): string {
  const sign = cents >= 0 ? '+' : '';
  if (precision === 0.1) return `${sign}${cents.toFixed(1)}`;
  if (precision === 0.5) return `${sign}${(Math.round(cents * 2) / 2).toFixed(1)}`;
  return `${sign}${Math.round(cents).toFixed(0)}`;
}

function centsToTickIndex(cents: number): number {
  const c = Math.max(-CENT_RANGE, Math.min(CENT_RANGE, cents));
  return Math.round(((c + CENT_RANGE) / (CENT_RANGE * 2)) * (CENT_TICK_COUNT - 1));
}

// ---------------------------------------------------------------------------
// Note display type
// ---------------------------------------------------------------------------

interface NoteDisplay {
  letter: string;
  accidental: '' | '#' | 'b';
  octave: number;
  cents: number;
  precision: 0.1 | 0.5 | 1.0;
  tickIndex: number;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const { width, height } = useWindowDimensions();
  const isLandscape = width >= height;

  const engine = useAudioEngine();
  const [refHz, setRefHz] = useState(REF_HZ_DEFAULT);
  const [refEdit, setRefEdit] = useState(false);

  // Instrument picker modal visibility.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Intonation table modal visibility.
  const [tableOpen, setTableOpen] = useState(false);

  // Range editor modal visibility.
  const [rangeEditorOpen, setRangeEditorOpen] = useState(false);

  // Pitch pipes modal visibility.
  const [pipesOpen, setPipesOpen] = useState(false);

  // Per-instrument range overrides (fingered MIDI).
  const [rangeOverrides, setRangeOverrides] = useState<Record<string, RangeOverride>>({});

  // Min-N threshold (persisted via savePrefsNow).
  const [minN, setMinN] = useState(5);

  // Android Auto mic-claim masquerade state.
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

  // Android Auto silence banner dismiss state. Clears automatically when
  // micSilenced transitions from false → true (new silence event).
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const prevSilenced = useRef(false);
  useEffect(() => {
    const silenced = engine.micSilenced ?? false;
    if (silenced && !prevSilenced.current) {
      // New silence event — reset dismiss so the banner re-appears.
      setBannerDismissed(false);
    }
    prevSilenced.current = silenced;
  }, [engine.micSilenced]);

  // Hydrate refHz from prefs on mount (once engine prefs are loaded).
  useEffect(() => {
    if (!engine.prefsLoaded) return;
    loadPrefs().then((p) => {
      setRefHz(p.refHz);
      setMinN(p.minNVisible);
    }).catch(() => {});
  // Run once after prefsLoaded flips — engine.prefsLoaded only goes false→true once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.prefsLoaded]);

  // Load range overrides on mount.
  useEffect(() => {
    loadRangeOverrides().then((overrides) => setRangeOverrides(overrides)).catch(() => {});
  }, []);

  // Persist refHz when app goes to background (backstop — engine also saves a4Hz).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') {
        engine.savePrefsNow({ refHz, minNVisible: minN }).catch(() => {});
      }
    });
    return () => sub.remove();
  // engine.savePrefsNow is stable; refHz and minN are primitive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refHz, minN]);

  // Persist minN change immediately so next aggregateNotes call picks it up.
  const handleMinNChange = useCallback((n: number) => {
    setMinN(n);
    engine.savePrefsNow({ minNVisible: n }).catch(() => {});
  }, [engine]);

  // Peak hold — updated synchronously during render, no useEffect needed.
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

  // Resolve current instrument transposition. transpMap values use the desktop
  // convention: negative = sounds below fingered. If the key isn't in the map
  // yet (Sauron hasn't wired it), fall back to 0 (sounding = fingered).
  const instrumentKey: string = engine.instrumentKey ?? 'bb_tenor';
  const transp: number = transpMap[instrumentKey] ?? 0;
  const displayMode: DisplayMode = engine.displayMode ?? 'griff';

  // Effective range for this instrument: override > baked default > null.
  const activeRange: [number, number] | null = useMemo(() => {
    const override = rangeOverrides[instrumentKey];
    if (override) return [override.lo, override.hi];
    const baked = rangeMap[instrumentKey];
    if (baked) return baked;
    return null;
  }, [rangeOverrides, instrumentKey]);

  // Compute note display from live freqHz.
  // soundingMidi is what YIN detected; if displayMode is 'griff' we apply
  // the transposition: fingeredMidi = soundingMidi - transp
  // (transp negative for Bb instruments → subtracting a negative adds).
  const noteDisplay = useMemo((): NoteDisplay | null => {
    if (engine.freqHz === null) return null;
    const { nearestMidi, cents } = centsDeviation(engine.freqHz, refHz);
    const displayedMidi = displayMode === 'klingend' ? nearestMidi : nearestMidi - transp;
    const { letter, accidental, octave } = midiToNoteName(displayedMidi);
    const precision = centsDisplayPrecision(engine.freqHz);
    return { letter, accidental, octave, cents, precision, tickIndex: centsToTickIndex(cents) };
  }, [engine.freqHz, refHz, displayMode, transp]);

  // Out-of-range detection: compare fingered MIDI against activeRange.
  const isOutOfRange: boolean = useMemo(() => {
    if (engine.allowOutOfRange) return false;
    if (engine.freqHz === null) return false;
    if (activeRange === null) return false;
    const { nearestMidi } = centsDeviation(engine.freqHz, refHz);
    // Convert sounding MIDI to fingered MIDI for range comparison.
    const midiFing = nearestMidi - transp;
    return midiFing < activeRange[0] || midiFing > activeRange[1];
  }, [engine.allowOutOfRange, engine.freqHz, refHz, transp, activeRange]);

  // Instrument English name for badge display.
  const instrumentDisplayName: string = (() => {
    const def = getInstrument(instrumentKey);
    if (def) return def.nameEn.toUpperCase();
    return instrumentKey.replace(/_/g, ' ').toUpperCase();
  })();
  const badgeText = `${instrumentDisplayName} · ${displayMode === 'griff' ? 'FINGERED' : 'SOUNDING'}`;

  const statusText = ((): string => {
    switch (engine.status) {
      case 'waiting-for-mic': return 'WAITING FOR MIC';
      case 'mic-denied':      return 'NO MIC';
      case 'warming-up':      return 'WARMING UP';
      case 'listening':       return 'LISTENING';
    }
  })();

  if (engine.status === 'mic-denied') {
    return <PermissionGate refHz={refHz} />;
  }

  const arcIndex = noteDisplay?.tickIndex ?? null;
  const isListening = engine.status === 'listening';
  const noteFontSize = isLandscape ? 180 : 150;
  const centerStyle = isLandscape ? styles.center : styles.centerPortrait;
  const showSilenceBanner = (engine.micSilenced ?? false) && !bannerDismissed;

  return (
    <View style={styles.root}>
      <View style={styles.faceplate}>
        <TopBar
          statusText={statusText}
          refHz={refHz}
          refEdit={refEdit}
          setRefHz={(v) => {
            setRefHz(v);
            engine.savePrefsNow({ refHz: v }).catch(() => {});
          }}
          setRefEdit={setRefEdit}
          compact={!isLandscape}
          badgeText={badgeText}
          displayMode={displayMode}
          setDisplayMode={engine.setDisplayMode ?? (() => {})}
          onBadgePress={() => setPickerOpen(true)}
          onGearPress={() => setRangeEditorOpen(true)}
          onTablePress={() => setTableOpen(true)}
          onPipesPress={() => setPipesOpen(true)}
        />
        {showSilenceBanner && (
          <SilenceBanner onDismiss={() => setBannerDismissed(true)} />
        )}
        {carState === 'connected' && (
          <TunerInCarSwitch
            callState={callState}
            onClaim={handleClaimMic}
            onRelease={() => AutoMicClaim.endTunerCallAsync().catch(() => {})}
          />
        )}
        <View style={centerStyle}>
          <CentArc activeIndex={arcIndex} cents={noteDisplay?.cents ?? null} arcWidth="100%" />
          <NoteReadout
            noteDisplay={noteDisplay}
            freqHz={engine.freqHz}
            noteFontSize={noteFontSize}
            isOutOfRange={isOutOfRange}
          />
        </View>
        <BottomStrip
          fillAnim={fillAnim}
          peakAnim={peakAnim}
          rmsDb={engine.rmsDb}
          isListening={isListening}
          gainMode={engine.gainMode}
          setGainMode={engine.setGainMode}
          filterMode={engine.filterMode ?? 'normal'}
          setFilterMode={engine.setFilterMode ?? (() => {})}
          hiFiMode={(engine as HiFiEngine).hiFiMode ?? false}
          setHiFiMode={(engine as HiFiEngine).setHiFiMode ?? (async () => {})}
          hiFiActive={(engine as HiFiEngine).hiFiActive ?? false}
          audioSourceLabel={(engine as HiFiEngine).audioSourceLabel ?? ''}
        />
        <DiagnosticLine
          rmsDb={engine.rmsDb}
          yinCallCount={engine.yinCallCount}
          rawFreqHz={engine.rawFreqHz}
        />
      </View>

      {/* Instrument picker modal */}
      <InstrumentPicker
        visible={pickerOpen}
        currentKey={instrumentKey}
        onSelect={(key) => {
          (engine.setInstrumentKey ?? (() => {}))(key);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />

      {/* Intonation table modal */}
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

      {/* Range editor modal */}
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

      {/* Pitch pipes modal */}
      <PitchPipes
        visible={pipesOpen}
        onClose={() => setPipesOpen(false)}
        refHz={refHz}
        instrumentKey={instrumentKey}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// SilenceBanner
// ---------------------------------------------------------------------------

function SilenceBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Pressable
      onPress={onDismiss}
      accessibilityRole="alert"
      accessibilityLabel="Microphone signal is silent. Tap to dismiss."
      style={styles.silenceBanner}
    >
      <Text style={styles.silenceBannerText}>
        <Text style={styles.silenceBannerBold}>Microphone signal is silent.</Text>
        {'  '}If Android Auto is connected, disconnect to free the mic for the tuner.
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// TunerInCarSwitch
// ---------------------------------------------------------------------------

// Visible only when carState === 'connected'. Replaces the two old buttons
// (CLAIM MIC and TUNER-IN-CAR ACTIVE) with a single always-present full-width
// ON/OFF pill. 48 pt touch target so it's usable while driving.
function TunerInCarSwitch({
  callState,
  onClaim,
  onRelease,
}: {
  callState: CallState;
  onClaim: () => void;
  onRelease: () => void;
}) {
  const isPending = callState === 'pending';
  const isActive  = callState === 'active';

  const handlePress = () => {
    if (isPending) return;
    if (isActive) {
      onRelease();
    } else {
      onClaim();
    }
  };

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="switch"
      accessibilityState={{ checked: isActive, disabled: isPending }}
      accessibilityLabel={
        isActive
          ? 'Tuner in car is ON and mic is claimed. Tap to release.'
          : isPending
          ? 'Tuner in car is starting.'
          : 'Tuner in car is OFF. Tap to claim mic.'
      }
      style={({ pressed }) => [
        styles.carSwitch,
        isActive && styles.carSwitchActive,
        isPending && styles.carSwitchPending,
        pressed && !isPending && styles.carSwitchPressed,
      ]}
    >
      <View style={styles.carSwitchInner}>
        <View style={[styles.carSwitchIndicator, isActive && styles.carSwitchIndicatorOn]} />
        <Text style={[styles.carSwitchLabel, isActive && styles.carSwitchLabelOn, isPending && styles.carSwitchLabelPending]}>
          {isActive
            ? 'TUNER IN CAR  ·  ON  ·  MIC CLAIMED  ·  TAP TO RELEASE'
            : isPending
            ? 'TUNER IN CAR  ·  STARTING…'
            : 'TUNER IN CAR  ·  OFF  ·  TAP TO CLAIM MIC'}
        </Text>
        <Text style={[styles.carSwitchState, isActive && styles.carSwitchStateOn]}>
          {isActive ? 'ON' : isPending ? '…' : 'OFF'}
        </Text>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// DiagnosticLine
// ---------------------------------------------------------------------------

// v0.2.1 — a quiet single-line readout that proves the engine is alive even
// when the centerpiece note slot is showing `—`.  Shows live RMS in dBFS, a
// monotonic counter of YIN calls (rolls every 1000), and the latest raw YIN
// frequency before smoothing.  If the counter is ticking, YIN is firing; if
// raw is non-null but the big note is `—`, the median filter or octave guard
// is consuming the result.
function DiagnosticLine({
  rmsDb,
  yinCallCount,
  rawFreqHz,
}: {
  rmsDb: number;
  yinCallCount: number;
  rawFreqHz: number | null;
}) {
  const rms = `${rmsDb.toFixed(0)} dB`;
  const yin = `YIN ${String(yinCallCount).padStart(3, '0')}`;
  const raw = rawFreqHz !== null ? `${rawFreqHz.toFixed(1)} Hz` : '— — —';
  return (
    <View style={styles.diag}>
      <Text style={styles.diagText}>{`${rms}  ·  ${yin}  ·  RAW ${raw}`}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

function TopBar({
  statusText, refHz, refEdit, setRefHz, setRefEdit, compact,
  badgeText, displayMode, setDisplayMode, onBadgePress, onGearPress, onTablePress, onPipesPress,
}: {
  statusText: string;
  refHz: number;
  refEdit: boolean;
  setRefHz: (v: number) => void;
  setRefEdit: (v: boolean) => void;
  compact: boolean;
  badgeText: string;
  displayMode: DisplayMode;
  setDisplayMode: (m: DisplayMode) => void;
  onBadgePress: () => void;
  onGearPress: () => void;
  onTablePress: () => void;
  onPipesPress: () => void;
}) {
  const bump = (d: number) =>
    setRefHz(Math.max(REF_HZ_MIN, Math.min(REF_HZ_MAX, refHz + d)));

  return (
    <View style={[styles.topBar, compact && styles.topBarCompact]}>
      <View style={styles.topLeft}>
        <Text style={compact ? styles.brandCompact : styles.brand}>{APP_NAME}</Text>
        <Text style={styles.brandVersion}>v{APP_VERSION}</Text>
        {/* Tappable instrument badge opens the instrument picker. */}
        <Pressable
          onPress={onBadgePress}
          accessibilityRole="button"
          accessibilityLabel={`Current instrument: ${badgeText}. Tap to change.`}
          style={({ pressed }) => [styles.badgePressable, pressed && styles.badgePressablePressed]}
        >
          <Text style={styles.instrumentBadge}>{badgeText}</Text>
        </Pressable>
        {/* Gear button opens the range editor for the current instrument. */}
        <Pressable
          onPress={onGearPress}
          accessibilityRole="button"
          accessibilityLabel="Edit instrument range"
          style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
        >
          <Text style={styles.iconBtnText}>{'⚙'}</Text>
        </Pressable>
        {/* TABLE button opens the intonation table. */}
        <Pressable
          onPress={onTablePress}
          accessibilityRole="button"
          accessibilityLabel="Open intonation table"
          style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
        >
          <Text style={styles.iconBtnText}>TABLE</Text>
        </Pressable>
        {/* PIPES button opens the pitch pipes. */}
        <Pressable
          onPress={onPipesPress}
          accessibilityRole="button"
          accessibilityLabel="Open pitch pipes"
          style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
        >
          <Text style={styles.iconBtnText}>PIPES</Text>
        </Pressable>
        {/* Sounding / Fingered display toggle — two-position pill pair. */}
        <View style={styles.displayToggle}>
          <Pressable
            onPress={() => setDisplayMode('griff')}
            accessibilityRole="button"
            accessibilityLabel="Show fingered pitch"
            style={({ pressed }) => [
              styles.displayPill,
              displayMode === 'griff' && styles.displayPillActive,
              pressed && styles.gainPillPressed,
            ]}
          >
            <Text style={[styles.displayPillText, displayMode === 'griff' && styles.displayPillTextActive]}>
              FINGERED
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setDisplayMode('klingend')}
            accessibilityRole="button"
            accessibilityLabel="Show sounding pitch"
            style={({ pressed }) => [
              styles.displayPill,
              displayMode === 'klingend' && styles.displayPillActive,
              pressed && styles.gainPillPressed,
            ]}
          >
            <Text style={[styles.displayPillText, displayMode === 'klingend' && styles.displayPillTextActive]}>
              SOUNDING
            </Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.topRight}>
        <Pressable
          onPress={() => setRefEdit(!refEdit)}
          accessibilityRole="button"
          accessibilityLabel={`Tuning reference A equals ${refHz} Hz, tap to adjust`}
          style={styles.refContainer}
        >
          <Text style={styles.refLabel}>REF</Text>
          <Text style={styles.refValue}>A = {refHz} Hz</Text>
        </Pressable>
        {refEdit && (
          <View style={styles.refStepper}>
            <Pressable
              onPress={() => bump(1)}
              accessibilityRole="button"
              accessibilityLabel="Increase reference by 1 Hz"
              style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
            >
              <Text style={styles.stepBtnText}>▲</Text>
            </Pressable>
            <Pressable
              onPress={() => bump(-1)}
              accessibilityRole="button"
              accessibilityLabel="Decrease reference by 1 Hz"
              style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
            >
              <Text style={styles.stepBtnText}>▼</Text>
            </Pressable>
          </View>
        )}
        <View style={styles.statusPill}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>{statusText}</Text>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// NoteReadout
// ---------------------------------------------------------------------------

function NoteReadout({
  noteDisplay, freqHz, noteFontSize, isOutOfRange,
}: {
  noteDisplay: NoteDisplay | null;
  freqHz: number | null;
  noteFontSize: number;
  isOutOfRange: boolean;
}) {
  const accSize = Math.round(noteFontSize * 0.44);
  const octSize = Math.round(noteFontSize * 0.16);
  const hasNote = noteDisplay !== null;
  // Dim the readout when out-of-range filtering is active and note is OOR.
  const oor = isOutOfRange && hasNote;

  const letter = noteDisplay?.letter ?? '—';
  const accidental = noteDisplay?.accidental ?? '';
  const octave = noteDisplay?.octave;
  const hzText = freqHz !== null ? freqHz.toFixed(1) : '— — —';
  const centsText = noteDisplay
    ? formatCents(noteDisplay.cents, noteDisplay.precision)
    : '+00';

  return (
    <View style={styles.noteBlock}>
      <View style={styles.noteRow}>
        <View style={styles.noteSlot}>
          <Text
            style={[
              styles.note,
              { fontSize: noteFontSize, lineHeight: noteFontSize + 4 },
              (!hasNote || oor) && styles.noteDim,
            ]}
          >
            {letter}
          </Text>
          {accidental !== '' ? (
            <Text style={[styles.accidental, { fontSize: accSize, lineHeight: accSize + 10, marginTop: Math.round(noteFontSize * 0.1) }, oor && styles.dimText]}>
              {accidental}
            </Text>
          ) : (
            <Text style={{ fontSize: accSize, opacity: 0 }}>{' '}</Text>
          )}
        </View>
        <Text style={[styles.octave, { fontSize: octSize, marginTop: Math.round(noteFontSize * 0.17), opacity: (hasNote && !oor) ? 1 : 0 }]}>
          {octave ?? ' '}
        </Text>
      </View>
      {/* Out-of-range pill replaces cent value row when OOR is active. */}
      {oor ? (
        <View style={styles.oorPill}>
          <Text style={styles.oorPillText}>OUT OF RANGE</Text>
        </View>
      ) : (
        <>
          <View style={styles.hzRow}>
            <Text style={[styles.hzValue, !hasNote && styles.dimText]}>{hzText}</Text>
            <Text style={styles.hzUnit}>Hz</Text>
          </View>
          <View style={styles.centValueRow}>
            <Text style={styles.centValueLabel}>CENTS</Text>
            <Text style={[styles.centValue, !hasNote && styles.dimText]}>{centsText}</Text>
          </View>
        </>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// CentArc
// ---------------------------------------------------------------------------

function CentArc({
  activeIndex, cents, arcWidth,
}: {
  activeIndex: number | null;
  // v0.2.3 — continuous cents value drives the needle position so it doesn't
  // snap to 5¢ tick boundaries.  activeIndex still drives the discrete tick
  // highlight (which has to land on an integer index).
  cents: number | null;
  arcWidth: DimensionValue;
}) {
  const ticks = useMemo(() => {
    const arr: { major: boolean; center: boolean }[] = [];
    for (let i = 0; i < CENT_TICK_COUNT; i++) {
      const c = -CENT_RANGE + (i * CENT_RANGE * 2) / (CENT_TICK_COUNT - 1);
      const center = Math.abs(c) < 0.001;
      const major = center || c === -CENT_RANGE || c === CENT_RANGE;
      arr.push({ major, center });
    }
    return arr;
  }, []);

  const needleIdx = activeIndex ?? Math.floor(CENT_TICK_COUNT / 2);
  const needleActive = activeIndex !== null;

  // v0.2.3 — animated needle position.  The raw cents value (∈ [-50, +50])
  // is mapped to a percentage and driven into an Animated.Value with a tight
  // spring.  When no pitch is detected we glide back to center rather than
  // snapping.
  const targetPct = useMemo(() => {
    const clamped = Math.max(-CENT_RANGE, Math.min(CENT_RANGE, cents ?? 0));
    return ((clamped + CENT_RANGE) / (CENT_RANGE * 2)) * 100;
  }, [cents]);
  const needleAnim = useRef(new Animated.Value(50)).current;
  useEffect(() => {
    Animated.spring(needleAnim, {
      toValue: targetPct,
      useNativeDriver: false,
      damping: 12,
      stiffness: 280,
      mass: 0.2,
    }).start();
  }, [targetPct, needleAnim]);

  return (
    <View style={[styles.arc, { width: arcWidth }]}>
      <View style={styles.arcScaleRow}>
        <Text style={styles.arcEnd}>-50</Text>
        <Text style={styles.arcEnd}>-25</Text>
        <Text style={styles.arcCenterLabel}>0</Text>
        <Text style={styles.arcEnd}>+25</Text>
        <Text style={styles.arcEnd}>+50</Text>
      </View>
      <View style={styles.arcTrack}>
        {ticks.map((t, i) => (
          <View
            key={i}
            style={[
              styles.arcTick,
              t.major && styles.arcTickMajor,
              t.center && styles.arcTickCenter,
              i === needleIdx && needleActive && styles.arcTickActive,
            ]}
          />
        ))}
        <Animated.View
          style={[
            styles.arcNeedle,
            {
              left: needleAnim.interpolate({
                inputRange: [0, 100],
                outputRange: ['0%', '100%'],
              }),
              opacity: needleActive ? 1 : 0.35,
            },
          ]}
        />
      </View>
      <View style={styles.arcZones}>
        <View style={[styles.arcZone, styles.arcZoneFlat]} />
        <View style={[styles.arcZone, styles.arcZoneInTune]} />
        <View style={[styles.arcZone, styles.arcZoneSharp]} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// BottomStrip
// ---------------------------------------------------------------------------

const GAIN_OPTIONS: { value: GainMode; label: string }[] = [
  { value: 'low', label: 'LOW' },
  { value: 'high', label: 'HIGH' },
];

// Filter mode options with short tooltip copy sourced from docs/response-modes.md.
const FILTER_OPTIONS: { value: FilterMode; label: string; hint: string }[] = [
  { value: 'fast',   label: 'FAST',   hint: 'Live play, scale drills (~140 ms)' },
  { value: 'normal', label: 'NORMAL', hint: 'Practice, tuning long tones (~230 ms)' },
  { value: 'slow',   label: 'SLOW',   hint: 'Setup, instrument repair (~460 ms)' },
];

function BottomStrip({
  fillAnim, peakAnim, rmsDb, isListening, gainMode, setGainMode,
  filterMode, setFilterMode,
  hiFiMode, setHiFiMode, hiFiActive, audioSourceLabel,
}: {
  fillAnim: Animated.Value;
  peakAnim: Animated.Value;
  rmsDb: number;
  isListening: boolean;
  gainMode: GainMode;
  setGainMode: (m: GainMode) => void;
  filterMode: FilterMode;
  setFilterMode: (m: FilterMode) => void;
  hiFiMode: boolean;
  setHiFiMode: (v: boolean) => Promise<void>;
  hiFiActive: boolean;
  audioSourceLabel: string;
}) {
  // hiFiMode ON but device can't deliver it.
  const hiFiFallback = hiFiMode && !hiFiActive;

  return (
    <View style={styles.bottom}>
      <View style={styles.bottomLeft}>
        {/* Controls row: gain + response + hi-fi. flexWrap drops HI-FI to a new row in portrait. */}
        <View style={styles.controlsRow}>
          <View style={styles.gainBlock}>
            <Text style={styles.bottomLabel}>GAIN</Text>
            <View style={styles.gainToggle}>
              {GAIN_OPTIONS.map(({ value, label }) => (
                <Pressable
                  key={value}
                  onPress={() => setGainMode(value)}
                  accessibilityRole="button"
                  accessibilityLabel={`Set gain to ${label.toLowerCase()}`}
                  style={({ pressed }) => [
                    styles.gainPill,
                    gainMode === value && styles.gainPillActive,
                    pressed && styles.gainPillPressed,
                  ]}
                >
                  <Text style={[styles.gainPillText, gainMode === value && styles.gainPillTextActive]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={styles.filterBlock}>
            <Text style={styles.bottomLabel}>RESPONSE</Text>
            <View style={styles.filterToggle}>
              {FILTER_OPTIONS.map(({ value, label, hint }) => (
                <Pressable
                  key={value}
                  onPress={() => setFilterMode(value)}
                  accessibilityRole="button"
                  accessibilityLabel={`Set response to ${label.toLowerCase()}: ${hint}`}
                  style={({ pressed }) => [
                    styles.filterPill,
                    filterMode === value && styles.filterPillActive,
                    pressed && styles.gainPillPressed,
                  ]}
                >
                  <Text style={[styles.filterPillText, filterMode === value && styles.filterPillTextActive]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          {/* HI-FI toggle */}
          <View style={styles.hiFiBlock}>
            <Text style={styles.bottomLabel}>HI-FI</Text>
            <View style={styles.gainToggle}>
              <Pressable
                onPress={() => { setHiFiMode(true).catch(() => {}); }}
                accessibilityRole="button"
                accessibilityLabel="Enable hi-fi audio capture"
                style={({ pressed }) => [
                  styles.gainPill,
                  hiFiMode && styles.gainPillActive,
                  pressed && styles.gainPillPressed,
                ]}
              >
                <Text style={[styles.gainPillText, hiFiMode && styles.gainPillTextActive]}>
                  ON
                </Text>
              </Pressable>
              <Pressable
                onPress={() => { setHiFiMode(false).catch(() => {}); }}
                accessibilityRole="button"
                accessibilityLabel="Disable hi-fi audio capture"
                style={({ pressed }) => [
                  styles.gainPill,
                  !hiFiMode && styles.gainPillActive,
                  pressed && styles.gainPillPressed,
                ]}
              >
                <Text style={[styles.gainPillText, !hiFiMode && styles.gainPillTextActive]}>
                  OFF
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
        {audioSourceLabel.length > 0 && (
          <Text style={styles.audioSourceLabel}>{audioSourceLabel}</Text>
        )}
        {hiFiFallback && (
          <Text style={styles.hiFiFallbackText}>Device does not support UNPROCESSED capture — using fallback</Text>
        )}
        {/* Meter */}
        <Text style={[styles.bottomLabel, styles.meterLabel]}>INPUT</Text>
        <View style={styles.meterTrack}>
          <Animated.View
            style={[styles.meterFill, { width: fillAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}
          />
          <Animated.View
            style={[styles.peakMark, { left: peakAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}
          />
          <View style={[styles.meterTick, { left: `${tickPct(-40)}%` }]} />
          <View style={[styles.meterTick, { left: `${tickPct(-20)}%` }]} />
          <View style={[styles.meterTickHot, { left: `${tickPct(-6)}%` }]} />
        </View>
        <View style={styles.meterScale}>
          <Text style={styles.meterScaleTick}>-60</Text>
          <Text style={styles.meterScaleTick}>-40</Text>
          <Text style={styles.meterScaleTick}>-20</Text>
          <Text style={[styles.meterScaleTick, styles.meterScaleTickHot]}>-6 dB</Text>
        </View>
      </View>
      <View style={styles.bottomRight}>
        <Text style={styles.dbValue}>
          {isListening ? `${rmsDb.toFixed(0)}` : '--'}
          <Text style={styles.dbUnit}> dBFS</Text>
        </Text>
        <Text style={styles.stage}>{STAGE_LABEL}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// InstrumentPicker
// ---------------------------------------------------------------------------

function InstrumentPicker({
  visible, currentKey, onSelect, onClose,
}: {
  visible: boolean;
  currentKey: string;
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Semi-transparent backdrop — tap outside sheet to dismiss. */}
      <Pressable style={styles.pickerBackdrop} onPress={onClose} accessibilityLabel="Close instrument picker">
        {/* The inner sheet stops propagation so tapping inside doesn't close. */}
        <Pressable style={styles.pickerSheet} onPress={() => {}}>
          <View style={styles.pickerHeader}>
            <Text style={styles.pickerTitle}>SELECT INSTRUMENT</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={({ pressed }) => [styles.pickerClose, pressed && styles.stepBtnPressed]}
            >
              <Text style={styles.pickerCloseText}>✕</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.pickerScroll} showsVerticalScrollIndicator={false}>
            {FAMILIES.map((family) => (
              <View key={family.key} style={styles.pickerFamily}>
                <Text style={styles.pickerFamilyLabel}>{family.nameEn.toUpperCase()}</Text>
                {family.instruments.map((instKey) => {
                  const inst = getInstrument(instKey);
                  if (!inst) return null;
                  const isSelected = instKey === currentKey;
                  return (
                    <Pressable
                      key={instKey}
                      onPress={() => onSelect(instKey)}
                      accessibilityRole="menuitem"
                      accessibilityLabel={inst.nameEn}
                      accessibilityState={{ selected: isSelected }}
                      style={({ pressed }) => [
                        styles.pickerRow,
                        isSelected && styles.pickerRowSelected,
                        pressed && styles.pickerRowPressed,
                      ]}
                    >
                      <Text style={[styles.pickerRowText, isSelected && styles.pickerRowTextSelected]}>
                        {inst.nameEn}
                      </Text>
                      {isSelected && <Text style={styles.pickerRowCheck}>●</Text>}
                    </Pressable>
                  );
                })}
              </View>
            ))}
            {/* Bottom padding so the last row isn't flush against the sheet edge. */}
            <View style={{ height: 24 }} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// PermissionGate
// ---------------------------------------------------------------------------

function PermissionGate({ refHz }: { refHz: number }) {
  return (
    <View style={styles.root}>
      <View style={styles.faceplate}>
        <View style={styles.topBar}>
          <View style={styles.topLeft}>
            <Text style={styles.brand}>{APP_NAME}</Text>
            <Text style={styles.brandVersion}>v{APP_VERSION}</Text>
            <Text style={styles.instrumentBadge}>Bb TENOR · FINGERED</Text>
          </View>
          <View style={styles.topRight}>
            <Text style={styles.refLabel}>REF</Text>
            <Text style={styles.refValue}>A = {refHz} Hz</Text>
            <View style={styles.statusPill}>
              <View style={styles.statusDot} />
              <Text style={styles.statusText}>NO MIC</Text>
            </View>
          </View>
        </View>
        <View style={styles.gate}>
          <Text style={styles.gateTitle}>MICROPHONE REQUIRED</Text>
          <Text style={styles.gateBody}>
            The tuner reads your horn through the microphone. Audio is
            processed on-device and never leaves the device.
          </Text>
          {/* The hook manages the permission request lifecycle internally.
              Users who deny must go to system Settings to re-enable. */}
          <Text style={styles.gateHint}>
            Open Settings and allow microphone access, then relaunch the app.
          </Text>
        </View>
        <View style={styles.gateFooter}>
          <Text style={styles.stage}>{STAGE_LABEL}</Text>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = {
  bg: '#07080b',
  face: '#0e1116',
  edge: '#1e242e',
  edgeSoft: '#161b22',
  ink: '#f0f1f3',
  inkMid: '#a6acb6',
  inkDim: '#5a626d',
  inkVeryDim: '#3a4049',
  accent: '#d6b86a',
  inTune: '#5fb87a',
  flat: '#5b8fb8',
  sharp: '#b8635f',
  // Amber warning tint for the silence banner — derived from accent, darkened
  // to avoid visual parity with active state.
  warnBg: '#2a1f08',
  warnBorder: '#6b5020',
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, padding: 16 },
  faceplate: {
    flex: 1,
    backgroundColor: C.face,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 28,
    paddingVertical: 18,
  },

  // Top bar
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomColor: C.edgeSoft,
    borderBottomWidth: 1,
    paddingBottom: 12,
  },
  topBarCompact: { paddingBottom: 8 },
  topLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  topRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0,
  },
  brand: { color: C.ink, fontSize: 14, letterSpacing: 6, fontWeight: '600' },
  brandCompact: { color: C.ink, fontSize: 11, letterSpacing: 4, fontWeight: '600' },
  brandVersion: { color: C.inkDim, fontSize: 10, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  // Instrument badge — tappable, so wrapped in its own pressable.
  instrumentBadge: { color: C.accent, fontSize: 9, letterSpacing: 2, opacity: 0.8 },
  badgePressable: {
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 2,
    minHeight: 28,
    justifyContent: 'center',
  },
  badgePressablePressed: { backgroundColor: C.edge },

  // Sounding / Fingered display toggle (two pills, lives in topLeft).
  displayToggle: { flexDirection: 'row', gap: 2 },
  displayPill: {
    minWidth: 44,
    height: 26,
    paddingHorizontal: 8,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  displayPillActive: { backgroundColor: C.accent, borderColor: C.accent },
  displayPillText: { color: C.inkDim, fontSize: 8, letterSpacing: 2, fontWeight: '600' },
  displayPillTextActive: { color: C.bg },

  refContainer: { flexDirection: 'row', alignItems: 'baseline', gap: 6, paddingVertical: 4, paddingHorizontal: 6 },
  refLabel: { color: C.inkDim, fontSize: 10, letterSpacing: 3 },
  refValue: { color: C.inkMid, fontSize: 12, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  refStepper: { flexDirection: 'column', gap: 2 },
  stepBtn: {
    width: 32,
    height: 22,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnPressed: { backgroundColor: C.edge },
  stepBtnText: { color: C.accent, fontSize: 10, lineHeight: 12 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 2,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.accent },
  statusText: { color: C.inkMid, fontSize: 10, letterSpacing: 3 },

  // TunerInCarSwitch — full-width pill, 48 pt+ touch target.
  carSwitch: {
    marginTop: 8,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: C.warnBg,
    borderColor: C.accent,
    borderWidth: 1,
    borderRadius: 3,
  },
  carSwitchActive: {
    backgroundColor: '#0a1f0a',
    borderColor: C.inTune,
  },
  carSwitchPending: {
    borderColor: C.inkDim,
    backgroundColor: C.bg,
  },
  carSwitchPressed: { opacity: 0.75 },
  carSwitchInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  carSwitchIndicator: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: C.accent,
    opacity: 0.6,
  },
  carSwitchIndicatorOn: {
    backgroundColor: C.inTune,
    opacity: 1,
  },
  carSwitchLabel: {
    flex: 1,
    color: C.accent,
    fontSize: 11,
    letterSpacing: 2.5,
    fontWeight: '700',
  },
  carSwitchLabelOn: { color: C.inTune },
  carSwitchLabelPending: { color: C.inkDim },
  carSwitchState: {
    color: C.accent,
    fontSize: 13,
    letterSpacing: 2,
    fontWeight: '700',
    minWidth: 28,
    textAlign: 'right',
  },
  carSwitchStateOn: { color: C.inTune },

  // Silence banner — below TopBar, above center region.
  silenceBanner: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: C.warnBg,
    borderColor: C.warnBorder,
    borderWidth: 1,
    borderRadius: 2,
  },
  silenceBannerText: { color: C.accent, fontSize: 11, lineHeight: 16, letterSpacing: 0.5 },
  silenceBannerBold: { fontWeight: '700' },

  // Center regions
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
  centerPortrait: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },

  // Cent arc
  arc: { maxWidth: 720, alignSelf: 'center' },
  arcScaleRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  arcEnd: { color: C.inkDim, fontSize: 11, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  arcCenterLabel: { color: C.inkMid, fontSize: 11, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  arcTrack: {
    height: 38,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    position: 'relative',
  },
  arcTick: { width: 1, height: 10, backgroundColor: C.inkVeryDim },
  arcTickMajor: { height: 18, backgroundColor: C.inkDim },
  arcTickCenter: { width: 2, height: 26, backgroundColor: C.inkMid },
  arcTickActive: { backgroundColor: C.accent },
  arcNeedle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    marginLeft: -1,
    backgroundColor: C.accent,
  },
  arcZones: { flexDirection: 'row', marginTop: 4, height: 2 },
  arcZone: { height: 2 },
  arcZoneFlat: { flex: 35, backgroundColor: C.flat, opacity: 0.35 },
  arcZoneInTune: { flex: 30, backgroundColor: C.inTune, opacity: 0.5 },
  arcZoneSharp: { flex: 35, backgroundColor: C.sharp, opacity: 0.35 },

  // Note readout
  noteBlock: { alignItems: 'center', marginTop: 12 },
  noteRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center' },
  noteSlot: { flexDirection: 'row', alignItems: 'flex-start' },
  note: { color: C.ink, fontWeight: '300', letterSpacing: -2, fontVariant: ['tabular-nums'] },
  noteDim: { color: C.inkDim },
  accidental: { color: C.inkMid, fontWeight: '300' },
  octave: { color: C.inkDim, fontVariant: ['tabular-nums'], marginLeft: 10, letterSpacing: 1 },
  hzRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: -8 },
  hzValue: { color: C.inkMid, fontSize: 22, letterSpacing: 4, fontVariant: ['tabular-nums'] },
  hzUnit: { color: C.inkDim, fontSize: 12, letterSpacing: 3 },
  centValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 10 },
  centValueLabel: { color: C.inkDim, fontSize: 10, letterSpacing: 3 },
  centValue: { color: C.inkMid, fontSize: 14, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  dimText: { color: C.inkVeryDim },

  // Bottom strip
  bottom: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 24,
    borderTopColor: C.edgeSoft,
    borderTopWidth: 1,
    paddingTop: 12,
  },
  bottomLeft: { flex: 1 },
  // Controls row holds gain + filter mode + hi-fi side by side; wraps in portrait.
  controlsRow: { flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap', gap: 20, marginBottom: 4 },
  gainBlock: { flexDirection: 'column', gap: 4 },
  filterBlock: { flexDirection: 'column', gap: 4 },
  hiFiBlock: { flexDirection: 'column', gap: 4 },
  gainToggle: { flexDirection: 'row', gap: 4 },
  filterToggle: { flexDirection: 'row', gap: 4 },
  gainPill: {
    minWidth: 44,
    height: 28,
    paddingHorizontal: 10,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gainPillActive: { backgroundColor: C.accent, borderColor: C.accent },
  gainPillPressed: { opacity: 0.7 },
  gainPillText: { color: C.inkDim, fontSize: 10, letterSpacing: 2, fontWeight: '600' },
  gainPillTextActive: { color: C.bg },
  filterPill: {
    minWidth: 54,
    height: 28,
    paddingHorizontal: 10,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterPillActive: { backgroundColor: C.accent, borderColor: C.accent },
  filterPillText: { color: C.inkDim, fontSize: 10, letterSpacing: 2, fontWeight: '600' },
  filterPillTextActive: { color: C.bg },
  bottomLabel: { color: C.inkDim, fontSize: 10, letterSpacing: 3, marginBottom: 2 },
  meterLabel: { marginTop: 8 },
  meterTrack: {
    height: 10,
    backgroundColor: C.bg,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  meterFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: C.accent, opacity: 0.85 },
  peakMark: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: C.ink },
  meterTick: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: C.edge },
  meterTickHot: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: C.accent, opacity: 0.6 },
  meterScale: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  meterScaleTick: { color: C.inkDim, fontSize: 9, letterSpacing: 1, fontVariant: ['tabular-nums'] },
  meterScaleTickHot: { color: C.accent },
  bottomRight: { alignItems: 'flex-end', minWidth: 120 },
  dbValue: { color: C.inkMid, fontSize: 18, letterSpacing: 1, fontVariant: ['tabular-nums'] },
  dbUnit: { color: C.inkDim, fontSize: 11, letterSpacing: 2 },
  stage: { color: C.inkDim, fontSize: 10, letterSpacing: 2, marginTop: 4 },
  diag: { alignItems: 'center', marginTop: 6, paddingTop: 6, borderTopColor: C.edge, borderTopWidth: 1 },
  diagText: { color: C.inkDim, fontSize: 9, letterSpacing: 2, fontVariant: ['tabular-nums'] },

  // Instrument picker modal
  pickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: C.face,
    borderTopColor: C.edge,
    borderTopWidth: 1,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    maxHeight: '75%',
    paddingBottom: 0,
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomColor: C.edgeSoft,
    borderBottomWidth: 1,
  },
  pickerTitle: { color: C.ink, fontSize: 12, letterSpacing: 4, fontWeight: '600' },
  pickerClose: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 2,
  },
  pickerCloseText: { color: C.inkMid, fontSize: 13 },
  pickerScroll: { paddingHorizontal: 20 },
  pickerFamily: { marginTop: 16 },
  pickerFamilyLabel: {
    color: C.inkDim,
    fontSize: 9,
    letterSpacing: 3,
    marginBottom: 4,
    paddingBottom: 4,
    borderBottomColor: C.edgeSoft,
    borderBottomWidth: 1,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 2,
    minHeight: 44,
  },
  pickerRowSelected: { backgroundColor: C.edgeSoft },
  pickerRowPressed: { backgroundColor: C.edge },
  pickerRowText: { color: C.inkMid, fontSize: 13, letterSpacing: 1 },
  pickerRowTextSelected: { color: C.accent, fontWeight: '600' },
  pickerRowCheck: { color: C.accent, fontSize: 10 },

  // Permission gate
  gate: { flex: 1, paddingVertical: 32, alignItems: 'center', justifyContent: 'center' },
  gateTitle: { color: C.ink, fontSize: 16, letterSpacing: 4, marginBottom: 16 },
  gateBody: { color: C.inkMid, fontSize: 14, lineHeight: 22, textAlign: 'center', maxWidth: 480, marginBottom: 16 },
  gateHint: { color: C.inkDim, fontSize: 12, lineHeight: 18, textAlign: 'center', maxWidth: 480, letterSpacing: 1 },
  gateFooter: { alignItems: 'flex-end', borderTopColor: C.edgeSoft, borderTopWidth: 1, paddingTop: 12 },

  // Out-of-range pill (replaces cent value row in NoteReadout).
  oorPill: {
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderColor: C.warnBorder,
    borderWidth: 1,
    borderRadius: 2,
    backgroundColor: C.warnBg,
  },
  oorPillText: { color: C.accent, fontSize: 9, letterSpacing: 3, fontWeight: '600' },

  // Gear / TABLE icon buttons in TopBar (same slot as badge area).
  iconBtn: {
    height: 28,
    paddingHorizontal: 8,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnPressed: { backgroundColor: C.edge },
  iconBtnText: { color: C.inkDim, fontSize: 10, letterSpacing: 2 },

  // HI-FI source label — sits below controls row, above the diagnostic line.
  audioSourceLabel: { color: C.inkVeryDim, fontSize: 9, letterSpacing: 2, marginTop: 2, marginBottom: 2, fontVariant: ['tabular-nums'] },
  // HI-FI fallback notice — amber tone, matches silence-banner palette.
  hiFiFallbackText: { color: C.accent, fontSize: 9, letterSpacing: 1, opacity: 0.75, marginTop: 1, marginBottom: 2 },
});
