/**
 * tunerWidgets.tsx — shared UI components used by the TUNER tab and the
 * PermissionGate. Extracted out of App.tsx during the four-tab refactor so
 * each screen can compose its own layout from the same primitives.
 *
 * Includes:
 *   - SilenceBanner          — appears above the readout when the mic stream is silent.
 *   - TunerInCarSwitch       — Android Auto mic-claim pill.
 *   - DiagnosticLine         — debug overlay (RMS / YIN counter / raw freq).
 *   - TopBar                 — brand row + instrument badge + A4 + PAGE/CONCERT + TABLE/PIPES.
 *   - NoteReadout            — big note letter + cents + Hz.
 *   - CentArc                — animated tick scale needle.
 *   - BottomStrip            — INPUT meter + dBFS readout.
 *   - InstrumentPicker       — modal instrument family / instrument selector.
 *   - PeakSlideToggle        — LIVE / COLLECT slider switch.
 *   - TapToLogCta            — primary tap-to-log bar + 6s UNDO.
 *   - BucketStatsCard        — COLLECT mode stats display.
 *   - SessionStrip           — session start / end controls.
 *   - HornNameEditor         — modal text input for nickname.
 *   - PermissionGate         — full-screen mic-permission / stream-failed UI.
 *
 * All components consume the live theme via `useTheme()` and the StyleSheet
 * built by `makeStyles` in `uiShared.tsx`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  DimensionValue,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useTheme } from './theme';
import {
  makeStyles,
  PEAK_PAD,
  PEAK_TRAVEL,
  REF_HZ_MIN,
  REF_HZ_MAX,
  CENT_TICK_COUNT,
  CENT_RANGE,
  METER_FLOOR_DB,
  METER_CEIL_DB,
} from './uiShared';
import type { EngineStatus, DisplayMode, GainMode, BucketStats, LogResult } from './useAudioEngine';
import type { FilterMode } from './filterModes';
import { FAMILIES, getInstrument } from './instruments';
import { midiToNoteName, centsDisplayPrecision } from './music';
import type { CallState } from '../modules/auto-mic-claim';

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

export const APP_NAME = 'BELLCURVE';

export function tickPct(db: number): number {
  const n = (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB);
  return Math.max(0, Math.min(100, n * 100));
}

export function formatCents(cents: number, precision: 0.1 | 0.5 | 1.0): string {
  const sign = cents >= 0 ? '+' : '';
  if (precision === 0.1) return `${sign}${cents.toFixed(1)}`;
  if (precision === 0.5) return `${sign}${(Math.round(cents * 2) / 2).toFixed(1)}`;
  return `${sign}${Math.round(cents).toFixed(0)}`;
}

export function centsToTickIndex(cents: number): number {
  const c = Math.max(-CENT_RANGE, Math.min(CENT_RANGE, cents));
  return Math.round(((c + CENT_RANGE) / (CENT_RANGE * 2)) * (CENT_TICK_COUNT - 1));
}

function formatCentsForLog(c: number): string {
  const sign = c >= 0 ? '+' : '';
  return `${sign}${c.toFixed(1)}`;
}

export interface NoteDisplay {
  letter: string;
  accidental: '' | '#' | 'b';
  octave: number;
  cents: number;
  precision: 0.1 | 0.5 | 1.0;
  tickIndex: number;
}

// Helper used by TunerScreen and PermissionGate alike.
export function describeCents(c: number) {
  return centsDisplayPrecision(c);
}

// ---------------------------------------------------------------------------
// SilenceBanner
// ---------------------------------------------------------------------------

export function SilenceBanner({ onDismiss }: { onDismiss: () => void }) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
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

export function TunerInCarSwitch({
  callState, onClaim, onRelease,
}: {
  callState: CallState;
  onClaim: () => void;
  onRelease: () => void;
}) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  const isPending = callState === 'pending';
  const isActive  = callState === 'active';

  const handlePress = () => {
    if (isPending) return;
    if (isActive) onRelease(); else onClaim();
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

export function DiagnosticLine({
  rmsDb, yinCallCount, rawFreqHz,
}: {
  rmsDb: number;
  yinCallCount: number;
  rawFreqHz: number | null;
}) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
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
// TopBar — tab-aware. Without a gear icon (SETUP is its own tab now).
// ---------------------------------------------------------------------------

export function TopBar({
  status, streamErrorReason, refHz, setRefHz, compact,
  badgeText, displayMode, setDisplayMode, onBadgePress, onTablePress, onPipesPress,
  hornName,
}: {
  status: EngineStatus;
  streamErrorReason: string | null;
  refHz: number;
  setRefHz: (v: number) => void;
  compact: boolean;
  badgeText: string;
  displayMode: DisplayMode;
  setDisplayMode: (m: DisplayMode) => void;
  onBadgePress: () => void;
  onTablePress: () => void;
  onPipesPress: () => void;
  hornName: string;
}) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  void compact;

  const bump = (d: number) =>
    setRefHz(Math.max(REF_HZ_MIN, Math.min(REF_HZ_MAX, refHz + d)));

  const statusColor =
    status === 'listening'   ? C.inTune :
    status === 'warming-up'  ? C.accent :
                               C.sharp;
  const statusLabel =
    status === 'listening'   ? null :
    status === 'warming-up'  ? 'WARMING UP' :
    status === 'mic-denied'  ? 'NO MIC' :
    status === 'stream-failed' ? 'NO AUDIO' :
                                'WAITING FOR MIC';

  return (
    <View style={styles.topBar}>
      <Text style={styles.brand} numberOfLines={1}>{APP_NAME}</Text>

      <View style={styles.topRow2}>
        <Pressable
          onPress={onBadgePress}
          accessibilityRole="button"
          accessibilityLabel={
            hornName.length > 0
              ? `Current instrument: ${badgeText}. Horn: ${hornName}. Tap to change.`
              : `Current instrument: ${badgeText}. Tap to change.`
          }
          style={({ pressed }) => [styles.badgePressable, pressed && styles.badgePressablePressed]}
        >
          <Text style={styles.instrumentBadge} numberOfLines={1}>{badgeText}</Text>
          {hornName.length > 0 && (
            <Text style={styles.hornNameCaption} numberOfLines={1}>{hornName}</Text>
          )}
        </Pressable>

        <View style={styles.refContainer}>
          <Pressable
            onPress={() => bump(-1)}
            accessibilityRole="button"
            accessibilityLabel="Decrease reference by 1 Hz"
            style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
          >
            <Text style={styles.stepBtnText}>−</Text>
          </Pressable>
          <Text style={styles.refValue}>A={refHz}</Text>
          <Pressable
            onPress={() => bump(1)}
            accessibilityRole="button"
            accessibilityLabel="Increase reference by 1 Hz"
            style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
          >
            <Text style={styles.stepBtnText}>+</Text>
          </Pressable>
        </View>

        <View style={styles.displayToggle}>
          <Pressable
            onPress={() => setDisplayMode('griff')}
            accessibilityRole="button"
            accessibilityLabel="Show the note as written on the page (fingered pitch)"
            accessibilityState={{ selected: displayMode === 'griff' }}
            style={({ pressed }) => [
              styles.displayPill,
              displayMode === 'griff' && styles.displayPillActive,
              pressed && styles.gainPillPressed,
            ]}
          >
            <Text style={[styles.displayPillText, displayMode === 'griff' && styles.displayPillTextActive]}>PAGE</Text>
          </Pressable>
          <Pressable
            onPress={() => setDisplayMode('klingend')}
            accessibilityRole="button"
            accessibilityLabel="Show the concert pitch — what comes out of the horn"
            accessibilityState={{ selected: displayMode === 'klingend' }}
            style={({ pressed }) => [
              styles.displayPill,
              displayMode === 'klingend' && styles.displayPillActive,
              pressed && styles.gainPillPressed,
            ]}
          >
            <Text style={[styles.displayPillText, displayMode === 'klingend' && styles.displayPillTextActive]}>CONCERT</Text>
          </Pressable>
        </View>

        <View
          style={[styles.statusDotLarge, { backgroundColor: statusColor }]}
          accessibilityRole="image"
          accessibilityLabel={`Status: ${statusLabel ?? 'listening'}`}
        />
      </View>

      {statusLabel !== null && (
        <Text style={styles.statusCaption} numberOfLines={1}>
          {statusLabel}{streamErrorReason !== null ? ` — ${streamErrorReason.slice(0, 40)}` : ''}
        </Text>
      )}

      {/* TABLE + PIPES row. The gear icon is gone — SETUP is the bottom tab. */}
      <View style={styles.topNavRow}>
        <Pressable
          onPress={onTablePress}
          accessibilityRole="button"
          accessibilityLabel="Open intonation table"
          style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
        >
          <Text style={styles.iconBtnText}>TABLE</Text>
        </Pressable>
        <Pressable
          onPress={onPipesPress}
          accessibilityRole="button"
          accessibilityLabel="Open pitch pipes"
          style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
        >
          <Text style={styles.iconBtnText}>PIPES</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// NoteReadout
