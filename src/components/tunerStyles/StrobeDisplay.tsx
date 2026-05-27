/**
 * StrobeDisplay — Peterson StroboPlus emulation.
 *
 * 16 vertical bars (period ≈ 20 dp) animate horizontally. Velocity is
 * proportional to cents deviation: positive cents → scroll right (sharp),
 * negative → scroll left (flat), zero → stationary.
 *
 * The RAF loop short-circuits to a slow heartbeat when cents stays at 0,
 * keeping CPU at idle when the player is in tune.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';
import type { NoteDisplay } from '../../tunerWidgets';

const STRIP_HEIGHT = 120;
const BAR_WIDTH = 6;
const BAR_GAP = 14;
const PERIOD = BAR_WIDTH + BAR_GAP;
const BAR_COUNT = 24; // enough to fully cover any reasonable screen width

// Velocity scaling: 0.15 px/frame per cent at 60 fps = 9 px/s per cent. At
// ±20¢ the strip travels ~180 px/s, brisk but readable.
const PX_PER_FRAME_PER_CENT = 0.15;

export interface StrobeDisplayProps {
  noteDisplay: NoteDisplay | null;
  freqHz: number | null;
  isOutOfRange: boolean;
}

export function StrobeDisplay({ noteDisplay, freqHz, isOutOfRange }: StrobeDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  // The offset is a JS-side number we re-apply each frame. We store it in a
  // ref to avoid re-rendering 60 times per second; a single setState bumps
  // the visible offset state when it materially changed (every frame while
  // animating, throttled when idle).
  const offsetRef = useRef(0);
  const [offset, setOffset] = useState(0);
  const rafRef = useRef<number | null>(null);

  const centsRef = useRef<number | null>(null);
  centsRef.current = noteDisplay?.cents ?? null;

  useEffect(() => {
    let cancelled = false;
    let lastForcedTickMs = Date.now();
    const tick = () => {
      if (cancelled) return;
      const c = centsRef.current;
      if (c !== null && Math.abs(c) > 0.5) {
        offsetRef.current = (offsetRef.current + c * PX_PER_FRAME_PER_CENT) % PERIOD;
        // Keep offset in (-PERIOD, +PERIOD)
        if (offsetRef.current < 0) offsetRef.current += PERIOD;
        setOffset(offsetRef.current);
        rafRef.current = requestAnimationFrame(tick);
      } else {
        // Idle: drop to ~4 Hz heartbeat. Keeps the loop reactive without
        // burning a frame per vsync when the player is in tune.
        const now = Date.now();
        if (now - lastForcedTickMs > 250) {
          lastForcedTickMs = now;
          setOffset(offsetRef.current);
        }
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const letter = noteDisplay?.letter ?? '—';
  const accidental = noteDisplay?.accidental ?? '';
  const octave = noteDisplay?.octave;
  const hasNote = noteDisplay !== null;
  const cents = noteDisplay?.cents ?? 0;
  const hzText = freqHz !== null ? freqHz.toFixed(1) : '— — —';
  const centsText = noteDisplay
    ? `${cents >= 0 ? '+' : ''}${cents.toFixed(noteDisplay.precision === 1.0 ? 0 : 1)}`
    : '+00';
  const centsColor =
    !hasNote || isOutOfRange ? C.inkVeryDim :
    Math.abs(cents) <= 5  ? C.inTune :
    Math.abs(cents) <= 15 ? C.accent :
                            C.sharp;

  // Render bars positioned at `i * PERIOD - offset` so they march in step.
  const bars: React.ReactNode[] = [];
  for (let i = -2; i < BAR_COUNT; i++) {
    const left = i * PERIOD - offset;
    bars.push(
      <View
        key={i}
        style={[styles.bar, { left, opacity: isOutOfRange ? 0.25 : 1 }]}
        pointerEvents="none"
      />,
    );
  }

  return (
    <View style={styles.root}
      accessibilityRole="image"
      accessibilityLabel={
        hasNote
          ? `Strobe tuner: ${letter}${accidental}${octave ?? ''} at ${cents >= 0 ? '+' : ''}${cents.toFixed(1)} cents.`
          : 'Strobe tuner: waiting for a note.'
      }
    >
      {/* Note letter + cents readout — compact above the strip. */}
      <View style={styles.headRow}>
        <Text style={[styles.note, !hasNote && styles.noteDim]} numberOfLines={1}>
          {letter}{accidental}
          {octave !== undefined && <Text style={styles.octave}> {octave}</Text>}
        </Text>
        <View style={styles.headRight}>
          <Text style={[styles.centsBig, { color: centsColor }]}>{centsText}<Text style={styles.centsUnit}> ¢</Text></Text>
          <Text style={styles.hz}>{hzText} Hz</Text>
        </View>
      </View>

      {/* The strobe strip itself */}
      <View style={styles.strip}>
        {bars}
        {/* Edge fades (top + bottom strips so the active area still reads cleanly). */}
        <View style={styles.fadeLeft} pointerEvents="none" />
        <View style={styles.fadeRight} pointerEvents="none" />
        {/* Centre marker — a thin line at the centre column for orientation. */}
        <View style={styles.centerLine} pointerEvents="none" />
      </View>

      <View style={styles.legendRow}>
        <Text style={styles.legend}>← FLAT</Text>
        <Text style={styles.legend}>IN TUNE = STILL</Text>
        <Text style={styles.legend}>SHARP →</Text>
      </View>
    </View>
  );
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: { width: '100%', maxWidth: 720, alignSelf: 'center' },
    headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 },
    note: { color: C.ink, fontSize: 64, fontWeight: '300', letterSpacing: -2, fontVariant: ['tabular-nums'] },
    noteDim: { color: C.inkDim },
    octave: { color: C.inkMid, fontSize: 24 },
    headRight: { alignItems: 'flex-end' },
    centsBig: { fontSize: 28, fontWeight: '700', letterSpacing: 1, fontVariant: ['tabular-nums'] },
    centsUnit: { fontSize: 16, fontWeight: '400', color: C.inkDim },
    hz: { color: C.inkMid, fontSize: 12, letterSpacing: 2, marginTop: 2, fontVariant: ['tabular-nums'] },

    strip: {
      height: STRIP_HEIGHT,
      backgroundColor: C.face,
      borderColor: C.edge,
      borderWidth: 1,
      borderRadius: 4,
      overflow: 'hidden',
      position: 'relative',
    },
    bar: {
      position: 'absolute',
      top: 8,
      bottom: 8,
      width: BAR_WIDTH,
      backgroundColor: C.accent,
      borderRadius: 1,
    },
    fadeLeft: {
      position: 'absolute',
      top: 0, bottom: 0, left: 0, width: 40,
      backgroundColor: C.face,
      opacity: 0.75,
    },
    fadeRight: {
      position: 'absolute',
      top: 0, bottom: 0, right: 0, width: 40,
      backgroundColor: C.face,
      opacity: 0.75,
    },
    centerLine: {
      position: 'absolute',
      top: 0, bottom: 0, left: '50%', width: 1,
      backgroundColor: C.inkMid,
      opacity: 0.5,
    },
    legendRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
    legend: { color: C.inkDim, fontSize: 10, letterSpacing: 2, fontWeight: '600' },
  });
}
