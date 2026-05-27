/**
 * VuDisplay — vintage analog VU pair with ballistic needles.
 *
 * Two side-by-side meters labelled L / R. Each has a curved dial face with
 * tick marks, a needle pivoting from the bottom-centre, and a 0 dB marker
 * about 70 % of the way across the scale (matching the IEC 60268-17 layout
 * everyone's seen on a tape deck).
 *
 * **Honest scope note.** We do not currently have real RMS for the recorder
 * or sampled-playback envelope wired up through expo-audio. So the needles
 * here animate on a synthetic envelope: during RECORD they swing in the
 * upper-mid range with a random walk; during PLAY they follow a softer
 * walk; idle, they sit at the rest position. The motion FEELS like a VU
 * meter and reads "yes the deck is doing something" — but it's not a
 * measurement instrument. If you want actual signal visualization use
 * WAVEFORM. (When `useAudioSampleListener` lands, replace `synthEnvelope`
 * with the real RMS feed at the same call site.)
 *
 * Ballistics: VU spec says ~300 ms to reach 99 % on a sustained input. We
 * approximate with Animated.timing duration 250 ms toward each new target,
 * which gives the right "lazy" attack feel.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';

const DIAL_W = 110;
const DIAL_H = 70;
const NEEDLE_LEN = 62;
const REST_DEG = -55;   // needle resting at far left
const PEAK_DEG = 55;    // needle at right peak
const RED_FROM_DEG = 30;

// VU target update cadence — every 60ms a fresh random walk target is
// chosen and the needle eases toward it. Slow enough that the animation
// actually completes most steps; fast enough to feel "alive."
const TICK_MS = 60;

export interface VuDisplayProps {
  mode: 'idle' | 'recording' | 'have-take' | 'playing';
  /** Wall-clock seconds into the take during playback — drives the slow
   *  envelope shape so the meters trend with playback position. */
  clockSec: number;
  statusLine: string;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Synthesize a [0,1] envelope sample. During record we trend around 0.55
 * with bursts to 0.85; during play we trend around 0.45 with a slow shape
 * tied to clockSec for visual coherence with the scrubber. Idle returns 0.
 */
function synthEnvelope(
  mode: VuDisplayProps['mode'],
  channelOffset: number,
  clockSec: number,
  prev: number,
): number {
  if (mode === 'idle' || mode === 'have-take') return 0;
  const noise = (Math.random() - 0.5);
  if (mode === 'recording') {
    // Random walk centred on 0.55, occasional spike, slight L/R offset
    // (channelOffset shifts the centre so the two needles don't perfectly
    // mirror each other).
    const target = clamp01(prev + noise * 0.35);
    const centred = clamp01(target * 0.6 + 0.45 + channelOffset);
    return clamp01(centred + (Math.random() < 0.06 ? 0.25 : 0));
  }
  // playing: gentler walk, plus a slow phrase shape based on clockSec.
  const phrase = 0.35 + 0.25 * Math.sin(clockSec * 1.6 + channelOffset * 4);
  const target = clamp01(prev * 0.65 + (phrase + noise * 0.22) * 0.35);
  return target;
}

