/**
 * PulseDisplay — Boss DB-90 / school band class style metronome visual.
 *
 * A row of N dots (one per beat in the current time signature). The current
 * beat's dot fills with `C.accent` (or `C.inTune` on the downbeat); previous
 * dots fade. Plus a small centre disc that throbs on each beat — gives the
 * eye a tasteful "heartbeat" cue even from a glance.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';

const BEATS_OF_SIG: Record<string, number> = {
  '2/4': 2, '3/4': 3, '4/4': 4, '6/8': 6,
};

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

  // Throb: one Animated.Value bumped to 1 on each pulse, decays to 0.
  const throbAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!running || pulse === 0) return;
    throbAnim.setValue(1);
    Animated.timing(throbAnim, { toValue: 0, duration: 280, useNativeDriver: false }).start();
  }, [pulse, running, throbAnim]);

  return (
    <View style={styles.root}>
      <View style={styles.dotRow}>
        {Array.from({ length: beats }).map((_, i) => {
          const isActive = running && i === beat - 1;
          const isDownbeat = i === 0;
          return (
            <View
              key={i}
              style={[
                styles.dot,
                isDownbeat && styles.dotDownbeat,
                isActive && isDownbeat && styles.dotActiveDownbeat,
                isActive && !isDownbeat && styles.dotActive,
              ]}
              accessibilityRole="image"
              accessibilityLabel={`Beat ${i + 1} ${isActive ? '(now)' : ''}`}
            />
          );
        })}
      </View>

      {/* Throb disc */}
      <View style={styles.throbWrap}>
        <Animated.View
          style={[
            styles.throbDisc,
            {
              transform: [{ scale: throbAnim.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.15] }) }],
              opacity: throbAnim.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] }),
              backgroundColor: beat === 1 ? C.inTune : C.accent,
            },
          ]}
        />
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
    dotRow: { flexDirection: 'row', gap: 16, marginBottom: 16 },
    dot: {
      width: 22, height: 22, borderRadius: 11,
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderColor: C.edge,
    },
    dotDownbeat: { width: 26, height: 26, borderRadius: 13, borderColor: C.inkDim },
    dotActive: { backgroundColor: C.accent, borderColor: C.accent },
    dotActiveDownbeat: { backgroundColor: C.inTune, borderColor: C.inTune },
    throbWrap: { width: 110, height: 110, alignItems: 'center', justifyContent: 'center' },
    throbDisc: { width: 96, height: 96, borderRadius: 48 },
    label: { color: C.inkDim, fontSize: 11, letterSpacing: 3, marginTop: 6, fontWeight: '700' },
  });
}
