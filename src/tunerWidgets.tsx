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
import type { TabKey } from './components/TabBar'; // v1.2 — tab-aware TopBar
import {
  Animated,
  DimensionValue,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useTheme } from './theme';
import type { ThemePalette } from './theme'; // v1.2 — needed by makeTopBarStyles
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
      style={({ pressed }) => [styles.silenceBanner, pressed && { opacity: 0.7 }]}
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
// TopBar — tab-aware (v1.2). Fixed total height 136dp across all four tabs.
// Non-rendered slots become invisible spacers so body content never reflows.
// ---------------------------------------------------------------------------

// v1.2 — total height constant matches §14.3 pixel budget (136dp locked).
const TOP_BAR_HEIGHT = 136;

export function TopBar({
  activeTab,                           // v1.2 — drives per-tab pill rendering
  status, streamErrorReason, refHz, setRefHz, compact,
  badgeText, displayMode, setDisplayMode, onBadgePress, onTablePress, onPipesPress,
  hornName,
}: {
  activeTab: TabKey;                   // v1.2 — NEW
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
  const tb = useMemo(() => makeTopBarStyles(C), [C]);
  void compact;

  // #19 — graceful degradation for narrow portrait widths (e.g. 360dp).
  // The Row-2 stepper + PAGE/CONCERT toggle are rigid (RN flexShrink defaults
  // to 0), so when the row over-constrains, the only flexible child — the
  // instrument badge — collapses to ~0 width AND the residual overflow clips
  // the trailing CONCERT pill ("CONC"). Below the threshold we trim purely
  // decorative air (letterSpacing + horizontal padding) from the rigid blocks
  // and floor the badge so it ellipsises ("BB SAX…") instead of vanishing.
  // Gate is width-only: at the 411dp primary target and in landscape `narrow`
  // is false, so NONE of the narrow overrides apply → byte-identical layout.
  const { width: winW } = useWindowDimensions();
  const narrow = winW < 390;

  // v1.2 — tab guards
  const isTuner = activeTab === 'tuner';
  const isMetro = activeTab === 'metro';
  const isDeck  = activeTab === 'deck';
  const isSetup = activeTab === 'setup';
  void isSetup; // always-on rows cover setup; no positive branch needed

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

  // v1.2 — status caption text (empty string reserves the slot on all tabs)
  const captionText = statusLabel !== null
    ? `${statusLabel}${streamErrorReason !== null ? ` — ${streamErrorReason.slice(0, 40)}` : ''}`
    : '';

  return (
    // v1.2 — outer container locked at 136dp; overflow hidden prevents bleed.
    // [styles.topBar] supplies the bottom border + borderBottomColor; we
    // overlay height + overflow via the local tb.container key.
    <View style={[styles.topBar, tb.container]}>

      {/* ── Row 1: BELLCURVE wordmark + status dot — always-on ── */}
      {/* Status dot lifted out of topRow2 into the always-on row (§14.1). */}
      <View style={tb.wordmarkRow}>
        <Text style={styles.brand} numberOfLines={1}>{APP_NAME}</Text>
        <View
          style={[styles.statusDotLarge, { backgroundColor: statusColor }]}
          accessibilityRole="image"
          accessibilityLabel={`Status: ${statusLabel ?? 'listening'}`}
        />
      </View>

      {/* ── Row 2: badge + A= + optional displayToggle — tab-conditional ── */}
      {/*
          TUNER  → full row: badge + A= stepper + PAGE/CONCERT toggle
          METRO  → lite row: badge + A= stepper (no PAGE/CONCERT)
          DECK   → lite row: badge + A= stepper (no PAGE/CONCERT)
          SETUP  → invisible spacer only
      */}
      {(isTuner || isMetro || isDeck) ? (
        <View style={[tb.pillsRow, narrow && tb.pillsRowNarrow]}>
          {/* Instrument badge */}
          <Pressable
            onPress={onBadgePress}
            accessibilityRole="button"
            accessibilityLabel={
              hornName.length > 0
                ? `Current instrument: ${badgeText}. Horn: ${hornName}. Tap to change.`
                : `Current instrument: ${badgeText}. Tap to change.`
            }
            style={({ pressed }) => [
              styles.badgePressable,
              tb.badgeCompact,
              narrow && tb.badgeNarrow,
              pressed && styles.badgePressablePressed,
            ]}
          >
            <Text style={styles.instrumentBadge} numberOfLines={1} ellipsizeMode="tail">{badgeText}</Text>
            {hornName.length > 0 && (
              <Text style={styles.hornNameCaption} numberOfLines={1} ellipsizeMode="tail">{hornName}</Text>
            )}
          </Pressable>

          {/* A= stepper */}
          <View style={[styles.refContainer, tb.refCompact, narrow && tb.refNarrow]}>
            <Pressable
              onPress={() => bump(-1)}
              accessibilityRole="button"
              accessibilityLabel="Decrease reference by 1 Hz"
              hitSlop={narrow ? 6 : undefined}
              style={({ pressed }) => [styles.stepBtn, narrow && tb.stepBtnNarrow, pressed && styles.stepBtnPressed]}
            >
              <Text style={styles.stepBtnText}>−</Text>
            </Pressable>
            <Text style={[styles.refValue, narrow && tb.refValueNarrow]}>A={refHz}</Text>
            <Pressable
              onPress={() => bump(1)}
              accessibilityRole="button"
              accessibilityLabel="Increase reference by 1 Hz"
              hitSlop={narrow ? 6 : undefined}
              style={({ pressed }) => [styles.stepBtn, narrow && tb.stepBtnNarrow, pressed && styles.stepBtnPressed]}
            >
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>

          {/* PAGE/CONCERT toggle — TUNER only (§14.2, §15.Q14.3) */}
          {isTuner && (
            <View style={styles.displayToggle}>
              <Pressable
                onPress={() => setDisplayMode('griff')}
                accessibilityRole="button"
                accessibilityLabel="Show the note as written on the page (fingered pitch)"
                accessibilityState={{ selected: displayMode === 'griff' }}
                style={({ pressed }) => [
                  styles.displayPill,
                  tb.pillCompact,
                  narrow && tb.pillNarrow,
                  displayMode === 'griff' && styles.displayPillActive,
                  pressed && styles.gainPillPressed,
                ]}
              >
                <Text style={[styles.displayPillText, narrow && tb.pillTextNarrow, displayMode === 'griff' && styles.displayPillTextActive]}>PAGE</Text>
              </Pressable>
              <Pressable
                onPress={() => setDisplayMode('klingend')}
                accessibilityRole="button"
                accessibilityLabel="Show the concert pitch — what comes out of the horn"
                accessibilityState={{ selected: displayMode === 'klingend' }}
                style={({ pressed }) => [
                  styles.displayPill,
                  tb.pillCompact,
                  narrow && tb.pillNarrow,
                  displayMode === 'klingend' && styles.displayPillActive,
                  pressed && styles.gainPillPressed,
                ]}
              >
                <Text style={[styles.displayPillText, narrow && tb.pillTextNarrow, displayMode === 'klingend' && styles.displayPillTextActive]} numberOfLines={1}>CONCERT</Text>
              </Pressable>
            </View>
          )}
        </View>
      ) : (
        // SETUP — invisible spacer preserves 136dp height invariant (§14.3)
        <View style={tb.pillsSpacer} accessibilityElementsHidden importantForAccessibility="no" />
      )}

      {/* ── Status caption slot — always rendered; empty string = reserved height ── */}
      {/* §14.1: reserves 16dp slot even when status is healthy (no reflow). */}
      <Text
        style={[styles.statusCaption, tb.captionSlot]}
        numberOfLines={1}
        accessibilityLiveRegion="polite"
      >
        {captionText}
      </Text>

      {/* ── Row 4: TABLE + PIPES nav — TUNER only; spacer on other tabs ── */}
      {isTuner ? (
        <View style={[styles.topNavRow, tb.navRowCompact]}>
          <Pressable
            onPress={onTablePress}
            accessibilityRole="button"
            accessibilityLabel="Open intonation table"
            style={({ pressed }) => [styles.iconBtn, tb.navBtnCompact, pressed && styles.iconBtnPressed]}
          >
            <Text style={styles.iconBtnText}>TABLE</Text>
          </Pressable>
          <Pressable
            onPress={onPipesPress}
            accessibilityRole="button"
            accessibilityLabel="Open pitch pipes"
            style={({ pressed }) => [styles.iconBtn, tb.navBtnCompact, pressed && styles.iconBtnPressed]}
          >
            <Text style={styles.iconBtnText}>PIPES</Text>
          </Pressable>
        </View>
      ) : (
        // Invisible spacer — same height as navRow — keeps 136dp invariant
        <View style={tb.navSpacer} accessibilityElementsHidden importantForAccessibility="no" />
      )}
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

  // v1.1 — reserve fixed vertical space so the layout below never reflows
  // when the note letter appears or disappears.
  //
  // v1.4 wave-5 — use a FIXED `height`, not `minHeight`. The two render
  // branches below differ in height (normal: note + centsBig + hzRow ≈
  // fontSize+66; out-of-range: note + short oorPill ≈ fontSize+35). With
  // `minHeight` the normal/empty branch OVERFLOWED the reservation while the
  // out-of-range branch sat at the floor, so the block's outer height changed
  // between states. Because the parent (`centerPortrait`) vertically CENTERS
  // the whole CentArc + NoteReadout stack, that height delta shoved the arc
  // up/down intermittently. A fixed height pins the outer box so the arc's
  // vertical position is stable across note-present / silence / out-of-range.
  // The reserve covers the tallest branch with headroom for line-height
  // variance; inner content top-anchors via noteBlock's default flex-start.
  const noteBlockHeight = noteFontSize + 72;

  return (
    <View style={[styles.noteBlock, { height: noteBlockHeight }]}>
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
    const arr: { major: boolean; center: boolean; subMajor: boolean }[] = [];
    for (let i = 0; i < CENT_TICK_COUNT; i++) {
      const c = -CENT_RANGE + (i * CENT_RANGE * 2) / (CENT_TICK_COUNT - 1);
      const center = Math.abs(c) < 0.001;
      const major = center || c === -CENT_RANGE || c === CENT_RANGE;
      // v0.9.8 — sub-major ticks at -25 and +25 so the label grid has
      // matching tick weight beneath it. Previously the labels at -25 and
      // +25 hovered above featureless minor ticks, breaking visual grammar.
      const subMajor = !major && (c === -CENT_RANGE / 2 || c === CENT_RANGE / 2);
      arr.push({ major, center, subMajor });
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
        {/* Zone backdrop — sits BEHIND the ticks. Previously a 2dp hairline
            below the track at ~35 % opacity, which read as a thin border
            instead of a tuning-zone indicator. Now fills the track at
            ~50 % opacity so the eye lands on the colored zones first. */}
        <View style={styles.arcZonesBackdrop}>
          <View style={[styles.arcZone, styles.arcZoneFlat]} />
          <View style={[styles.arcZone, styles.arcZoneInTune]} />
          <View style={[styles.arcZone, styles.arcZoneSharp]} />
        </View>
        {ticks.map((t, i) => (
          <View
            key={i}
            style={[
              styles.arcTick,
              t.subMajor && styles.arcTickSubMajor,
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
          {/* v0.9.8 — three-zone background. Green up to −12 dB, amber to
              −3 dB, red to 0 dB. The dim overlay covers the portion of
              the track BEYOND the current fill, so the zones only show
              up-to-fill. Real mixer/interface meters look exactly like
              this. */}
          <View style={styles.meterZoneGreen} />
          <View style={styles.meterZoneAmber} />
          <View style={styles.meterZoneRed} />
          <Animated.View
            style={[styles.meterDim, { left: fillAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}
          />
          <Animated.View
            style={[styles.peakMark, { left: peakAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}
          />
          <View style={[styles.meterTick, { left: `${tickPct(-40)}%` }]} />
          <View style={[styles.meterTick, { left: `${tickPct(-20)}%` }]} />
          <View style={[styles.meterTick, { left: `${tickPct(-12)}%` }]} />
          <View style={[styles.meterTickHot, { left: `${tickPct(-3)}%` }]} />
        </View>
        {/* Scale labels — absolutely positioned at exact tick percentages
            so they sit DIRECTLY under their ticks. */}
        <View style={styles.meterScale}>
          <Text style={[styles.meterScaleLabel, { left: '0%' }]}>-60</Text>
          <Text style={[styles.meterScaleLabel, { left: `${tickPct(-40)}%`, marginLeft: -8 }]}>-40</Text>
          <Text style={[styles.meterScaleLabel, { left: `${tickPct(-20)}%`, marginLeft: -8 }]}>-20</Text>
          <Text style={[styles.meterScaleLabel, { left: `${tickPct(-12)}%`, marginLeft: -8 }]}>-12</Text>
          <Text style={[styles.meterScaleLabel, styles.meterScaleLabelHot, { left: `${tickPct(-3)}%`, marginLeft: -10 }]}>-3 dB</Text>
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
      style={({ pressed }) => [styles.peakSlideHit, pressed && { opacity: 0.7 }]}
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
  // v1.4 wave-11 T5 — cancel in-flight flash timer on unmount to avoid
  // setState on an unmounted component (React warning + memory leak).
  useEffect(() => {
    return () => {
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
        flashTimer.current = null;
      }
    };
  }, []);
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
// makeTopBarStyles — local style factory for TopBar only.
// Lives here (not in uiShared.tsx) because uiShared is Frodo's wave-2 territory.
//
// Height budget (§14.3 — 136dp locked):
//   wordmarkRow  42dp  (brand fontSize:28 + paddingTop:8 + paddingBottom:6 → fits in 42 via overflow:hidden)
//   pillsRow     44dp  (H.pillHeight; badge + refContainer clipped to this height)
//   captionSlot  16dp  (always rendered; empty when status = 'listening')
//   navRow       28dp  (TABLE/PIPES buttons or spacer; paddingTop stripped)
//   topBar.paddingBottom  6dp  (from uiShared topBar style)
//   ──────────────────────────
//   TOTAL       136dp  ✓
// ---------------------------------------------------------------------------

function makeTopBarStyles(C: ThemePalette) {
  return StyleSheet.create({
    // Outer container — locks total height. Merges with uiShared styles.topBar
    // (border + paddingBottom) via array spread in JSX.
    container: {
      height: TOP_BAR_HEIGHT,
      overflow: 'hidden',
    },

    // Row 1: BELLCURVE wordmark + status dot (always-on)
    // brand style's own paddingTop:8 + fontSize:28 + paddingBottom:6 ≈ 42dp.
    wordmarkRow: {
      height: 42,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      overflow: 'hidden',
    },

    // Row 2 (TUNER/METRO/DECK): badge + A= + optional displayToggle
    pillsRow: {
      height: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      overflow: 'hidden',
    },

    // Row 2 SETUP spacer — same 44dp, invisible
    pillsSpacer: {
      height: 44,
    },

    // Override badgePressable minHeight so it fits inside the 44dp pillsRow
    badgeCompact: {
      minHeight: 36,
      paddingVertical: 4,
    },

    // Override refContainer minHeight to fit inside 44dp pillsRow
    refCompact: {
      minHeight: 36,
    },

    // Override displayPill height to fit inside 44dp pillsRow
    pillCompact: {
      height: 36,
    },

    // ── #19 narrow-width (<390dp) overrides ──────────────────────────────
    // Applied ONLY when winW < 390 (so the 411dp target + landscape never see
    // them). Each trims decorative letterSpacing / horizontal padding from the
    // rigid stepper + toggle to free ~70dp, so CONCERT stays fully visible and
    // the badge gets a real (non-zero) width floor with tail-ellipsis.

    // Row 2 — tighten inter-element gap (8 → 6) to claw back 4dp.
    pillsRowNarrow: {
      gap: 6,
    },

    // Badge — floor the width so flexShrink can't collapse it to empty; the
    // instrumentBadge <Text> already has numberOfLines={1}+ellipsizeMode='tail'
    // so the name degrades to "BB SAX…" / "BB S…" instead of disappearing.
    // Floor is intentionally SMALL (40dp): it must stay ≤ the row's residual
    // free space so it never re-pushes CONCERT off-screen — the badge is the
    // single element that yields; the toggle (flexShrink:0) never clips.
    badgeNarrow: {
      minWidth: 40,
      flexShrink: 1,        // explicit: badge is the only element that yields
      paddingHorizontal: 8, // 10 → 8: 4dp back, border/radius unchanged
    },

    // A= stepper — trim only the container's own air; the step buttons keep a
    // full 48dp TOUCH target via hitSlop (see stepBtnNarrow) so a11y holds.
    refNarrow: {
      paddingHorizontal: 3, // 6 → 3
      gap: 2,               // 4 → 2
    },
    // Step button — shrink the VISUAL box 48 → 36 to reclaim 24dp across both
    // buttons. The 6dp hitSlop on each side (applied in JSX) restores the 48dp
    // tappable area, so this is a density change only, not a touch-target one.
    stepBtnNarrow: {
      width: 36,
    },
    // A=440 readout — drop decorative letterSpacing (2 → 0); tabular-nums kept.
    refValueNarrow: {
      letterSpacing: 0,
    },

    // PAGE/CONCERT pills — drop minWidth floor + tighten padding so CONCERT's
    // own text drives the width (still fully visible, just denser).
    pillNarrow: {
      minWidth: 48,
      paddingHorizontal: 6, // 8 → 6
    },
    // Pill labels — drop decorative letterSpacing (2 → 0); biggest single
    // saving on the 7-glyph CONCERT string (~14dp).
    pillTextNarrow: {
      letterSpacing: 0,
    },

    // Status caption slot — always rendered (empty string when status = 'listening').
    // 16dp reserved regardless of content; kills reflow when status changes.
    captionSlot: {
      height: 16,
      marginTop: 0, // neutralise the marginTop:2 from uiShared statusCaption
      lineHeight: 14,
    },

    // Row 4 (TUNER): TABLE + PIPES nav row — compacted from uiShared topNavRow
    // (uiShared has paddingTop:8 + paddingBottom:2 + iconBtn height:48 = 58dp;
    //  here we strip padding and shrink btn height to 28dp)
    navRowCompact: {
      height: 28,
      paddingTop: 0,
      paddingBottom: 0,
      alignItems: 'center',
    },

    // Compact nav buttons — height reduced to fit 28dp row
    navBtnCompact: {
      height: 28,
      minWidth: 56,
    },

    // Row 4 spacer for non-TUNER tabs — same 28dp, invisible
    navSpacer: {
      height: 28,
    },
  });
}
// Re-export for potential future use, but the factory is consumed locally above.
export { makeTopBarStyles };

// ---------------------------------------------------------------------------
// PermissionGate
// ---------------------------------------------------------------------------

export function PermissionGate({
  refHz,
  status,
  reason,
  onOpenSettings,
  onRetry,
  badgeText,
  displayMode,
}: {
  refHz: number;
  status: 'mic-denied' | 'stream-failed';
  reason: string | null;
  onOpenSettings: () => void;
  onRetry: () => void;
  // v1.0 BUG-3 — real instrument + display mode instead of hardcoded string
  badgeText?: string;
  displayMode?: DisplayMode;
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
            <Text style={styles.instrumentBadge}>
              {/* v1.0 BUG-3 — real instrument / display mode */}
              {badgeText ?? 'BELLCURVE'}
              {displayMode ? ` · ${displayMode === 'griff' ? 'PAGE' : 'CONCERT'}` : ''}
            </Text>
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
