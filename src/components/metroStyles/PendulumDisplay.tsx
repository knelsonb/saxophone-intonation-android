/**
 * PendulumDisplay — DEFERRED. v0.9.0 ships PULSE + FLASH only.
 *
 * This stub keeps the picker honest: when the user selects "Pendulum" they
 * see a clear "coming soon" message instead of a silent fallback. When the
 * full implementation lands (vintage trapezoid body + swinging arm + tick-
 * tock animation), it replaces this stub in place.
 *
 * The mechanical-metronome visual needs accurate ±25° swing pegged to BPM,
 * and a smooth tick at the apex. That's a meaningful animation budget — the
 * spec calls for a sine-driven oscillator at exactly half-period per beat.
 * Worth doing right; not worth half-doing in the same release as three other
 * additions.
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';

export function PendulumDisplay() {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  return (
    <View style={styles.root}>
      <Text style={styles.title}>PENDULUM STYLE — COMING SOON</Text>
      <Text style={styles.body}>
        The vintage mechanical metronome visual is staged for a follow-up
        release. The metronome still keeps perfect time — only the look is
        deferred. Switch back to PULSE or FLASH in SETUP for now.
      </Text>
    </View>
  );
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: {
      borderRadius: 6,
      backgroundColor: C.face,
      borderColor: C.edge,
      borderWidth: 1,
      padding: 20,
      alignItems: 'center',
      marginBottom: 16,
    },
    title: { color: C.accent, fontSize: 12, letterSpacing: 3, fontWeight: '700', marginBottom: 8 },
    body: { color: C.inkMid, fontSize: 12, lineHeight: 18, textAlign: 'center', maxWidth: 320 },
  });
}
