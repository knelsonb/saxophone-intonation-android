/**
 * PendulumDisplay — Wittner pyramid metronome.
 *
 * v0.9.8 rebuild after a fidelity review found three breakages:
 *   1. The pivot was rendered ABOVE the body, so the arm appeared to hang
 *      in mid-air. A real Wittner has the pivot embedded ~12dp INSIDE the
 *      body's top edge — the arm visibly emerges from a pivot hole in the
 *      body.
 *   2. Body-to-arm ratio was 1:2 (small body, tall stick) — a real Wittner
 *      is body-dominant (the pyramid mass is the visual anchor; the arm
 *      protrudes above by maybe 60-80% of the body height).
 *   3. The "trapezoid" was a rectangle with a smaller rectangle cap —
 *      visibly stepped, not tapered. We now stack 6 progressively narrower
 *      slats to give a proper tapered silhouette without an SVG dep.
 *
 * Geometry (numbers in display-pixels):
 *   frame:   220 × 180
 *   body:    six 14dp slats, widths 150/130/110/95/80/65 (bottom → top)
 *            → body height 84dp, base 150dp, top 65dp
 *   pivot:   12dp inside the top of the body, accent-colored
 *   arm:     starts at pivot, extends ~90dp upward (visible above body
 *            ~ 78dp, i.e. ~93% of body height — close to 1:1 protrusion)
 *   weight:  18dp bead, ~14dp below the top of the arm
 *
 * Timing model unchanged from prior: each `pulse` increment fires an
 * Animated.timing toward the opposite extreme over one beat interval
 * (60000/bpm ms), with Easing.inOut(Easing.sin) for a natural pendulum
 * feel. useNativeDriver: true.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';

const SWING_DEG = 26;

// Body — 6 slats stacked bottom (widest) → top (narrowest).
const SLAT_H = 14;
const SLAT_WIDTHS = [150, 130, 110, 95, 80, 65];
const BODY_H = SLAT_H * SLAT_WIDTHS.length; // 84dp

// Pivot lives 12dp inside the body from its top edge.
const PIVOT_FROM_BODY_TOP = 12;

// Arm length from the pivot upward.
const ARM_H = 96;
const ARM_W = 4;
const BEAD_SIZE = 18;
const BEAD_FROM_ARM_TOP = 14;

const FRAME_W = 220;
const FRAME_H = ARM_H + BODY_H - PIVOT_FROM_BODY_TOP + 4;

export interface PendulumDisplayProps {
  running: boolean;
  beat: number;
  pulse: number;
  bpm: number;
}

export function PendulumDisplay({ running, beat, pulse, bpm }: PendulumDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  // -1 = left extreme, +1 = right extreme.
  // v1.0 — derive side from `pulse` parity instead of a local toggle ref.
  // `pulse` is monotonically increasing and never resets — survives stop/
  // resume cleanly, robust across odd time sigs (unlike `beat` which resets
  // each bar). Convention: first pulse (1) = RIGHT (+1), then alternate.
  const armAnim = useRef(new Animated.Value(1)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  const restAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (!running || pulse === 0) return;
    animRef.current?.stop();
    restAnimRef.current?.stop();
    const side: 1 | -1 = pulse % 2 === 1 ? 1 : -1;
    const dur = Math.max(60, 60000 / Math.max(1, bpm));
    const a = Animated.timing(armAnim, {
      toValue: side,
      duration: dur,
      easing: Easing.inOut(Easing.sin),
      useNativeDriver: true,
    });
    animRef.current = a;
    a.start();
    return () => { animRef.current?.stop(); };
  }, [pulse, running, bpm, armAnim]);

  useEffect(() => {
    if (!running) {
      // Stop any in-flight swing, then ease the arm back to centre.
      animRef.current?.stop();
      restAnimRef.current?.stop();
      const a = Animated.timing(armAnim, {
        toValue: 0,
        duration: 400,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      });
      restAnimRef.current = a;
      a.start();
    }
  }, [running, armAnim]);

  const armRotation = armAnim.interpolate({
    inputRange: [-1, 1],
    outputRange: [`-${SWING_DEG}deg`, `${SWING_DEG}deg`],
  });

  return (
    <View style={styles.root}>
      <View
        style={styles.frame}
        accessibilityRole="image"
        accessibilityLabel={running
          ? `Mechanical metronome swinging at ${bpm} beats per minute`
          : 'Mechanical metronome (idle)'}
      >
        {/* Body — six tapered slats. Rendered first so the arm draws on
            top. The slats are absolute-positioned to stack from the
            bottom of the frame upward. */}
        {SLAT_WIDTHS.map((w, i) => (
          <View
            key={i}
            style={[
              styles.slat,
              {
                width: w,
                bottom: i * SLAT_H,
              },
            ]}
          />
        ))}

        {/* Arm wrap. Bottom of wrap sits at the pivot location. Rotation
            origin is the bottom-center, so the arm pivots around that
            point. Arm and weight live inside the wrap, anchored at its
            bottom — they extend UPWARD as the wrap's content. */}
        <Animated.View
          style={[
            styles.armWrap,
            {
              bottom: BODY_H - PIVOT_FROM_BODY_TOP,
              transform: [{ rotate: armRotation }],
            },
          ]}
        >
          <View style={styles.arm} />
          <View style={styles.weight} />
        </Animated.View>

        {/* Pivot dot — drawn on top of the body so it's visible. */}
        <View
          style={[
            styles.pivotDot,
            { bottom: BODY_H - PIVOT_FROM_BODY_TOP - 4 },
          ]}
        />
      </View>

      <Text style={styles.label}>{running ? `BEAT ${beat}` : 'STOPPED'}</Text>
    </View>
  );
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: { alignItems: 'center', marginTop: 8, marginBottom: 12 },

    frame: {
      width: FRAME_W,
      height: FRAME_H,
      alignItems: 'center',
      justifyContent: 'flex-end',
      position: 'relative',
    },

    slat: {
      position: 'absolute',
      height: SLAT_H,
      backgroundColor: C.face,
      borderColor: C.edge,
      borderTopWidth: 1,
      borderLeftWidth: 1,
      borderRightWidth: 1,
      // No bottom border on intermediate slats — the slat below covers
      // the seam, giving a continuous body silhouette.
    },

    // Wrap is a thin, tall container whose BOTTOM lives at the pivot. The
    // arm and bead are children that lay out from the bottom upward.
    // transformOrigin shifts the rotation centre to the bottom-center.
    armWrap: {
      position: 'absolute',
      width: ARM_W * 4,
      height: ARM_H,
      alignItems: 'center',
      transformOrigin: 'bottom center',
    },
    arm: {
      position: 'absolute',
      bottom: 0,
      width: ARM_W,
      height: ARM_H - 2,
      backgroundColor: C.inkMid,
      borderRadius: ARM_W / 2,
      left: (ARM_W * 4 - ARM_W) / 2,
    },
    weight: {
      position: 'absolute',
      top: BEAD_FROM_ARM_TOP,
      width: BEAD_SIZE,
      height: BEAD_SIZE * 0.7,
      borderRadius: 3,
      backgroundColor: C.accent,
      borderWidth: 1,
      borderColor: C.edge,
      left: (ARM_W * 4 - BEAD_SIZE) / 2,
    },

    pivotDot: {
      position: 'absolute',
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: C.accent,
      borderWidth: 1,
      borderColor: C.bg,
    },

    label: { color: C.inkDim, fontSize: 11, letterSpacing: 3, marginTop: 6, fontWeight: '700' },
  });
}
