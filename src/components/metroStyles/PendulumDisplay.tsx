/**
 * PendulumDisplay — Wittner pyramid metronome.
 *
 * v0.9.8 rebuild after a fidelity review found three breakages:
 *   1. The pivot was rendered ABOVE the body, so the arm appeared to hang
 *      in mid-air. A real Wittner has the pivot embedded ~12dp INSIDE the
 *      body's top edge — the arm visibly emerges from a pivot hole in the
 *      body.
 *   2. Body-to-arm ratio was 1:2 (small body, tall stick) — a real Wittner
 *      is body-dominant (the pyramid mass is the visual anchor; the arm
 *      protrudes above by maybe 60-80% of the body height).
 *   3. The "trapezoid" was a rectangle with a smaller rectangle cap —
 *      visibly stepped, not tapered. We now stack 6 progressively narrower
 *      slats to give a proper tapered silhouette without an SVG dep.
 *
 * Geometry (numbers in display-pixels):
 *   frame:   220 × 180
 *   body:    six 14dp slats, widths 150/130/110/95/80/65 (bottom → top)
 *            → body height 84dp, base 150dp, top 65dp
 *   pivot:   12dp inside the top of the body, accent-colored
 *   arm:     starts at pivot, extends ~90dp upward (visible above body
 *            ~ 78dp, i.e. ~93% of body height — close to 1:1 protrusion)
 *   weight:  18dp bead, ~14dp below the top of the arm
 *
 * Timing model (Reanimated clock-driven — v1.4.x P2): position is a pure
 * function of a clock, computed every UI-thread frame in a worklet, NOT a tween
 * restarted on each beat. This is the rhythm-game pattern and removes the
 * per-beat JS-thread "hitch" the Animated-restart approach had.
 *
 *   angle(t) = side · sin(phase · π),   phase = (uiNow − originTime) / beatDur
 *
 * sin gives natural pendulum motion: max speed at the CENTER crossing (phase 0
 * and 1 → angle 0, the beat) and a momentary stop at the EXTREME (phase 0.5 →
 * angle ±1, the "and"). The extreme side alternates each beat (R, L, R, L…).
 *
 * Each scheduled beat (a single commandFired 'noteOn' from the real-time
 * engine) bumps a peg counter; the worklet captures the UI-frame timestamp as
 * the new phase origin — a re-peg, not a restart, so motion stays continuous
 * through the beat boundary even if the event arrives a few ms jittered.
 *
 * Beat-perfect-or-nothing (silence-over-wrong axiom, visual corollary): if no
 * fresh beat peg arrives within 1.5 beats, the engine isn't supplying timing —
 * the arm FREEZES (settles to center) rather than free-running on a drifting
 * clock. It never shows approximate motion.
 */
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useSharedValue,
  useFrameCallback,
  useAnimatedStyle,
  withTiming,
  type FrameInfo,
} from 'react-native-reanimated';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';
import type { MidiBusState } from '../../useMidiBusCore';
import { log } from '../../log';

const SWING_DEG = 26;

// Per-beat bob colour so the weight itself signals position in the bar:
// 1=red, 2=orange, 3=yellow, 4=blue. Cycles for bars longer than 4. Together
// with the distinct per-beat drum voice and the numeral, the player can hear,
// see, and feel where they are in the measure.
const BEAT_COLORS = ['#E53935', '#FB8C00', '#FDD835', '#1E88E5'];

// Body — 6 slats stacked bottom (widest) → top (narrowest).
const SLAT_H = 14;
const SLAT_WIDTHS = [150, 130, 110, 95, 80, 65];
const BODY_H = SLAT_H * SLAT_WIDTHS.length; // 84dp

// Pivot lives 12dp inside the body from its top edge.
const PIVOT_FROM_BODY_TOP = 12;

// Arm length from the pivot upward.
const ARM_H = 96;
const ARM_W = 4;
const BEAD_SIZE = 18;
const BEAD_FROM_ARM_TOP = 14;

