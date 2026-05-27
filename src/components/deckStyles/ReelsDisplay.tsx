/**
 * ReelsDisplay — twin reel-to-reel spools. Spins clockwise at a constant
 * rpm whenever the deck is recording or playing. Stops when idle/paused.
 *
 * The "3D" feel comes from the spoke lines — three short radii inside each
 * reel rotate with the body, so the spin reads even at a glance.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';

const REEL_RPM = 33; // close enough to a 33-1/3 LP for visual familiarity.

function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export interface ReelsDisplayProps {
  spinning: boolean;
  clockSec: number;
  statusLine: string;
  highlightClock: boolean;
}

export function ReelsDisplay({ spinning, clockSec, statusLine, highlightClock }: ReelsDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  const spinAnim = useRef(new Animated.Value(0)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);
  useEffect(() => {
    // Spin loop. Active only while `spinning` is true; otherwise hold the
    // value where it is so the next start picks up from there.
    if (spinning) {
      const loop = Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: (60 / REEL_RPM) * 1000,
          easing: Easing.linear,
          useNativeDriver: false,
        }),
      );
      loopRef.current = loop;
      loop.start();
      return () => {
        loop.stop();
        loopRef.current = null;
      };
    } else if (loopRef.current) {
      loopRef.current.stop();
      loopRef.current = null;
    }
    return undefined;
  }, [spinning, spinAnim]);

  const rotateInterp = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const renderReel = (label: string) => (
    <View style={styles.reelWrap}>
      <Animated.View style={[styles.reel, { transform: [{ rotate: rotateInterp }] }]}>
        {/* Outer ring */}
        <View style={styles.reelRing} />
        {/* Spokes — three diameters at 0°, 60°, 120° (rendered as rotated rects). */}
        <View style={[styles.spoke, { transform: [{ rotate: '0deg' }] }]} />
        <View style={[styles.spoke, { transform: [{ rotate: '60deg' }] }]} />
        <View style={[styles.spoke, { transform: [{ rotate: '120deg' }] }]} />
        {/* Hub */}
        <View style={styles.hub} />
      </Animated.View>
      <Text style={styles.reelLabel}>{label}</Text>
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={styles.reelsRow}>
        {renderReel('SUPPLY')}
        <View style={styles.tapeLine} />
        {renderReel('TAKE-UP')}
      </View>
      <Text style={[styles.clock, highlightClock && styles.clockRecording]}>{mmss(clockSec)}</Text>
      <Text style={styles.status}>{statusLine}</Text>
    </View>
  );
}

function makeStyles(C: ThemePalette) {
  const REEL = 100;
  return StyleSheet.create({
    root: { alignItems: 'center', marginTop: 8, marginBottom: 8 },
    reelsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24, marginBottom: 12 },
    reelWrap: { alignItems: 'center' },
    reel: {
      width: REEL,
      height: REEL,
      borderRadius: REEL / 2,
      backgroundColor: C.bg,
      borderColor: C.edge,
      borderWidth: 2,
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
    },
    reelRing: {
      position: 'absolute',
      width: REEL - 16,
      height: REEL - 16,
      borderRadius: (REEL - 16) / 2,
      borderColor: C.inkDim,
      borderWidth: 1,
    },
    spoke: {
      position: 'absolute',
      width: REEL - 24,
      height: 2,
      backgroundColor: C.inkMid,
      opacity: 0.6,
    },
    hub: {
      width: 14, height: 14, borderRadius: 7,
      backgroundColor: C.accent,
    },
    reelLabel: { color: C.inkDim, fontSize: 9, letterSpacing: 2, fontWeight: '700', marginTop: 4 },
    tapeLine: { width: 56, height: 2, backgroundColor: C.inkDim, opacity: 0.4 },

    clock: { color: C.ink, fontSize: 40, fontWeight: '300', letterSpacing: 4, fontVariant: ['tabular-nums'], marginTop: 4 },
    clockRecording: { color: C.sharp },
    status: { color: C.inkDim, fontSize: 11, letterSpacing: 2, marginTop: 4, fontWeight: '700' },
  });
}