// ---------------------------------------------------------------------------

export function NoteReadout({
  noteDisplay, freqHz, noteFontSize, isOutOfRange,
}: {
  noteDisplay: NoteDisplay | null;
  freqHz: number | null;
  noteFontSize: number;
  isOutOfRange: boolean;
}) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  const accSize = Math.round(noteFontSize * 0.44);
  const octSize = Math.round(noteFontSize * 0.16);
  const hasNote = noteDisplay !== null;
  const oor = isOutOfRange && hasNote;

  const letter = noteDisplay?.letter ?? '—';
  const accidental = noteDisplay?.accidental ?? '';
  const octave = noteDisplay?.octave;
  const hzText = freqHz !== null ? freqHz.toFixed(1) : '— — —';
  const centsText = noteDisplay
    ? formatCents(noteDisplay.cents, noteDisplay.precision)
    : '+00';

  const cents = noteDisplay?.cents ?? 0;
  const centsColor =
    !hasNote || oor   ? C.inkVeryDim :
    Math.abs(cents) <= 5  ? C.inTune :
    Math.abs(cents) <= 15 ? C.accent :
                            C.sharp;

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
      {oor ? (
        <View style={styles.oorPill}>
          <Text style={styles.oorPillText}>OUT OF RANGE</Text>
        </View>
      ) : (
        <>
          <Text style={[styles.centsBig, { color: centsColor }]}>
            {centsText}
            <Text style={styles.centsBigUnit}> ¢</Text>
          </Text>
          <View style={styles.hzRow}>
            <Text style={[styles.hzValue, !hasNote && styles.dimText]}>{hzText}</Text>
            <Text style={styles.hzUnit}>Hz</Text>
          </View>
        </>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// CentArc
// ---------------------------------------------------------------------------

export function CentArc({
  activeIndex, cents, arcWidth,
}: {
  activeIndex: number | null;
  cents: number | null;
  arcWidth: DimensionValue;
}) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
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

export function BottomStrip({
  fillAnim, peakAnim, rmsDb, isListening,
  hiFiFallbackVisible, audioSourceLabel,
}: {
  fillAnim: Animated.Value;
  peakAnim: Animated.Value;
  rmsDb: number;
  isListening: boolean;
  hiFiFallbackVisible: boolean;
  audioSourceLabel: string;
}) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  return (
    <View style={styles.bottom}>
      <View style={styles.bottomLeft}>
        {audioSourceLabel.length > 0 && (
          <Text style={styles.audioSourceLabel}>{audioSourceLabel}</Text>
        )}
        {hiFiFallbackVisible && (
          <Text style={styles.hiFiFallbackText}>Device does not support UNPROCESSED capture — using fallback</Text>
        )}
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
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// InstrumentPicker
// ---------------------------------------------------------------------------

export function InstrumentPicker({
  visible, currentKey, onSelect, onClose,
}: {
  visible: boolean;
  currentKey: string;
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  // v0.9.4: gorhom bottom-sheet replaces hand-rolled Modal + Pressable
  // backdrop. The lib's drag-to-dismiss + backdrop press-to-close handles
  // the touch responder fights this picker used to have.
  const sheetRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => ['75%'], []);
  useEffect(() => {
    if (visible) sheetRef.current?.present();
    else sheetRef.current?.dismiss();
  }, [visible]);
  const renderBackdrop = useCallback((props: BottomSheetBackdropProps) => (
    <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.72} pressBehavior="close" />
  ), []);
  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={snapPoints}
      onDismiss={onClose}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: C.inkDim }}
      backgroundStyle={{ backgroundColor: C.face, borderTopLeftRadius: 6, borderTopRightRadius: 6 }}
    >
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
      <BottomSheetScrollView
        contentContainerStyle={styles.pickerScroll}
        showsVerticalScrollIndicator
        persistentScrollbar
      >
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
        <View style={{ height: 24 }} />
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

// ---------------------------------------------------------------------------
// PeakSlideToggle — LIVE / COLLECT slider
// ---------------------------------------------------------------------------

export function PeakSlideToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  const animRef = useRef(new Animated.Value(value ? 1 : 0));
  const anim = animRef.current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: value ? 1 : 0,
      useNativeDriver: false,
      bounciness: 6,
      speed: 18,
    }).start();
  }, [value, anim]);

  const knobLeft = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [PEAK_PAD, PEAK_PAD + PEAK_TRAVEL],
  });
  const knobBg = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [C.inkDim, C.accent],
  });

  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={value ? 'Mode: LIVE — continuous pitch readout' : 'Mode: COLLECT — bucket samples per note and show stats'}
      style={styles.peakSlideHit}
    >
      <View style={styles.peakSlideTrack}>
        <Text style={[styles.peakSlideEndOff, !value && styles.peakSlideEndOffActive]}>COLLECT</Text>
        <Text style={[styles.peakSlideEndOn, value && styles.peakSlideEndOnActive]}>LIVE</Text>
        <Animated.View
          style={[
            styles.peakSlideKnob,
            { left: knobLeft, backgroundColor: knobBg },
          ]}
        >
          <Text style={[styles.peakSlideKnobText, value && styles.peakSlideKnobTextActive]}>
            {value ? 'LIVE' : 'COLLECT'}
          </Text>
        </Animated.View>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// TapToLogCta
