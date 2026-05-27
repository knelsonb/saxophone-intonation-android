/**
 * PulseDisplay — Boss DB-90 / school band class style metronome visual.
 *
 * v0.9.8 rebuild: the previous version had a row of dots AND a separate
 * pulsing disc, which created two competing visual signals. A real DB-90
 * lights ONE dot per beat — the lit dot IS the beat. We dropped the disc
 * entirely; the dot just scales briefly on activation as a "blink."
 *
 * Dots are 12dp with 8dp gaps (tightly grouped, like real hardware LEDs).
 * The downbeat dot is the SAME size as the others; differentiation is
 * COLOR ONLY (inTune green vs accent amber). The prior 26-vs-22 size
 * caused the row to shift horizontally between beats 1 and 2-N — a layout
 * jitter that read as a bug.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';

const BEATS_OF_SIG: Record<string, number> = {
  '2/4': 2, '3/4': 3, '4/4': 4, '6/8': 6,
};

const DOT_SIZE = 12;
const DOT_GAP = 8;

export interface PulseDisplayProps {
  running: boolean;
  beat: number;
  pulse: number;
  timeSig: '2/4' | '3/4' | '4/4' | '6/8';
}

export function PulseDisplay({ running, beat, pulse, timeSig }: PulseDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  const beats = BEATS_OF_SIG[timeSig] ?? 4;

  // The lit dot pulses briefly (scale 1.0 → 1.6 → 1.0) on each beat.
  // useNativeDriver: true — scale is transform-only.
  // v1.0 — stop previous animation before starting next; at BPM ≥ 270 (4-bar
  // period ≤ 222ms) the prior 220ms tween isn't done when the next fires.
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  useEffect(() => {
    if (!running || pulse === 0) return;
    animRef.current?.stop();
    pulseAnim.setValue(1.6);
    const a = Animated.timing(pulseAnim, { toValue: 1, duration: 220, useNativeDriver: true });
    animRef.current = a;
    a.start();
    return () => { animRef.current?.stop(); };
  }, [pulse, running, pulseAnim]);

  return (
    <View style={styles.root}>
      <View style={styles.dotRow}>
        {Array.from({ length: beats }).map((_, i) => {
          const isActive = running && i === beat - 1;
          const isDownbeat = i === 0;
          const activeColor = isDownbeat ? C.inTune : C.accent;
          return (
            <Animated.View
              key={i}
              style={[
                styles.dot,
                isActive && { backgroundColor: activeColor, borderColor: activeColor, transform: [{ scale: pulseAnim }] },
              ]}
              accessibilityRole="image"
              accessibilityLabel={`Beat ${i + 1}${isActive ? ' (now)' : ''}`}
            />
          );
        })}
      </View>

      <Text style={styles.label}>
        {running ? `BEAT ${beat} / ${beats}` : 'STOPPED'}
      </Text>
    </View>
  );
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: { alignItems: 'center', marginTop: 8, marginBottom: 12 },
    dotRow: { flexDirection: 'row', gap: DOT_GAP, marginBottom: 16 },
    dot: {
      width: DOT_SIZE, height: DOT_SIZE, borderRadius: DOT_SIZE / 2,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderColor: C.edge,
    },
    label: { color: C.inkDim, fontSize: 11, letterSpacing: 3, marginTop: 6, fontWeight: '700' },
  });
}
