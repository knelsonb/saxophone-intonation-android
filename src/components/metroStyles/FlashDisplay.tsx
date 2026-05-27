/**
 * FlashDisplay — visibility-at-distance metronome. The whole content area
 * flashes a colour on each beat. Downbeat = full `C.inTune`, off-beats =
 * `C.accent`. Each flash decays linearly over half a beat. Designed for the
 * band director standing at the back of the rehearsal room.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
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

  // v0.9.8 flash rebuild:
  //   • Peak opacity goes to 1.0 (was 0.85 — the background bled through
  //     and the flash never read as ON across the room).
  //   • Color is SNAPSHOTTED inside the effect so we can't race the next
  //     beat's color into the current decay tween. Previously
  //     `beat === 1 ? inTune : accent` was read at render time and could
  //     swap mid-fade when pulse advanced before the beat re-render landed.
  //   • Easing.out(Easing.quad) front-loads brightness — bright snap, sharp
  //     cut — replacing the gentle linear dissolve that read as a pulse.
  // useNativeDriver: true (opacity transform only).
  const flashAnim = useRef(new Animated.Value(0)).current;
  const flashColorRef = useRef(C.accent);
  const [flashBg, setFlashBg] = React.useState(C.accent);
  useEffect(() => {
    if (!running || pulse === 0) return;
    const color = beat === 1 ? C.inTune : C.accent;
    flashColorRef.current = color;
    setFlashBg(color);
    flashAnim.setValue(1);
    Animated.timing(flashAnim, {
      toValue: 0,
      duration: halfBeatMs,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulse, running, halfBeatMs, flashAnim]);

  const opacityInterp = flashAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

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
