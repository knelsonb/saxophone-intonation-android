/**
 * VuDisplay — DEFERRED. v0.9.0 ships REELS + WAVEFORM only.
 *
 * The analog VU-meter visual wants two physical-feel needles whose ballistics
 * respond to live RMS during record and to a sampled playback envelope. That
 * requires hooking `useAudioSampleListener` for playback and decoupling the
 * meter physics from React state — it's a meaningful chunk of work and not
 * worth half-building in the same release as the rest of this batch.
 *
 * When the full implementation lands it replaces this stub in place without
 * any other call-site changes.
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';

export function VuDisplay() {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  return (
    <View style={styles.root}>
      <Text style={styles.title}>VU METER STYLE — COMING SOON</Text>
      <Text style={styles.body}>
        Analog VU needles with bouncing ballistics are staged for a follow-up
        release — the recorder still works exactly the same; only this look
        is on hold. Switch back to REELS or WAVEFORM in SETUP for now.
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
