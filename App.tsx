/**
 * Intonation Analyzer — Android, chunk 2 of 5.
 *
 * Wires useAudioEngine (pitch + metering) into the professional-tuner
 * faceplate. Portrait and landscape layouts, live note readout (Bb tenor
 * fingered), cent arc needle, A=440 ±stepper, low/high gain toggle.
 *
 * Visual language: Peterson-amber (#d6b86a), near-black faceplate, restrained
 * typography, generous letter-spacing. No new dependencies.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  DimensionValue,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { useAudioEngine } from './src/useAudioEngine';
import type { GainMode } from './src/useAudioEngine';
import {
  centsDeviation,
  centsDisplayPrecision,
  midiToNoteName,
} from './src/music';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = 'INTONATION ANALYZER';
const APP_VERSION = '0.2.3';
const STAGE_LABEL = 'pipeline test · 2 of 5';

// Bb tenor sax: sounding pitch is 14 semitones (octave + major 2nd) below
// fingered notation. YIN detects the sounding pitch from the horn; add 14
// to get the MIDI number Tom sees on his chart. Source of truth:
// F:\Code\Toys\saxophone-intonation-table\sax_instruments.py line 34,
// ('bb_tenor', -14, ...) — desktop convention: negative transp = sounding
// below fingered, so the display conversion adds the absolute value.
const TENOR_TRANSPOSE = 14;

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

  // v0.2.2 — snappy meter response.  Was damping 18 / stiffness 140 / mass 0.4
  // (~150 ms settle).  Tightened to damping 10 / stiffness 260 / mass 0.2 so
  // the bar tracks the dB envelope without obvious lag (~50 ms settle).
  Animated.spring(fillAnim, { toValue: mf, useNativeDriver: false, damping: 10, stiffness: 260, mass: 0.2 }).start();
  Animated.timing(peakAnim, { toValue: newPeak, duration: 60, useNativeDriver: false }).start();

  // Compute note display from live freqHz.
  const noteDisplay = useMemo((): NoteDisplay | null => {
    if (engine.freqHz === null) return null;
    const { nearestMidi, cents } = centsDeviation(engine.freqHz, refHz);
    const { letter, accidental, octave } = midiToNoteName(nearestMidi + TENOR_TRANSPOSE);
    const precision = centsDisplayPrecision(engine.freqHz);
    return { letter, accidental, octave, cents, precision, tickIndex: centsToTickIndex(cents) };
  }, [engine.freqHz, refHz]);

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

  return (
    <View style={styles.root}>
      <View style={styles.faceplate}>
        <TopBar
          statusText={statusText}
          refHz={refHz}
          refEdit={refEdit}
          setRefHz={setRefHz}
          setRefEdit={setRefEdit}
          compact={!isLandscape}
        />
        <View style={centerStyle}>
          <CentArc activeIndex={arcIndex} cents={noteDisplay?.cents ?? null} arcWidth="100%" />
          <NoteReadout
            noteDisplay={noteDisplay}
            freqHz={engine.freqHz}
            noteFontSize={noteFontSize}
          />
        </View>
        <BottomStrip
          fillAnim={fillAnim}
          peakAnim={peakAnim}
          rmsDb={engine.rmsDb}
          isListening={isListening}
          gainMode={engine.gainMode}
          setGainMode={engine.setGainMode}
        />
        <DiagnosticLine
          rmsDb={engine.rmsDb}
          yinCallCount={engine.yinCallCount}
          rawFreqHz={engine.rawFreqHz}
        />
      </View>
    </View>
  );
}

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
}: {
  statusText: string;
  refHz: number;
  refEdit: boolean;
  setRefHz: (v: number) => void;
  setRefEdit: (v: boolean) => void;
  compact: boolean;
}) {
  const bump = (d: number) =>
    setRefHz(Math.max(REF_HZ_MIN, Math.min(REF_HZ_MAX, refHz + d)));

  return (
    <View style={[styles.topBar, compact && styles.topBarCompact]}>
      <View style={styles.topLeft}>
        <Text style={compact ? styles.brandCompact : styles.brand}>{APP_NAME}</Text>
        <Text style={styles.brandVersion}>v{APP_VERSION}</Text>
        <Text style={styles.instrumentBadge}>Bb TENOR · FINGERED</Text>
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
  noteDisplay, freqHz, noteFontSize,
}: {
  noteDisplay: NoteDisplay | null;
  freqHz: number | null;
  noteFontSize: number;
}) {
  const accSize = Math.round(noteFontSize * 0.44);
  const octSize = Math.round(noteFontSize * 0.16);
  const hasNote = noteDisplay !== null;

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
              !hasNote && styles.noteDim,
            ]}
          >
            {letter}
          </Text>
          {accidental !== '' ? (
            <Text style={[styles.accidental, { fontSize: accSize, lineHeight: accSize + 10, marginTop: Math.round(noteFontSize * 0.1) }]}>
              {accidental}
            </Text>
          ) : (
            <Text style={{ fontSize: accSize, opacity: 0 }}>{' '}</Text>
          )}
        </View>
        <Text style={[styles.octave, { fontSize: octSize, marginTop: Math.round(noteFontSize * 0.17), opacity: hasNote ? 1 : 0 }]}>
          {octave ?? ' '}
        </Text>
      </View>
      <View style={styles.hzRow}>
        <Text style={[styles.hzValue, !hasNote && styles.dimText]}>{hzText}</Text>
        <Text style={styles.hzUnit}>Hz</Text>
      </View>
      <View style={styles.centValueRow}>
        <Text style={styles.centValueLabel}>CENTS</Text>
        <Text style={[styles.centValue, !hasNote && styles.dimText]}>{centsText}</Text>
      </View>
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
  // snapping.  Settle time ~50 ms (damping 12 / stiffness 280 / mass 0.2)
  // matches the meter spring — fast enough to feel direct, slow enough to
  // smooth the discrete YIN updates into continuous motion.
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

function BottomStrip({
  fillAnim, peakAnim, rmsDb, isListening, gainMode, setGainMode,
}: {
  fillAnim: Animated.Value;
  peakAnim: Animated.Value;
  rmsDb: number;
  isListening: boolean;
  gainMode: GainMode;
  setGainMode: (m: GainMode) => void;
}) {
  return (
    <View style={styles.bottom}>
      <View style={styles.bottomLeft}>
        {/* Gain toggle */}
        <View style={styles.gainRow}>
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
    alignItems: 'baseline',
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
  instrumentBadge: { color: C.accent, fontSize: 9, letterSpacing: 2, opacity: 0.8 },
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
  gainRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  gainToggle: { flexDirection: 'row', gap: 4 },
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
  bottomLabel: { color: C.inkDim, fontSize: 10, letterSpacing: 3, marginBottom: 6 },
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

  // Permission gate
  gate: { flex: 1, paddingVertical: 32, alignItems: 'center', justifyContent: 'center' },
  gateTitle: { color: C.ink, fontSize: 16, letterSpacing: 4, marginBottom: 16 },
  gateBody: { color: C.inkMid, fontSize: 14, lineHeight: 22, textAlign: 'center', maxWidth: 480, marginBottom: 16 },
  gateHint: { color: C.inkDim, fontSize: 12, lineHeight: 18, textAlign: 'center', maxWidth: 480, letterSpacing: 1 },
  gateFooter: { alignItems: 'flex-end', borderTopColor: C.edgeSoft, borderTopWidth: 1, paddingTop: 12 },
});
