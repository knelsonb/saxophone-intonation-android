/**
 * PendulumDisplay — Wittner-style vintage mechanical metronome.
 *
 * A trapezoid body sits below a swinging arm with a small weight bead near
 * the top. The arm pivots from a point inside the body and swings ±26° at
 * the BPM rate. Each beat coincides with the arm reaching one of its two
 * extremes — the visual "tick" lands on the audio click.
 *
 * Timing model: each `pulse` increment fires an Animated.timing from the
 * current side (-1 or +1) to the opposite. Duration = 60000 / bpm ms, so the
 * arm reaches the new extreme exactly as the next pulse fires. We use
 * `Easing.inOut(Easing.sin)` for a natural pendulum feel — slow at the
 * extremes, fast at the centre.
 *
 * `useNativeDriver: true` — rotation is a transform-only animation so the
 * arm can be driven on the UI thread, keeping the apex phase honest against
 * the calibration math in useMetronome.ts.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';

const SWING_DEG = 26;
const ARM_HEIGHT = 130;
const ARM_WIDTH = 3;
const BEAD_SIZE = 18;
const BEAD_FROM_TOP = 18;

const BODY_BASE_W = 130;
const BODY_TOP_W = 70;
const BODY_H = 70;

const PIVOT_FROM_BODY_TOP = 6;

export interface PendulumDisplayProps {
  running: boolean;
  beat: number;
  pulse: number;
  bpm: number;
}

export function PendulumDisplay({ running, beat, pulse, bpm }: PendulumDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  // -1 = left extreme, +1 = right extreme. Held across renders.
  const armAnim = useRef(new Animated.Value(1)).current;
  const sideRef = useRef<1 | -1>(1);

  // Swing on every pulse increment. Duration matches the beat interval so
  // the arm lands at the next extreme just as the click sounds.
  useEffect(() => {
    if (!running || pulse === 0) return;
    sideRef.current = sideRef.current === 1 ? -1 : 1;
    const dur = Math.max(60, 60000 / Math.max(1, bpm));
    Animated.timing(armAnim, {
      toValue: sideRef.current,
      duration: dur,
      easing: Easing.inOut(Easing.sin),
      useNativeDriver: true,
    }).start();
  }, [pulse, running, bpm, armAnim]);

  // When the user stops the metronome, settle the arm back to vertical so
  // the visual rest state isn't tilted.
  useEffect(() => {
    if (!running) {
      sideRef.current = 1;
      Animated.timing(armAnim, {
        toValue: 0,
        duration: 400,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [running, armAnim]);

  const armRotation = armAnim.interpolate({
    inputRange: [-1, 1],
    outputRange: [`-${SWING_DEG}deg`, `${SWING_DEG}deg`],
  });

  return (
    <View style={styles.root}>
      <View style={styles.frame} accessibilityRole="image" accessibilityLabel={running ? `Mechanical metronome swinging at ${bpm} beats per minute` : 'Mechanical metronome (idle)'}>
        {/* Pendulum arm + weight. Wrapped in an outer View whose top sits at
            the pivot; the arm rotates around that wrapper's top edge by
            virtue of being anchored there. transformOrigin: 'top center'. */}
        <Animated.View
          style={[styles.armWrap, { transform: [{ rotate: armRotation }] }]}
        >
          <View style={styles.arm} />
          <View style={styles.weight} />
        </Animated.View>

        {/* Trapezoid body (drawn with the standard RN border trick — a View
            with zero width and angled left/right borders forms the sides). */}
        <View style={styles.body}>
          <View style={styles.bodyTopCap} />
          <View style={styles.pivotDot} />
        </View>
      </View>

      <Text style={styles.label}>
        {running ? `BEAT ${beat}` : 'STOPPED'}
      </Text>
    </View>
  );
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: { alignItems: 'center', marginTop: 8, marginBottom: 12 },

    frame: {
      width: 200,
      height: ARM_HEIGHT + BODY_H + 12,
      alignItems: 'center',
      justifyContent: 'flex-end',
    },

    // Arm wrapper — pivot is its TOP-CENTER. transformOrigin shifts the
    // rotation centre so the swing pivots from the apex of the body rather
    // than the centre of the View.
    armWrap: {
      position: 'absolute',
      top: ARM_HEIGHT - PIVOT_FROM_BODY_TOP,
      width: ARM_WIDTH * 4,
      height: ARM_HEIGHT,
      alignItems: 'center',
      transformOrigin: 'top center',
    },
    arm: {
      width: ARM_WIDTH,
      height: ARM_HEIGHT - BEAD_SIZE - 4,
      backgroundColor: C.inkMid,
      borderRadius: ARM_WIDTH / 2,
      position: 'absolute',
      top: BEAD_SIZE / 2,
      left: (ARM_WIDTH * 4 - ARM_WIDTH) / 2,
    },
    weight: {
      width: BEAD_SIZE,
      height: BEAD_SIZE,
      borderRadius: 3,
      backgroundColor: C.accent,
      position: 'absolute',
      top: BEAD_FROM_TOP,
      left: (ARM_WIDTH * 4 - BEAD_SIZE) / 2,
      borderWidth: 1,
      borderColor: C.edge,
    },

    // The trapezoid is rendered by overlaying two pieces: a wider rectangle
    // base + a narrower cap on top. With contrasting widths and aligned
    // centers it reads as a trapezoid silhouette without needing the (less
    // portable) borderTopWidth trick.
    body: {
      width: BODY_BASE_W,
      height: BODY_H,
      backgroundColor: C.face,
      borderColor: C.edge,
      borderWidth: 1,
      borderTopLeftRadius: 0,
      borderTopRightRadius: 0,
      borderBottomLeftRadius: 4,
      borderBottomRightRadius: 4,
      alignItems: 'center',
    },
    bodyTopCap: {
      position: 'absolute',
      top: -1,
      width: BODY_TOP_W,
      height: 14,
      backgroundColor: C.face,
      borderTopColor: C.edge,
      borderLeftColor: C.edge,
      borderRightColor: C.edge,
      borderTopWidth: 1,
      borderLeftWidth: 1,
      borderRightWidth: 1,
      borderTopLeftRadius: 4,
      borderTopRightRadius: 4,
    },
    pivotDot: {
      position: 'absolute',
      top: 8,
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: C.accent,
    },

    label: { color: C.inkDim, fontSize: 11, letterSpacing: 3, marginTop: 6, fontWeight: '700' },
  });
}