const FRAME_W = 220;
const FRAME_H = ARM_H + BODY_H - PIVOT_FROM_BODY_TOP + 4;

export interface PendulumDisplayProps {
  running: boolean;
  beat: number;
  /**
   * v1.3.4 — `pulse` is no longer used to drive the swing (it lagged by one
   * React reconcile frame ~16 ms because the pulse setState batched after
   * the audio noteOn fired). Kept on the prop surface for backward compat
   * with the call site; swing is now driven by a direct `bus.on('noteOn')`
   * subscription that runs SYNCHRONOUSLY in the noteOn call stack (U21
   * invariant). Will be removed when MetroScreen drops the prop.
   */
  pulse: number;
  bpm: number;
  /**
   * v1.3.4 — MIDI bus reference for the synchronous swing subscription.
   * Optional so the renderCount test harness's MetroScreen mock doesn't
   * need to thread it; when absent, the pendulum sits idle (no swing).
   */
  bus?: MidiBusState;
}

export function PendulumDisplay({ running, beat, bpm, bus }: PendulumDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  // Shared values live on the UI thread (Reanimated). `angle` ∈ [-1, 1] is the
  // arm position (0 = center/vertical, ±1 = extreme) and drives the rotation.
  const angle = useSharedValue(0);
  // `theta` is the phase in BEATS, integrated per frame. The arm is a single
  // continuous sine of it:
  //
  //     angle = sin(theta · π)
  //
  // Period 2 beats. theta = 0,1,2… (integer beats) → angle 0 (center / the
  // bob's apex = top of the arc); theta = 0.5,1.5… (the "and") → ±1 (extremes).
  // The sign alternates inside the sine itself — no per-beat side flip, no tween
  // restart. Angular velocity ∝ cos(theta·π)·(dθ/dt) is continuous everywhere,
  // so the arm accelerates out of and decelerates into both center and extremes
  // with zero jerk.
  const theta = useSharedValue(0);
  // PHASE-LOCKED-LOOP correction. A beat peg never STEPS theta — it adds the
  // measured phase error to `pendingCorr`, which the worklet bleeds into the
  // phase RATE smoothly over the next beat (exponential, GAIN below). So a peg
  // tweaks VELOCITY, not position: the following downbeat converges to the right
  // place without any step or jerk in the animation.
  const pendingCorr = useSharedValue(0);
  const lastFrame = useSharedValue(-1);   // UI-ms of previous frame (for dt)
  const anchored = useSharedValue(false); // true once the first beat peg lands
  const beatDur = useSharedValue(Math.max(60, 60000 / Math.max(1, bpm)));   // target ms/beat (from bpm)
  const appliedDur = useSharedValue(Math.max(60, 60000 / Math.max(1, bpm))); // dur the worklet currently uses
  const lastPegTime = useSharedValue(-1); // UI-ms of the last beat peg (staleness)
  // Peg signalling: JS bumps `pegSeq` on each beat; the worklet reacts.
  const pegSeq = useSharedValue(0);
  const seenPegSeq = useSharedValue(0);
  const runningSV = useSharedValue(false);

  // Target beat duration follows BPM. theta is in BEATS, so a tempo change only
  // alters the RATE (dθ/dt = 1/dur) going forward — angle stays continuous, no
  // re-anchor needed.
  useEffect(() => {
    beatDur.value = Math.max(60, 60000 / Math.max(1, bpm));
  }, [bpm, beatDur]);

  // How aggressively pendingCorr bleeds into the rate. The frame-clock peg now
  // tracks the hardware (DAC-vs-wall) drift in the scheduling layer, so the only
  // thing this loop corrects is `commandFired` bridge-arrival jitter. Chasing
  // that hard (high gain) injects a beat-synchronous velocity ripple. 1.2 →
  // residual decays ≈ e^(−1.2) ≈ 30%/beat (mostly locked within ~2 beats) while
  // spreading each correction gently enough that the rate change is
  // imperceptible. (Was 2.5 — too aggressive once the peg handles drift.)
  const CORR_GAIN = 1.2;

  // Per-frame worklet (UI thread). Integrates theta and bleeds pendingCorr into
  // the rate — pegs adjust velocity, never position.
  const frameCb = useFrameCallback((frame: FrameInfo) => {
    'worklet';
    if (!runningSV.value) return; // stopped: the ease-to-center below owns `angle`
    const now = frame.timestamp;

    // BPM change: theta is in beats, so just adopt the new rate (no re-anchor).
    if (appliedDur.value !== beatDur.value) appliedDur.value = beatDur.value;
    const dur = appliedDur.value;

    // New beat peg? Measure phase error and SCHEDULE it for smooth bleed-in —
    // do not touch theta here (no step).
    if (pegSeq.value !== seenPegSeq.value) {
      seenPegSeq.value = pegSeq.value;
      lastPegTime.value = now;
      if (!anchored.value) {
        theta.value = 0;          // first beat anchors phase 0
        pendingCorr.value = 0;
        anchored.value = true;
      } else {
        // err > 0 → theta ran ahead of the audio; schedule −err to pull it back.
        const err = theta.value - Math.round(theta.value);
        pendingCorr.value = pendingCorr.value - err;
      }
    }

    if (!anchored.value) { angle.value = 0; lastFrame.value = now; return; } // pre-first-beat → center

    // Beat-perfect-or-nothing: no fresh beat within 1.5 beats → the engine isn't
    // supplying timing. FREEZE (settle to center), never free-run on a drifting
    // clock. Self-heals when pegs resume.
    if (lastPegTime.value >= 0 && now - lastPegTime.value > dur * 1.5) {
      angle.value = angle.value * 0.85;
      lastFrame.value = now;
      return;
    }

    // dt since last frame. Skip large gaps (post-stall / resume) so the arm
    // never lurches — the next peg re-locks instead.
    let dt = lastFrame.value < 0 ? 0 : now - lastFrame.value;
    lastFrame.value = now;
    if (dt < 0 || dt > 50) dt = 0;

    const adv = dt / dur;                       // nominal phase advance (beats)
    let bf = adv * CORR_GAIN;                    // bleed fraction this frame
    if (bf > 0.5) bf = 0.5;                      // stability clamp
    const bleed = pendingCorr.value * bf;        // velocity tweak, not a step
    theta.value = theta.value + adv + bleed;
    pendingCorr.value = pendingCorr.value - bleed;

    angle.value = Math.sin(theta.value * Math.PI);
  }, false);

  // Bus-driven peg. Same channel + tick filter as PerBeatRow — one peg per beat
  // (sub-ticks excluded). The peg is just a timing signal; the worklet owns the
  // motion. No side/parity here — the sine alternates the arc direction itself.
  useEffect(() => {
    if (!running || !bus) return;
    const off = bus.on('noteOn', (evt) => {
      if (evt.channel !== 'drums') return;
      if ((evt.velocity ?? 0) <= 0) return;
      if (evt.tick === 'sub') return;
      log.i('PendDiag', 'peg', { now: Date.now(), midi: evt.midi }); // DIAG (temporary) — visual-vs-audio offset measurement
      pegSeq.value = pegSeq.value + 1;
    });
    return () => { off(); };
  }, [running, bus, pegSeq]);

  // Start/stop the per-frame worklet and reset phase state.
  useEffect(() => {
    runningSV.value = running;
    if (running) {
      pegSeq.value = 0;
      seenPegSeq.value = 0;
      theta.value = 0;
      pendingCorr.value = 0;
      lastFrame.value = -1;
      anchored.value = false;  // hold at center until the first beat pegs
      lastPegTime.value = -1;
      appliedDur.value = beatDur.value;
      frameCb.setActive(true);
    } else {
      frameCb.setActive(false);
      // Ease the arm to center (vertical rest) on the UI thread.
      angle.value = withTiming(0, { duration: 300 });
    }
  }, [running, frameCb, runningSV, pegSeq, seenPegSeq, theta, pendingCorr, lastFrame, anchored, lastPegTime, appliedDur, beatDur, angle]);

  const armStyle = useAnimatedStyle(() => {
    return { transform: [{ rotate: `${angle.value * SWING_DEG}deg` }] };
  });

  // Bob colour tracks the current beat while running (red/orange/yellow/blue,
  // cycling); reverts to the theme accent at rest. `beat` is 1-based.
  const bobColor = running
    ? BEAT_COLORS[((beat - 1) % BEAT_COLORS.length + BEAT_COLORS.length) % BEAT_COLORS.length]
    : C.accent;

  return (
    <View style={styles.root}>
      <View
        style={styles.frame}
        accessibilityRole="image"
        accessibilityLabel={running
          ? `Mechanical metronome swinging at ${bpm} beats per minute`
          : 'Mechanical metronome (idle)'}
      >
        {/* Body — six tapered slats. Rendered first so the arm draws on
            top. The slats are absolute-positioned to stack from the
            bottom of the frame upward. */}
        {SLAT_WIDTHS.map((w, i) => (
          <View
            key={i}
            style={[
              styles.slat,
              {
                width: w,
                bottom: i * SLAT_H,
              },
            ]}
          />
        ))}

        {/* Arm wrap. Bottom of wrap sits at the pivot location. Rotation
            origin is the bottom-center, so the arm pivots around that
            point. Arm and weight live inside the wrap, anchored at its
            bottom — they extend UPWARD as the wrap's content. */}
        <Animated.View
          style={[
            styles.armWrap,
            { bottom: BODY_H - PIVOT_FROM_BODY_TOP },
            armStyle,
          ]}
        >
          <View style={styles.arm} />
          <View style={[styles.weight, { backgroundColor: bobColor }]} />
        </Animated.View>

        {/* Pivot dot — drawn on top of the body so it's visible. */}
        <View
          style={[
            styles.pivotDot,
            { bottom: BODY_H - PIVOT_FROM_BODY_TOP - 4 },
          ]}
        />
      </View>

      <Text style={styles.label}>{running ? `BEAT ${beat}` : 'STOPPED'}</Text>
    </View>
  );
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: { alignItems: 'center', marginTop: 8, marginBottom: 12 },

    frame: {
      width: FRAME_W,
      height: FRAME_H,
      alignItems: 'center',
      justifyContent: 'flex-end',
      position: 'relative',
    },

    slat: {
      position: 'absolute',
      height: SLAT_H,
      backgroundColor: C.face,
      borderColor: C.edge,
      borderTopWidth: 1,
      borderLeftWidth: 1,
      borderRightWidth: 1,
      // No bottom border on intermediate slats — the slat below covers
      // the seam, giving a continuous body silhouette.
    },

    // Wrap is a thin, tall container whose BOTTOM lives at the pivot. The
    // arm and bead are children that lay out from the bottom upward.
    // transformOrigin shifts the rotation centre to the bottom-center.
    armWrap: {
      position: 'absolute',
      width: ARM_W * 4,
      height: ARM_H,
      alignItems: 'center',
      transformOrigin: 'bottom center',
    },
    arm: {
      position: 'absolute',
      bottom: 0,
      width: ARM_W,
      height: ARM_H - 2,
      backgroundColor: C.inkMid,
      borderRadius: ARM_W / 2,
      left: (ARM_W * 4 - ARM_W) / 2,
    },
    weight: {
      position: 'absolute',
      top: BEAD_FROM_ARM_TOP,
      width: BEAD_SIZE,
      height: BEAD_SIZE * 0.7,
      borderRadius: 3,
      backgroundColor: C.accent,
      borderWidth: 1,
      borderColor: C.edge,
      left: (ARM_W * 4 - BEAD_SIZE) / 2,
    },

    pivotDot: {
      position: 'absolute',
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: C.accent,
      borderWidth: 1,
      borderColor: C.bg,
    },

    label: { color: C.inkDim, fontSize: 11, letterSpacing: 3, marginTop: 6, fontWeight: '700' },
  });
}
