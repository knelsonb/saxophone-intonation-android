/**
 * LedRowDisplay — Boss TU-3 / Korg TM-60 style stage-tuner LED row.
 *
 * 11 dots: index 0 is far flat, 5 is centre/in-tune, 10 is far sharp. The
 * selected LED lights at full opacity; its immediate neighbours render at
 * 35 %; the rest are very dim. Colour at the centre is `inTune`, flat
 * side is `flat`, sharp side is `sharp`.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';
import type { NoteDisplay } from '../../tunerWidgets';

const LED_COUNT = 11;
const LED_RANGE_CENTS = 25;
const LED_DIAMETER = 24;
const LED_GAP = 18;

export interface LedRowDisplayProps {
  noteDisplay: NoteDisplay | null;
  freqHz: number | null;
  noteFontSize: number;
  isOutOfRange: boolean;
}

function centsToLedIndex(c: number): number {
  const clamped = Math.max(-LED_RANGE_CENTS, Math.min(LED_RANGE_CENTS, c));
  // Map [-25, +25] → [0, 10]
  return Math.round(((clamped + LED_RANGE_CENTS) / (2 * LED_RANGE_CENTS)) * (LED_COUNT - 1));
}

export function LedRowDisplay({ noteDisplay, freqHz, noteFontSize, isOutOfRange }: LedRowDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  const hasNote = noteDisplay !== null;
  const oor = isOutOfRange && hasNote;
  const cents = noteDisplay?.cents ?? 0;
  const litIndex = hasNote ? centsToLedIndex(cents) : -1;

  // 50ms fade animation on the lit LED — smooth transition when cents
  // crosses a boundary. Each LED has its own Animated value.
  const ledAnimsRef = useRef<Animated.Value[]>(
    Array.from({ length: LED_COUNT }, () => new Animated.Value(0)),
  );
  useEffect(() => {
    ledAnimsRef.current.forEach((v, i) => {
      let target = 0;
      if (i === litIndex) target = 1;
      else if (Math.abs(i - litIndex) === 1) target = 0.35;
      Animated.timing(v, { toValue: target, duration: 50, useNativeDriver: false }).start();
    });
  }, [litIndex]);

  const letter = noteDisplay?.letter ?? '—';
  const accidental = noteDisplay?.accidental ?? '';
  const octave = noteDisplay?.octave;
  const hzText = freqHz !== null ? freqHz.toFixed(1) : '— — —';
  const centsText = noteDisplay
    ? `${cents >= 0 ? '+' : ''}${cents.toFixed(noteDisplay.precision === 1.0 ? 0 : 1)}`
    : '+00';

  const inTuneIndex = Math.floor(LED_COUNT / 2); // 5

  // Colour per LED — flat dots use flat colour, centre uses inTune, sharp
  // dots use sharp. This lets the row read at a glance even before you
  // notice which one is the brightest.
  const ledColor = (i: number) => {
    if (oor) return C.inkVeryDim;
    if (i === inTuneIndex) return C.inTune;
    return i < inTuneIndex ? C.flat : C.sharp;
  };

  // Big note + cents readout above the LEDs.
  const centsColor =
    !hasNote || oor   ? C.inkVeryDim :
    Math.abs(cents) <= 5  ? C.inTune :
    Math.abs(cents) <= 15 ? C.accent :
                            C.sharp;

  return (
    <View
      style={styles.root}
      accessibilityRole="image"
      accessibilityLabel={
        hasNote
          ? `LED tuner: ${letter}${accidental}${octave}, ${cents >= 0 ? '+' : ''}${cents.toFixed(1)} cents${oor ? ', out of range' : ''}.`
          : 'LED tuner: waiting for a note.'
      }
    >
      <View style={styles.bigNoteRow}>
        <Text style={[styles.bigNote, { fontSize: noteFontSize }, !hasNote && styles.bigNoteDim]} numberOfLines={1}>
          {letter}
          <Text style={styles.bigAccidental}>{accidental}</Text>
          {octave !== undefined && <Text style={styles.bigOctave}>{'  '}{octave}</Text>}
        </Text>
      </View>

      <Text style={[styles.cents, { color: centsColor }]}>
        {centsText}<Text style={styles.centsUnit}> ¢</Text>
      </Text>

      {/* The LED row */}
      <View style={styles.row}>
        {ledAnimsRef.current.map((v, i) => (
          <Animated.View
            key={i}
            style={[
              styles.led,
              i === inTuneIndex && styles.ledCenter,
              {
                backgroundColor: ledColor(i),
                opacity: v.interpolate({
                  inputRange: [0, 0.35, 1],
                  outputRange: [0.12, 0.45, 1],
                }),
              },
            ]}
          />
        ))}
      </View>

      <View style={styles.baselineWrap}>
        <View style={styles.baseline} />
        <View style={styles.baselineCenterTick} />
      </View>

      <View style={styles.legendRow}>
        <Text style={styles.legend}>−25¢</Text>
        <Text style={styles.legend}>0¢</Text>
        <Text style={styles.legend}>+25¢</Text>
      </View>

      <Text style={styles.hz}>{hzText} Hz</Text>
    </View>
  );
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: { alignItems: 'center', paddingHorizontal: 8 },
    bigNoteRow: { flexDirection: 'row', justifyContent: 'center' },
    bigNote: {
      color: C.ink,
      fontWeight: '300',
      letterSpacing: -2,
      fontVariant: ['tabular-nums'],
      textAlign: 'center',
    },
    bigNoteDim: { color: C.inkDim },
    bigAccidental: { color: C.inkMid, fontSize: 56 },
    bigOctave: { color: C.inkDim, fontSize: 24 },
    cents: { fontSize: 28, fontWeight: '700', letterSpacing: 1, fontVariant: ['tabular-nums'], marginTop: 4, marginBottom: 12 },
    centsUnit: { fontSize: 16, fontWeight: '400', color: C.inkDim },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: LED_GAP,
      marginTop: 4,
    },
    led: {
      width: LED_DIAMETER,
      height: LED_DIAMETER,
      borderRadius: LED_DIAMETER / 2,
    },
    ledCenter: { width: LED_DIAMETER + 4, height: LED_DIAMETER + 4, borderRadius: (LED_DIAMETER + 4) / 2 },
    baselineWrap: {
      width: '100%',
      maxWidth: (LED_DIAMETER + LED_GAP) * LED_COUNT,
      marginTop: 8,
      height: 6,
      position: 'relative',
    },
    baseline: {
      position: 'absolute',
      left: '5%', right: '5%',
      top: 2,
      height: 1,
      backgroundColor: C.edge,
    },
    baselineCenterTick: {
      position: 'absolute',
      left: '50%',
      top: 0,
      width: 2,
      height: 6,
      marginLeft: -1,
      backgroundColor: C.inkMid,
    },
    legendRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: '100%',
      maxWidth: (LED_DIAMETER + LED_GAP) * LED_COUNT,
      marginTop: 6,
      paddingHorizontal: 4,
    },
    legend: { color: C.inkDim, fontSize: 10, letterSpacing: 2, fontWeight: '600' },
    hz: { color: C.inkMid, fontSize: 14, letterSpacing: 2, marginTop: 8, fontVariant: ['tabular-nums'] },
  });
}
