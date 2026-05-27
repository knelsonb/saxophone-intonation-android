/**
 * ReelsDisplay — twin reel-to-reel spools (Studer / Otari / Tascam analog).
 *
 * v0.9.8 fidelity pass:
 *   • Reels now ASYMMETRIC. The supply hub-fill SHRINKS as playback /
 *     recording progresses; the take-up hub-fill GROWS. Without
 *     differential fill the two reels read as identical spinner widgets.
 *   • Tape path between reels gets a small head-block + two guide pins so
 *     it reads as "tape across the heads" instead of a connector line.
 *   • Each reel has a proper NAB hub structure: outer flange ring, an
 *     inner NAB hub adapter ring, and the visible tape-fill area between
 *     them. (Previously just one faint construction ring at 84dp.)
 *
 * Two behaviours stitched together:
 *   1. Spinning (recording / playing) — Animated.loop turns at ~33 rpm.
 *   2. Idle / paused — rotation derived directly from `clockSec` so
 *      scrubbing the playback bar jogs the reels in lockstep.
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
  /** Optional total duration for asymmetric supply/take-up fill. When
   *  null (e.g., during recording), both reels render at ~50% fill. */
  durationSec?: number | null;
  statusLine: string;
  highlightClock: boolean;
}

export function ReelsDisplay({ spinning, clockSec, durationSec, statusLine, highlightClock }: ReelsDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  const spinAnim = useRef(new Animated.Value(0)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);
  useEffect(() => {
    if (spinning) {
      const loop = Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: (60 / REEL_RPM) * 1000,
          easing: Easing.linear,
          useNativeDriver: true,
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

  // Jog-on-scrub: snap rotation to clockSec when paused.
  useEffect(() => {
    if (spinning) return;
    const phase = ((clockSec * REEL_RPM) / 60) % 1;
    spinAnim.setValue(phase < 0 ? phase + 1 : phase);
  }, [spinning, clockSec, spinAnim]);

  const rotateInterp = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // Differential reel-fill computation. progress in [0, 1] — fraction of
  // tape that has moved from supply to take-up.
  const progress = (durationSec !== null && durationSec !== undefined && durationSec > 0)
    ? Math.max(0, Math.min(1, clockSec / durationSec))
    : 0.5;
  // Tape fills the area between the NAB hub (28dp) and the outer flange
  // (84dp inner). Supply starts FULL (1.0) and shrinks; take-up starts
  // EMPTY (0.0) and grows. The visible "fill ring" thickness is
  // proportional to (1 - fill) on a normalized [0,1] axis where 1 = full.
  // We render this with a darker overlay disc whose diameter shows how
  // much hub area is currently un-wound (the inner light area = the
  // empty portion).
  const supplyFillRatio = 1 - progress;
  const takeupFillRatio = progress;

  const renderReel = (label: string, fillRatio: number) => (
    <View style={styles.reelWrap}>
      <Animated.View style={[styles.reel, { transform: [{ rotate: rotateInterp }] }]}>
        {/* Outer flange ring (closer to edge — the case ring) */}
        <View style={styles.outerFlange} />
        {/* Tape-fill annulus — sits between the NAB hub adapter and the
            outer flange. Diameter shrinks as `fillRatio` decreases. */}
        <View
          style={[
            styles.tapeFill,
            {
              width: 28 + (REEL_DIAM - 36) * fillRatio,
              height: 28 + (REEL_DIAM - 36) * fillRatio,
              borderRadius: (28 + (REEL_DIAM - 36) * fillRatio) / 2,
            },
          ]}
        />
        {/* NAB hub adapter ring — the always-visible inner ring at ~28dp */}
        <View style={styles.nabHub} />
        {/* Spokes — three diameters rotated 0°, 60°, 120° */}
        <View style={[styles.spoke, { transform: [{ rotate: '0deg' }] }]} />
        <View style={[styles.spoke, { transform: [{ rotate: '60deg' }] }]} />
        <View style={[styles.spoke, { transform: [{ rotate: '120deg' }] }]} />
        {/* Center hub cap */}
        <View style={styles.hub} />
      </Animated.View>
      <Text style={styles.reelLabel}>{label}</Text>
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={styles.reelsRow}>
        {renderReel('SUPPLY', supplyFillRatio)}
        {/* Tape path — two angled tape segments + central head block with
            guide pins. Reads as "tape running across the heads." */}
        <View style={styles.tapePath}>
          <View style={styles.tapeSegLeft} />
          <View style={styles.headBlock}>
            <View style={styles.guidePin} />
            <View style={styles.guidePin} />
          </View>
          <View style={styles.tapeSegRight} />
        </View>
        {renderReel('TAKE-UP', takeupFillRatio)}
      </View>
      <Text style={[styles.clock, highlightClock && styles.clockRecording]}>{mmss(clockSec)}</Text>
      <Text style={styles.status}>{statusLine}</Text>
    </View>
  );
}

const REEL_DIAM = 100;

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: { alignItems: 'center', marginTop: 8, marginBottom: 8 },
    reelsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
    reelWrap: { alignItems: 'center' },
    reel: {
      width: REEL_DIAM,
      height: REEL_DIAM,
      borderRadius: REEL_DIAM / 2,
      backgroundColor: C.bg,
      borderColor: C.edge,
      borderWidth: 2,
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
    },
    outerFlange: {
      position: 'absolute',
      width: REEL_DIAM - 8,
      height: REEL_DIAM - 8,
      borderRadius: (REEL_DIAM - 8) / 2,
      borderColor: C.inkDim,
      borderWidth: 1,
      opacity: 0.6,
    },
    // Tape-fill annulus — a filled disc that VISUALLY represents the wound
    // tape. Darker than the bg so it reads as "tape" rather than empty
    // space. As progress advances, supply shrinks; take-up grows.
    tapeFill: {
      position: 'absolute',
      backgroundColor: C.inkDim,
      opacity: 0.35,
    },
    nabHub: {
      position: 'absolute',
      width: 28,
      height: 28,
      borderRadius: 14,
      borderColor: C.inkMid,
      borderWidth: 1.5,
      backgroundColor: C.bg,
    },
    spoke: {
      position: 'absolute',
      width: REEL_DIAM - 24,
      height: 2,
      backgroundColor: C.inkMid,
      opacity: 0.5,
    },
    hub: {
      width: 12, height: 12, borderRadius: 6,
      backgroundColor: C.accent,
    },
    reelLabel: { color: C.inkDim, fontSize: 9, letterSpacing: 2, fontWeight: '700', marginTop: 4 },

    // Tape path between the two reels.
    tapePath: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 4,
    },
    tapeSegLeft:  { width: 22, height: 2, backgroundColor: C.inkDim, opacity: 0.55 },
    tapeSegRight: { width: 22, height: 2, backgroundColor: C.inkDim, opacity: 0.55 },
    headBlock: {
      width: 18,
      height: 22,
      borderRadius: 2,
      backgroundColor: C.face,
      borderColor: C.edge,
      borderWidth: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 2,
    },
    guidePin: {
      width: 3,
      height: 14,
      borderRadius: 1.5,
      backgroundColor: C.inkMid,
      opacity: 0.7,
    },

    clock: { color: C.ink, fontSize: 40, fontWeight: '300', letterSpacing: 4, fontVariant: ['tabular-nums'], marginTop: 4 },
    clockRecording: { color: C.sharp },
    status: { color: C.inkDim, fontSize: 11, letterSpacing: 2, marginTop: 4, fontWeight: '700' },
  });
}
