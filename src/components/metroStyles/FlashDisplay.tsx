/**
 * FlashDisplay — visibility-at-distance metronome. The whole content area
 * flashes a colour on each beat. Downbeat = full `C.inTune`, off-beats =
 * `C.accent`. Each flash decays linearly over half a beat. Designed for the
 * band director standing at the back of the rehearsal room.
 *
 * v1.0 PSE (photosensitive-epilepsy) safety: 300 BPM full-screen flash = 5 Hz,
 * inside the 3–30 Hz PSE trigger band. Above 150 BPM (= 2.5 Hz, below the
 * band) we demote to a 24dp corner dot. Also honors the system reduce-motion
 * preference — corner dot regardless of BPM.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';

// v1.0 — hard cap. 150 BPM = 2.5 Hz; one step above and we enter the PSE band.
const PSE_BPM_CAP = 150;

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

  // v1.0 — read system reduce-motion preference. Re-read on mount and on
  // subscription change. If RN's listener isn't available we fall back to
  // the initial read.
  const [reduceMotion, setReduceMotion] = React.useState(false);
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (!cancelled) setReduceMotion(v);
    }).catch(() => { /* ignore */ });
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) => {
      setReduceMotion(v);
    });
    return () => {
      cancelled = true;
      sub?.remove?.();
    };
  }, []);

  // Demote to corner dot when reduce-motion is on OR BPM > 150 (PSE band).
  const safeMode = reduceMotion || bpm > PSE_BPM_CAP;
  // v1.0.1 — branch the trigger so we can label honestly. BPM trigger wins
  // if both are true (it's the more surprising demote at runtime).
  const safeReason: 'bpm' | 'reduce-motion' | null =
    bpm > PSE_BPM_CAP ? 'bpm' : reduceMotion ? 'reduce-motion' : null;
  const safeLabel =
    safeReason === 'bpm' ? `FLASH dimmed above ${PSE_BPM_CAP} BPM` :
    safeReason === 'reduce-motion' ? 'FLASH dimmed — reduced motion' :
    '';
  const safeA11y =
    safeReason === 'bpm'
      ? `High tempo safety mode — visual demoted to corner dot above ${PSE_BPM_CAP} BPM`
      : 'Reduced motion — visual demoted to corner dot';

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
  // v1.0 — stop previous animation before starting next; at fast BPM the
  // prior tween overlaps. Snapshot setState too, even though it's idempotent
  // for the same color, to avoid lingering tween state on mid-fade swap.
  const flashAnim = useRef(new Animated.Value(0)).current;
  const flashColorRef = useRef(C.accent);
  const [flashBg, setFlashBg] = React.useState(C.accent);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  useEffect(() => {
    if (!running || pulse === 0) return;
    animRef.current?.stop();
    const color = beat === 1 ? C.inTune : C.accent;
    flashColorRef.current = color;
    setFlashBg(color);
    flashAnim.setValue(1);
    const a = Animated.timing(flashAnim, {
      toValue: 0,
      duration: halfBeatMs,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    animRef.current = a;
    a.start();
    return () => { animRef.current?.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulse, running, halfBeatMs, flashAnim]);

  const opacityInterp = flashAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  // v1.0.1 — beat-tied numeral pulse for safeMode. When the big flash panel
  // is demoted, the central beat numeral keeps peripheral-vision pickup by
  // pulsing scale + opacity on each beat. Reuses flashAnim so it's already
  // beat-synced (it ramps 1→0 over half a beat). Skip when not in safeMode
  // so the unpulsed numeral renders crisply behind the full flash.
  const numeralScale = safeMode
    ? flashAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] })
    : 1;
  const numeralOpacity = safeMode
    ? flashAnim.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1] })
    : 1;

  return (
    <View style={styles.root}>
      {safeMode ? (
        <>
          {/* v1.0 — corner dot mode. Single 24dp circle pulsing in the top-right.
              No full-area flash; safe for reduce-motion users and outside PSE band. */}
          <Animated.View
            pointerEvents="none"
            style={[styles.cornerDot, { backgroundColor: flashBg, opacity: opacityInterp }]}
            accessibilityRole="image"
            accessibilityLabel={running ? `Beat ${beat}. ${safeA11y}` : `Stopped. ${safeA11y}`}
          />
          {/* v1.0.1 — visible explanation so the user knows why the big flash
              isn't firing. Dim + small so it doesn't compete with the
              metronome itself. */}
          <Text style={styles.safeNote} accessibilityElementsHidden importantForAccessibility="no">
            {safeLabel}
          </Text>
        </>
      ) : (
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            styles.flashPanel,
            { backgroundColor: flashBg, opacity: opacityInterp },
          ]}
          accessibilityRole="image"
          accessibilityLabel={running ? `Beat ${beat} flash` : 'Stopped'}
        />
      )}
      <View style={styles.center}>
        {/* v1.0.1 — beat-tied numeral pulse only in safeMode (scale+opacity). */}
        <Animated.Text
          style={[
            styles.beatLabel,
            safeMode && { transform: [{ scale: numeralScale }], opacity: numeralOpacity },
          ]}
        >
          {running ? beat : '·'}
        </Animated.Text>
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
    // v1.0 — PSE-safe corner indicator. 24dp circle, top-right with padding.
    cornerDot: {
      position: 'absolute',
      top: 12,
      right: 12,
      width: 24,
      height: 24,
      borderRadius: 12,
    },
    // v1.0.1 — dim safeMode explainer, top-left, well clear of the corner dot.
    safeNote: {
      position: 'absolute',
      top: 14,
      left: 12,
      color: C.inkDim,
      fontSize: 10,
      letterSpacing: 1.5,
      fontWeight: '700',
      opacity: 0.75,
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