// ---------------------------------------------------------------------------

export function TapToLogCta({
  freqHz, noteLabel, centsText, count, onLog, onUndo,
}: {
  freqHz: number | null;
  noteLabel: string;
  centsText: string;
  count: number;
  onLog: () => LogResult | null;
  onUndo: () => number | null;
}) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  void C;
  type FlashState = 'idle' | 'ok' | 'bad';
  const [flash, setFlash] = useState<FlashState>('idle');
  const [flashMsg, setFlashMsg] = useState<string>('');
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [undoExpiresAt, setUndoExpiresAt] = useState<number | null>(null);
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (undoExpiresAt === null) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [undoExpiresAt]);
  const undoSecsLeft = undoExpiresAt !== null
    ? Math.max(0, Math.ceil((undoExpiresAt - Date.now()) / 1000))
    : 0;
  useEffect(() => {
    if (undoExpiresAt !== null && undoSecsLeft <= 0) setUndoExpiresAt(null);
  }, [undoExpiresAt, undoSecsLeft]);

  const triggerFlash = (kind: FlashState, msg: string) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash(kind);
    setFlashMsg(msg);
    flashTimer.current = setTimeout(() => {
      setFlash('idle');
      setFlashMsg('');
    }, 220);
  };

  const handleLog = () => {
    const result = onLog();
    if (result === null) {
      triggerFlash('bad', 'NO PITCH · TRY AGAIN');
      return;
    }
    triggerFlash('ok', `LOGGED · ${noteLabel} · ${formatCentsForLog(result.cents)}¢ · N=${result.n}`);
    setUndoExpiresAt(Date.now() + 6000);
  };

  const handleUndo = () => {
    const dropped = onUndo();
    if (dropped === null) return;
    setUndoExpiresAt(null);
    triggerFlash('ok', 'REMOVED LAST');
  };

  const disabled = freqHz === null;

  const barText = flash !== 'idle'
    ? flashMsg
    : disabled
      ? 'TAP TO LOG · WAITING FOR NOTE'
      : `TAP TO LOG · ${noteLabel} · ${centsText}¢ · N=${count}`;

  const showUndo = undoExpiresAt !== null && undoSecsLeft > 0;

  return (
    <View style={styles.logCtaRow}>
      <Pressable
        onPress={handleLog}
        disabled={disabled && flash === 'idle'}
        accessibilityRole="button"
        accessibilityLabel={
          disabled
            ? 'Tap to log — disabled, no pitch detected yet'
            : `Tap to log current reading: ${noteLabel}, ${centsText} cents`
        }
        style={({ pressed }) => [
          styles.logCtaBar,
          flash === 'ok' && styles.logCtaBarFlashOk,
          flash === 'bad' && styles.logCtaBarFlashBad,
          disabled && flash === 'idle' && styles.logCtaBarDisabled,
          pressed && !disabled && styles.logCtaBarPressed,
        ]}
      >
        <Text
          style={[
            styles.logCtaText,
            (flash !== 'idle') && styles.logCtaTextFlash,
            disabled && flash === 'idle' && styles.logCtaTextDisabled,
          ]}
          numberOfLines={1}
        >
          {barText}
        </Text>
      </Pressable>
      {showUndo && (
        <Pressable
          onPress={handleUndo}
          accessibilityRole="button"
          accessibilityLabel={`Undo last log. ${undoSecsLeft} seconds left.`}
          style={({ pressed }) => [styles.undoBar, pressed && styles.undoBarPressed]}
        >
          <Text style={styles.undoText}>UNDO</Text>
          <Text style={styles.undoCountdown}>{undoSecsLeft}s</Text>
        </Pressable>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// BucketStatsCard
// ---------------------------------------------------------------------------

export function BucketStatsCard({
  bucket, displayMode, a4Hz, transp,
}: {
  bucket: BucketStats | null;
  displayMode: DisplayMode;
  a4Hz: number;
  transp: number;
}) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  if (bucket === null || bucket.n === 0) {
    return (
      <View style={styles.statsCard}>
        <Text style={styles.statsEmptyCard}>
          Play a note to start a bucket.{'\n'}Stats appear once samples come in.
        </Text>
      </View>
    );
  }
  const labelMidi = displayMode === 'griff' ? bucket.midiFing : bucket.midiSound;
  const subMidi   = displayMode === 'griff' ? bucket.midiSound : bucket.midiFing;
  const { letter, accidental, octave } = midiToNoteName(labelMidi);
  const subName = midiToNoteName(subMidi);
  const subLabel = displayMode === 'griff'
    ? `${subName.letter}${subName.accidental}${subName.octave} concert`
    : `${subName.letter}${subName.accidental}${subName.octave} on page`;
  void a4Hz; void transp;

  const mean = bucket.meanCents;
  const tendency =
    Math.abs(mean) <= 3 ? 'in-tune' :
    mean > 0          ? 'sharp tendency' :
                        'flat tendency';
  const tendencyColor =
    Math.abs(mean) <= 3 ? C.inTune :
    Math.abs(mean) <= 15 ? C.accent :
                           C.sharp;
  const meanText = `${mean >= 0 ? '+' : ''}${mean.toFixed(1)}¢`;
  const stdText = `${bucket.stdCents.toFixed(1)}¢`;
  const rangeText = `${bucket.rangeMin >= 0 ? '+' : ''}${bucket.rangeMin.toFixed(0)} to ${bucket.rangeMax >= 0 ? '+' : ''}${bucket.rangeMax.toFixed(0)}¢`;

  return (
    <View style={styles.statsCard}>
      <View style={styles.statsCardHeader}>
        <View>
          <Text style={styles.statsCardTitle}>{letter}{accidental}{octave}</Text>
          <Text style={styles.statsCardSub}>{subLabel}</Text>
        </View>
        <Text style={styles.statsCardCount}>{bucket.n} logged</Text>
      </View>
      <View style={styles.statsRow}>
        <Text style={styles.statsLabel}>MEAN</Text>
        <Text style={[styles.statsValue, styles.statsValueMean, { color: tendencyColor }]}>{meanText}</Text>
      </View>
      <Text style={[styles.statsHint, { color: tendencyColor }]}>{tendency}</Text>
      <View style={styles.statsRow}>
        <Text style={styles.statsLabel}>STD</Text>
        <Text style={styles.statsValue}>{stdText}</Text>
      </View>
      <View style={styles.statsRow}>
        <Text style={styles.statsLabel}>RANGE</Text>
        <Text style={styles.statsValue}>{rangeText}</Text>
      </View>
      <View style={styles.statsLast5Row}>
        <Text style={styles.statsLabel}>LAST 5</Text>
        <View style={styles.statsLast5Values}>
          {bucket.last5.length === 0 ? (
            <Text style={styles.statsLast5Item}>—</Text>
          ) : (
            bucket.last5.map((c, i) => (
              <Text key={i} style={styles.statsLast5Item}>
                {c >= 0 ? '+' : ''}{c.toFixed(0)}
              </Text>
            ))
          )}
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// SessionStrip
// ---------------------------------------------------------------------------

export function SessionStrip({
  active, startedAtMs, onToggle,
}: {
  active: boolean;
  startedAtMs: number | null;
  onToggle: (v: boolean) => void;
}) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  void C;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);

  const elapsed = active && startedAtMs !== null
    ? Math.floor((Date.now() - startedAtMs) / 1000)
    : 0;
  const hh = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const timeText = `${hh}:${mm}:${ss}`;

  if (!active) {
    return (
      <View style={styles.sessionStrip}>
        <Pressable
          onPress={() => onToggle(true)}
          accessibilityRole="button"
          accessibilityLabel="Start a collection session. The tuner will auto-log sustained notes."
          style={({ pressed }) => [styles.sessionChip, pressed && styles.sessionChipPressed]}
        >
          <Text style={styles.sessionChipText}>● START SESSION</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.sessionStrip}>
      <View style={[styles.sessionChip, styles.sessionChipActive]}>
        <Text style={[styles.sessionChipText, styles.sessionChipTextActive]}>SESSION {timeText}</Text>
      </View>
      <Pressable
        onPress={() => onToggle(false)}
        accessibilityRole="button"
        accessibilityLabel="End the current session."
        style={({ pressed }) => [styles.sessionEndBtn, pressed && styles.sessionEndBtnPressed]}
      >
        <Text style={styles.sessionEndText}>END</Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// HornNameEditor
// ---------------------------------------------------------------------------

export function HornNameEditor({
  visible, initialValue, onClose, onSave, draft, setDraft,
}: {
  visible: boolean;
  initialValue: string;
  onClose: () => void;
  onSave: (v: string) => void;
  draft: string;
  setDraft: (v: string) => void;
}) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  // v0.9.4: gorhom bottom-sheet. Dynamic sizing — the small editor hugs its
  // own content height. Keyboard appearance pushes the sheet up via gorhom's
  // built-in handling (`keyboardBehavior="interactive"`).
  const sheetRef = useRef<BottomSheetModal>(null);
  useEffect(() => {
    if (visible) {
      setDraft(initialValue);
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const renderBackdrop = useCallback((props: BottomSheetBackdropProps) => (
    <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.72} pressBehavior="close" />
  ), []);

  return (
    <BottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      onDismiss={onClose}
      backdropComponent={renderBackdrop}
      keyboardBehavior="interactive"
      android_keyboardInputMode="adjustResize"
      handleIndicatorStyle={{ backgroundColor: C.inkDim }}
      backgroundStyle={{ backgroundColor: C.face, borderTopLeftRadius: 6, borderTopRightRadius: 6 }}
    >
      <BottomSheetView>
        <View style={styles.pickerHeader}>
          <Text style={styles.pickerTitle}>HORN NAME</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={({ pressed }) => [styles.pickerClose, pressed && styles.stepBtnPressed]}
          >
            <Text style={styles.pickerCloseText}>✕</Text>
          </Pressable>
        </View>
        <View style={{ paddingHorizontal: 20, paddingVertical: 20, paddingBottom: 32 }}>
          <Text style={styles.settingsRowHint}>
            A label for this horn — e.g. "My Conn 10M", "Mark VI", "Yamaha YTS-62".
            Used in the table view to compare runs across different instruments.
          </Text>
          <View style={{ marginTop: 16, flexDirection: 'row', gap: 8 }}>
            <TextInput
              style={styles.studentInput}
              value={draft}
              onChangeText={setDraft}
              placeholder="Horn nickname"
              placeholderTextColor={C.inkDim}
              returnKeyType="done"
              onSubmitEditing={() => onSave(draft.trim())}
              accessibilityLabel="Horn nickname"
              autoFocus
            />
            <Pressable
              onPress={() => onSave(draft.trim())}
              accessibilityRole="button"
              accessibilityLabel="Save horn name"
              style={({ pressed }) => [styles.studentAddBtn, pressed && styles.studentAddBtnPressed]}
            >
              <Text style={styles.studentAddBtnText}>SAVE</Text>
            </Pressable>
          </View>
          {draft.trim().length > 0 && (
            <Pressable
              onPress={() => onSave('')}
              accessibilityRole="button"
              accessibilityLabel="Clear horn nickname"
              style={({ pressed }) => [styles.settingsLinkBtn, pressed && styles.settingsLinkBtnPressed, { marginTop: 16 }]}
            >
              <Text style={styles.settingsLinkBtnText}>CLEAR NAME</Text>
            </Pressable>
          )}
        </View>
      </BottomSheetView>
    </BottomSheetModal>
  );
}

// ---------------------------------------------------------------------------
// PermissionGate
// ---------------------------------------------------------------------------

export function PermissionGate({
  refHz,
  status,
  reason,
  onOpenSettings,
  onRetry,
}: {
  refHz: number;
  status: 'mic-denied' | 'stream-failed';
  reason: string | null;
  onOpenSettings: () => void;
  onRetry: () => void;
}) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  void C;
  const isStreamFailed = status === 'stream-failed';
  const pillText = isStreamFailed ? 'NO AUDIO' : 'NO MIC';
  const title = isStreamFailed ? 'AUDIO INPUT LOST' : 'MICROPHONE REQUIRED';
  const body = isStreamFailed
    ? 'The microphone stream stopped responding. This usually means another app took exclusive access, or the headphone state changed mid-session.'
    : 'The tuner reads your horn through the microphone. Audio is processed on-device and never leaves the device.';
  const hint = isStreamFailed
    ? 'Tap TRY AGAIN to reopen the stream. If that fails, check that no other app is recording.'
    : 'Tap OPEN SETTINGS to allow microphone access, then TRY AGAIN.';

  return (
    <View style={styles.root}>
      <View style={styles.faceplate}>
        <View style={styles.topBar}>
          <View style={styles.topLeft}>
            <Text style={styles.brand}>{APP_NAME}</Text>
            <Text style={styles.instrumentBadge}>Bb TENOR · PAGE</Text>
          </View>
          <View style={styles.topRight}>
            <Text style={styles.refLabel}>REF</Text>
            <Text style={styles.refValue}>A = {refHz} Hz</Text>
            <View style={styles.statusPill}>
              <View style={styles.statusDot} />
              <Text style={styles.statusText}>{pillText}</Text>
            </View>
          </View>
        </View>
        <View style={styles.gate}>
          <Text style={styles.gateTitle}>{title}</Text>
          <Text style={styles.gateBody}>{body}</Text>
          <Text style={styles.gateHint}>{hint}</Text>
          {reason ? <Text style={styles.gateReason}>reason: {reason}</Text> : null}
          <View style={styles.gateActions}>
            {!isStreamFailed ? (
              <Pressable
                onPress={onOpenSettings}
                accessibilityRole="button"
                accessibilityLabel="Open system Settings to grant microphone permission"
                style={({ pressed }) => [styles.gateButton, styles.gateButtonSecondary, pressed && styles.gateButtonPressed]}
              >
                <Text style={styles.gateButtonTextSecondary}>OPEN SETTINGS</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={onRetry}
              accessibilityRole="button"
              accessibilityLabel="Try again"
              style={({ pressed }) => [styles.gateButton, styles.gateButtonPrimary, pressed && styles.gateButtonPressed]}
            >
              <Text style={styles.gateButtonTextPrimary}>TRY AGAIN</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.gateFooter} />
      </View>
    </View>
  );
}
