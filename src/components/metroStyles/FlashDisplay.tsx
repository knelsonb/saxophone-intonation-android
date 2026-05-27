/**
 * FlashDisplay — visibility-at-distance metronome. The whole content area
 * flashes a colour on each beat. Downbeat = full `C.inTune`, off-beats =
 * `C.accent`. Each flash decays linearly over half a beat. Designed for the
 * band director standing at the back of the rehearsal room.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';

export interface FlashDisplayProps {
  running: boolean;
  beat: number;
  pulse: number;
  bpm: number;
  timeSig: '2/4' | '3/4' | '4/4' | '6/8';
}

export function FlashDisplay({ running, beat, pulse, bpm, timeSig }: FlashDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  const halfBeatMs = Math.max(50, Math.min(1000, (60000 / Math.max(1, bpm)) * 0.5));

  const flashAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!running || pulse === 0) return;
    flashAnim.setValue(1);
    Animated.timing(flashAnim, { toValue: 0, duration: halfBeatMs, useNativeDriver: false }).start();
  }, [pulse, running, halfBeatMs, flashAnim]);

  const flashBg = beat === 1 ? C.inTune : C.accent;
  const opacityInterp = flashAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.85] });

  return (
    <View style={styles.root}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          styles.flashPanel,
          { backgroundColor: flashBg, opacity: opacityInterp },
        ]}
        accessibilityRole="image"
        accessibilityLabel={running ? `Beat ${beat} flash` : 'Stopped'}
      />
      <View style={styles.center}>
        <Text style={styles.beatLabel}>{running ? beat : '·'}</Text>
        <Text style={styles.sigLabel}>{timeSig}</Text>
      </View>
    </View>
  );
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: {
      height: 240,
      borderRadius: 6,
      backgroundColor: C.face,
      borderColor: C.edge,
      borderWidth: 1,
      overflow: 'hidden',
      marginBottom: 16,
      position: 'relative',
    },
    flashPanel: {
      borderRadius: 6,
    },
    center: {
      position: 'absolute',
      top: 0, left: 0, right: 0, bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    beatLabel: { color: C.ink, fontSize: 96, fontWeight: '300', letterSpacing: 4, fontVariant: ['tabular-nums'] },
    sigLabel: { color: C.inkDim, fontSize: 14, letterSpacing: 4, fontWeight: '700', marginTop: 4 },
  });
}
