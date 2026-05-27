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
 *
 * v1.3.4 B5 — converted from `pulse` prop to a synchronous `bus.on('noteOn')`
 * subscription, eliminating the 1-frame (~16 ms) React reconciler lag that
 * the prop path incurred. The `pulse` prop is retained for backward-compat
 * but is no longer used for animation (same migration pattern as PendulumDisplay).
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';
import type { MidiBusState } from '../../useMidiBusCore';

const BEATS_OF_SIG: Record<string, number> = {
  '2/4': 2, '3/4': 3, '4/4': 4, '6/8': 6,
};

const DOT_SIZE = 12;
const DOT_GAP = 8;

export interface PulseDisplayProps {
  running: boolean;
  beat: number;
  /**
   * @deprecated since v1.3.4 — no longer drives animation; bus subscription is
   * used instead. Kept on the prop surface for backward-compat with call sites.
   * Will be removed in v1.4.
   */
  pulse: number;
  timeSig: '2/4' | '3/4' | '4/4' | '6/8';
  /**
   * v1.3.4 — bus reference for the synchronous beat subscription.
   * When absent (test harness, editor preview) animation stays idle.
   */
  bus?: MidiBusState;
}

export function PulseDisplay({ running, beat, timeSig, bus }: PulseDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  const beats = BEATS_OF_SIG[timeSig] ?? 4;

  // The lit dot pulses briefly (scale 1.0 → 1.6 → 1.0) on each beat.
  // useNativeDriver: true — scale is transform-only.
  // v1.0 — stop previous animation before starting next; at BPM ≥ 270 (4-bar
  // period ≤ 222ms) the prior 220ms tween isn't done when the next fires.
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  // v1.3.4 B5 — subscribe synchronously to bus.on('noteOn') so the dot flash
  // lands on the same JS tick as the audio attack (U21 invariant). The `pulse`
  // prop approach batched through React reconciler → ~16 ms lag.
  useEffect(() => {
    if (!running || !bus) return;
    const off = bus.on('noteOn', (evt) => {
      if (evt.channel !== 'drums') return;
      if ((evt.velocity ?? 0) <= 0) return;
      if (evt.tick === 'sub') return;
      animRef.current?.stop();
      pulseAnim.setValue(1.6);
      const a = Animated.timing(pulseAnim, { toValue: 1, duration: 220, useNativeDriver: true });
      animRef.current = a;
      a.start();
    });
    return () => {
      off();
      animRef.current?.stop();
    };
  }, [running, bus, pulseAnim]);

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
