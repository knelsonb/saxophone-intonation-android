/**
 * StrobeDisplay — Peterson StroboPlus emulation.
 *
 * A single group of vertical bars (period = BAR_WIDTH + BAR_GAP) is rendered
 * once and animated horizontally via `transform: translateX`. The translation
 * is driven by an Animated.loop on a single Animated.Value, which means
 * `useNativeDriver: true` works — the bar movement runs on the native UI
 * thread, free of JS-side frame drops.
 *
 * v1.3.2 rebuild (Frodo):
 *   - useNativeDriver: true (was false — JS-thread re-render per frame).
 *   - Speed envelope: piecewise so the bars don't whip past at small cents
 *     and never reverse (wagon-wheel) at large cents.
 *   - Hard-locked direction: FLAT → bars move LEFT, SHARP → bars move RIGHT.
 *   - When |cents| > 30¢, draw a subtle red tint on the side of error so
 *     the user still knows which way they're off even though speed is capped.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';
import type { NoteDisplay } from '../../tunerWidgets';

const STRIP_HEIGHT = 120;
const BAR_WIDTH = 10;
const BAR_GAP = 10;
const PERIOD = BAR_WIDTH + BAR_GAP; // 20 dp
const BAR_COUNT = 24; // enough to cover any reasonable phone width

// v1.3.2 speed envelope. Output is "periods per second" — i.e. how many
// PERIOD widths the bar pattern shifts per second. Capped at ~4 Hz so the
// eye never aliases into a backwards-moving pattern.
//   0–5¢   : gentle ramp, max 0.5 Hz at 5¢
//   5–15¢  : medium scaling, 0.5 → 2.0 Hz
//   15–30¢ : medium-fast, 2.0 → 4.0 Hz
//   30¢+   : plateau at 4.0 Hz
const SPEED_CAP_HZ = 4.0;
function centsToPeriodsPerSec(absCents: number): number {
  const c = Math.abs(absCents);
  if (c < 0.5) return 0;
  if (c <= 5)  return (c / 5) * 0.5;                       // 0 → 0.5 Hz
  if (c <= 15) return 0.5 + ((c - 5) / 10) * (2.0 - 0.5);  // 0.5 → 2.0 Hz
  if (c <= 30) return 2.0 + ((c - 15) / 15) * (SPEED_CAP_HZ - 2.0); // 2.0 → 4.0 Hz
  return SPEED_CAP_HZ;
}

export interface StrobeDisplayProps {
  noteDisplay: NoteDisplay | null;
  freqHz: number | null;
  isOutOfRange: boolean;
}

export function StrobeDisplay({ noteDisplay, freqHz, isOutOfRange }: StrobeDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  // The translateX driver. Loops continuously between two fixed endpoints
  // (one PERIOD apart in either direction); we restart the animation with
  // a new duration / direction whenever cents crosses a meaningful boundary.
  const translate = useRef(new Animated.Value(0)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);
  // Last applied (sign, speedHz) — used to skip pointless restarts.
  const lastConfigRef = useRef<{ sign: 0 | 1 | -1; speedHz: number }>({ sign: 0, speedHz: 0 });

  const cents = noteDisplay?.cents ?? 0;
  const hasNote = noteDisplay !== null;

  useEffect(() => {
    // Determine target direction + speed.
    // Direction hard-lock: FLAT (cents < 0) → translateX moves LEFT (negative);
    // SHARP (cents > 0) → translateX moves RIGHT (positive). The bars shift
    // toward "lower frequency" when flat and "higher" when sharp, matching
    // the legend.
    const speedHz = hasNote ? centsToPeriodsPerSec(cents) : 0;
    const sign: 0 | 1 | -1 = speedHz < 0.01 ? 0 : cents < 0 ? -1 : 1;

    // Skip if config unchanged (within tolerance) — avoids stutter from
    // restarting the loop on tiny cents jitter.
    const last = lastConfigRef.current;
    if (last.sign === sign && Math.abs(last.speedHz - speedHz) < 0.05) return;
    lastConfigRef.current = { sign, speedHz };

    // Stop the previous loop if any.
    if (loopRef.current) {
      loopRef.current.stop();
      loopRef.current = null;
    }
    translate.setValue(0);

    if (sign === 0) {
      // Idle — leave translate at 0 (bars stationary). No loop, no CPU.
      return;
    }

    // Duration = 1000 / speedHz ms per PERIOD. translateX goes 0 → sign*PERIOD,
    // then resets to 0 (no reverse — that would look like the bars moving
    // backward). The bar pattern is wider than the strip so the wrap is
    // visually invisible.
    const durationMs = Math.max(40, 1000 / speedHz); // floor 40ms guards div-by-zero
    const anim = Animated.loop(
      Animated.timing(translate, {
        toValue: sign * PERIOD,
        duration: durationMs,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
      { resetBeforeIteration: true },
    );
    loopRef.current = anim;
    anim.start();
  }, [cents, hasNote, translate]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (loopRef.current) {
        loopRef.current.stop();
        loopRef.current = null;
      }
    };
  }, []);

  const letter = noteDisplay?.letter ?? '—';
  const accidental = noteDisplay?.accidental ?? '';
  const octave = noteDisplay?.octave;
  const hzText = freqHz !== null ? freqHz.toFixed(1) : '— — —';
  const centsText = noteDisplay
    ? `${cents >= 0 ? '+' : ''}${cents.toFixed(noteDisplay.precision === 1.0 ? 0 : 1)}`
    : '+00';
  const centsColor =
    !hasNote || isOutOfRange ? C.inkVeryDim :
    Math.abs(cents) <= 5  ? C.inTune :
    Math.abs(cents) <= 15 ? C.accent :
                            C.sharp;

  // Side-of-error tint: when |cents| > 30, the speed is capped and the
  // motion alone may not be enough to tell direction at a glance. Add a
  // subtle red tint on the appropriate side so the user has a static cue.
  const wayOff = hasNote && !isOutOfRange && Math.abs(cents) > 30;
  const flatTint = wayOff && cents < 0;
  const sharpTint = wayOff && cents > 0;

  // Render BAR_COUNT bars at fixed positions inside an Animated.View whose
  // transform shifts the whole group. Bars start at -2*PERIOD so the leftmost
  // bars stay covered even when the group has shifted right by a full PERIOD.
  const bars: React.ReactNode[] = [];
  for (let i = -2; i < BAR_COUNT; i++) {
    bars.push(
      <View
        key={i}
        style={[styles.bar, { left: i * PERIOD, opacity: isOutOfRange ? 0.25 : 1 }]}
        pointerEvents="none"
      />,
    );
  }

  return (
    <View style={styles.root}
      accessibilityRole="image"
      accessibilityLabel={
        hasNote
          ? `Strobe tuner: ${letter}${accidental}${octave ?? ''} at ${cents >= 0 ? '+' : ''}${cents.toFixed(1)} cents.`
          : 'Strobe tuner: waiting for a note.'
      }
    >
      {/* Note letter + cents readout — compact above the strip. */}
      <View style={styles.headRow}>
        <Text style={[styles.note, !hasNote && styles.noteDim]} numberOfLines={1}>
          {letter}{accidental}
          {octave !== undefined && <Text style={styles.octave}> {octave}</Text>}
        </Text>
        <View style={styles.headRight}>
          <Text style={[styles.centsBig, { color: centsColor }]}>{centsText}<Text style={styles.centsUnit}> ¢</Text></Text>
          <Text style={styles.hz}>{hzText} Hz</Text>
        </View>
      </View>

      {/* The strobe strip itself. Bars live inside an Animated.View whose
          `transform: translateX` drives motion on the native thread. */}
      <View style={styles.strip}>
        <Animated.View
          style={[styles.barGroup, { transform: [{ translateX: translate }] }]}
          pointerEvents="none"
        >
          {bars}
        </Animated.View>
        {/* Edge fades. */}
        <View style={styles.fadeLeft} pointerEvents="none" />
        <View style={styles.fadeRight} pointerEvents="none" />
        {/* Way-off direction cue (only when |cents| > 30 and speed is capped). */}
        {flatTint  && <View style={styles.errorTintLeft}  pointerEvents="none" />}
        {sharpTint && <View style={styles.errorTintRight} pointerEvents="none" />}
        {/* Centre marker. */}
        <View style={styles.centerLine} pointerEvents="none" />
      </View>

      <View style={styles.legendRow}>
        <Text style={styles.legend}>← FLAT</Text>
        <Text style={styles.legend}>IN TUNE = STILL</Text>
        <Text style={styles.legend}>SHARP →</Text>
      </View>
    </View>
  );
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: { width: '100%', maxWidth: 720, alignSelf: 'center' },
    headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 },
    note: { color: C.ink, fontSize: 64, fontWeight: '300', letterSpacing: -2, fontVariant: ['tabular-nums'] },
    noteDim: { color: C.inkDim },
    octave: { color: C.inkMid, fontSize: 24 },
    headRight: { alignItems: 'flex-end' },
    centsBig: { fontSize: 28, fontWeight: '700', letterSpacing: 1, fontVariant: ['tabular-nums'] },
    centsUnit: { fontSize: 16, fontWeight: '400', color: C.inkDim },
    hz: { color: C.inkMid, fontSize: 12, letterSpacing: 2, marginTop: 2, fontVariant: ['tabular-nums'] },

    strip: {
      height: STRIP_HEIGHT,
      backgroundColor: C.face,
      borderColor: C.edge,
      borderWidth: 1,
      borderRadius: 4,
      overflow: 'hidden',
      position: 'relative',
    },
    barGroup: {
      // Fills the strip — bars are positioned absolutely inside it. The
      // Animated transform shifts the whole group together so the native
      // driver moves a single view rather than 26.
      position: 'absolute',
      top: 0, bottom: 0, left: 0, right: 0,
    },
    bar: {
      position: 'absolute',
      top: 8,
      bottom: 8,
      width: BAR_WIDTH,
      backgroundColor: C.accent,
      borderRadius: 1,
    },
    fadeLeft: {
      position: 'absolute',
      top: 0, bottom: 0, left: 0, width: 40,
      backgroundColor: C.face,
      opacity: 0.75,
    },
    fadeRight: {
      position: 'absolute',
      top: 0, bottom: 0, right: 0, width: 40,
      backgroundColor: C.face,
      opacity: 0.75,
    },
    // Side-of-error cue — only rendered when |cents| > 30. Sharp colour at
    // low opacity so it tints the edge without competing with the bars.
    errorTintLeft: {
      position: 'absolute',
      top: 0, bottom: 0, left: 0, width: 60,
      backgroundColor: C.sharp,
      opacity: 0.18,
    },
    errorTintRight: {
      position: 'absolute',
      top: 0, bottom: 0, right: 0, width: 60,
      backgroundColor: C.sharp,
      opacity: 0.18,
    },
    centerLine: {
      position: 'absolute',
      top: 0, bottom: 0, left: '50%', width: 1,
      backgroundColor: C.inkMid,
      opacity: 0.5,
    },
    legendRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
    legend: { color: C.inkDim, fontSize: 10, letterSpacing: 2, fontWeight: '600' },
  });
}