export function VuDisplay({ mode, clockSec, statusLine }: VuDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  const lAnim = useRef(new Animated.Value(0)).current;
  const rAnim = useRef(new Animated.Value(0)).current;
  const lPrev = useRef(0);
  const rPrev = useRef(0);
  const [, setTick] = useState(0); // forces re-eval of statusLine etc — not strictly needed

  useEffect(() => {
    if (mode === 'idle' || mode === 'have-take') {
      // Settle both needles to rest.
      Animated.timing(lAnim, { toValue: 0, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      Animated.timing(rAnim, { toValue: 0, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      lPrev.current = 0;
      rPrev.current = 0;
      return;
    }
    // Active: drive the needles toward fresh synth targets every TICK_MS.
    const id = setInterval(() => {
      const lNext = synthEnvelope(mode, -0.04, clockSec, lPrev.current);
      const rNext = synthEnvelope(mode, +0.04, clockSec, rPrev.current);
      lPrev.current = lNext;
      rPrev.current = rNext;
      Animated.timing(lAnim, { toValue: lNext, duration: 250, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
      Animated.timing(rAnim, { toValue: rNext, duration: 250, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
      setTick((t) => t + 1);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [mode, clockSec, lAnim, rAnim]);

  const needleRotation = (anim: Animated.Value) => anim.interpolate({
    inputRange: [0, 1],
    outputRange: [`${REST_DEG}deg`, `${PEAK_DEG}deg`],
  });

  const renderMeter = (label: string, anim: Animated.Value) => (
    <View style={styles.meter}>
      <View style={styles.face}>
        {/* Scale arc: a row of tick lines. Major ticks at -20, -10, -3, 0, +3.
            We draw 11 ticks spread across the dial; the rightmost three are
            in the "red" zone. */}
        {Array.from({ length: 11 }).map((_, i) => {
          const isRed = i >= 8;
          const isMajor = [0, 3, 6, 8, 10].includes(i);
          const angle = REST_DEG + ((i / 10) * (PEAK_DEG - REST_DEG));
          return (
            <View
              key={i}
              style={[
                styles.tick,
                isMajor && styles.tickMajor,
                isRed && styles.tickRed,
                {
                  transform: [
                    { translateX: 0 },
                    { rotate: `${angle}deg` },
                    { translateY: -DIAL_H + 8 },
                  ],
                },
              ]}
            />
          );
        })}

        {/* Red zone marker — short red bar at the 0 dB position. */}
        <View
          style={[
            styles.zoneMarker,
            {
              transform: [
                { rotate: `${RED_FROM_DEG}deg` },
                { translateY: -DIAL_H + 14 },
              ],
            },
          ]}
        />

        <Text style={[styles.scaleText, styles.scaleTextLeft]}>-20</Text>
        <Text style={[styles.scaleText, styles.scaleTextMid]}>0</Text>
        <Text style={[styles.scaleText, styles.scaleTextRight]}>+3</Text>

        <Animated.View
          style={[
            styles.needle,
            { transform: [{ rotate: needleRotation(anim) }] },
          ]}
        />
        <View style={styles.pivot} />
      </View>
      <Text style={styles.label}>{label}</Text>
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={styles.row}>
        {renderMeter('L', lAnim)}
        {renderMeter('R', rAnim)}
      </View>
      <Text style={styles.status}>{statusLine}</Text>
    </View>
  );
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: { alignItems: 'center', marginTop: 8, marginBottom: 8 },
    row: { flexDirection: 'row', gap: 14 },
    meter: { alignItems: 'center' },

    face: {
      width: DIAL_W,
      height: DIAL_H,
      backgroundColor: C.bg,
      borderTopLeftRadius: DIAL_W / 2,
      borderTopRightRadius: DIAL_W / 2,
      borderColor: C.edge,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'flex-end',
      overflow: 'hidden',
      position: 'relative',
    },

    needle: {
      position: 'absolute',
      bottom: 0,
      left: DIAL_W / 2 - 1,
      width: 2,
      height: NEEDLE_LEN,
      backgroundColor: C.sharp,
      borderRadius: 1,
      transformOrigin: 'bottom center',
    },
    pivot: {
      position: 'absolute',
      bottom: -5,
      left: DIAL_W / 2 - 6,
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: C.inkDim,
      borderColor: C.edge,
      borderWidth: 1,
    },

    // Ticks live inside the face. Each is rotated around the pivot via the
    // transform stack: first rotate to the dial angle, then translateY out
    // to the rim. transformOrigin keeps the rotation centred on the pivot.
    tick: {
      position: 'absolute',
      bottom: 0,
      left: DIAL_W / 2 - 1,
      width: 2,
      height: 8,
      backgroundColor: C.inkDim,
      transformOrigin: 'bottom center',
    },
    tickMajor: { height: 12, width: 2.5, backgroundColor: C.inkMid },
    tickRed: { backgroundColor: C.sharp, opacity: 0.7 },

    zoneMarker: {
      position: 'absolute',
      bottom: 0,
      left: DIAL_W / 2 - 0.5,
      width: 1,
      height: 18,
      backgroundColor: C.sharp,
      opacity: 0.5,
      transformOrigin: 'bottom center',
    },

    scaleText: {
      position: 'absolute',
      color: C.inkDim,
      fontSize: 8,
      letterSpacing: 0.5,
      fontVariant: ['tabular-nums'],
      fontWeight: '700',
    },
    scaleTextLeft:  { left: 6,  bottom: 4 },
    scaleTextMid:   { left: DIAL_W / 2 - 4, top: 6 },
    scaleTextRight: { right: 6, bottom: 4, color: C.sharp },

    label: { color: C.inkDim, fontSize: 10, letterSpacing: 3, marginTop: 10, fontWeight: '700' },

    status: { color: C.inkDim, fontSize: 11, letterSpacing: 3, marginTop: 8, textAlign: 'center', fontWeight: '700' },
  });
}
