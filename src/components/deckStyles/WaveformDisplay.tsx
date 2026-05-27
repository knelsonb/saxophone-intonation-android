/**
 * WaveformDisplay — minimalist scope envelope.
 *
 * v0.9.8 rebuild after fidelity review:
 *   • Bars now render as a SYMMETRIC two-sided envelope around an explicit
 *     center line — each bar extends both ABOVE and BELOW center by
 *     `amp * (canvas/2)`. Previously a single rectangle centered via
 *     `alignItems: 'center'` looked like a bar chart, not a scope trace.
 *   • Tighter bar density (64 strokes, 3dp wide, 1dp gap) so the result
 *     reads as a continuous envelope shape rather than discrete bars.
 *   • Playhead position derived directly from `playFraction` (a smooth
 *     fraction in [0, 1]) — no more snapping to bar-index integers.
 *   • Visible center line so the envelope's symmetry is explicit.
 *
 * Two modes:
 *   - Recording: bars build up from the right as a scrolling pseudo-RMS
 *     walk seeded by capture timestamp. (Real RMS would replace this
 *     when `useAudioSampleListener` lands.)
 *   - Playback: a stable envelope derived from the take's seed; past
 *     audio coloured `accent` (played), future audio `inkMid` (unplayed),
 *     a vertical playhead line at `playFraction * 100%`.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';

const CANVAS_H = 96;
const BAR_COUNT = 64;
const BAR_WIDTH = 3;
const BAR_GAP = 1;
const HALF_CANVAS = CANVAS_H / 2;

function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function envelopeFor(seed: number, count: number): number[] {
  const rand = mulberry32(seed);
  const arr: number[] = [];
  let walk = 0.5;
  for (let i = 0; i < count; i++) {
    walk += (rand() - 0.5) * 0.2;
    if (walk < 0.08) walk = 0.08;
    if (walk > 1) walk = 1;
    const shape = 0.4 + 0.6 * Math.sin((i / count) * Math.PI);
    arr.push(walk * shape);
  }
  return arr;
}

export interface WaveformDisplayProps {
  mode: 'idle' | 'recording' | 'have-take' | 'playing';
  recordingSec: number;
  takeSeed: number | null;
  takeDurationSec: number;
  playFraction: number;
  clockSec: number;
  statusLine: string;
}

export function WaveformDisplay({
  mode, recordingSec, takeSeed, takeDurationSec, playFraction, clockSec, statusLine,
}: WaveformDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  const [recordEnv, setRecordEnv] = useState<number[]>([]);
  const recordSeedRef = useRef<number | null>(null);

  useEffect(() => {
    if (mode === 'recording') {
      if (recordSeedRef.current === null) recordSeedRef.current = Date.now();
      const N = Math.min(BAR_COUNT, Math.max(1, Math.floor(recordingSec * 4)));
      const rand = mulberry32((recordSeedRef.current ?? 1) ^ N);
      const arr: number[] = [];
      for (let i = 0; i < N; i++) {
        const emphasis = i / Math.max(1, N - 1);
        const v = 0.25 + rand() * 0.6 * (0.6 + 0.4 * emphasis);
        arr.push(Math.min(1, v));
      }
      setRecordEnv(arr);
    } else {
      recordSeedRef.current = null;
      if (recordEnv.length > 0) setRecordEnv([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, recordingSec]);

  const playEnv = useMemo(() => {
    if (takeSeed === null) return [] as number[];
    return envelopeFor(takeSeed, BAR_COUNT);
  }, [takeSeed]);

  const env = mode === 'recording' ? recordEnv : playEnv;
  const showingPlayback = mode === 'have-take' || mode === 'playing';
  const playheadPct = showingPlayback ? Math.max(0, Math.min(1, playFraction)) * 100 : -1;

  return (
    <View style={styles.root}>
      <View style={styles.canvas}>
        {/* Explicit center line — anchors the eye on the symmetric envelope. */}
        <View style={styles.centerLine} pointerEvents="none" />

        {env.length === 0 ? (
          <Text style={styles.placeholder}>NO SIGNAL</Text>
        ) : (
          env.map((v, i) => {
            const halfH = Math.max(1, Math.round(v * (HALF_CANVAS - 4)));
            const fracPos = i / Math.max(1, BAR_COUNT - 1);
            const isPast = playheadPct >= 0 && fracPos * 100 < playheadPct;
            const color =
              mode === 'recording' ? C.sharp :
              isPast ? C.accent : C.inkMid;
            return (
              <React.Fragment key={i}>
                {/* Upper half — extends from center upward. */}
                <View
                  style={[
                    styles.bar,
                    {
                      left: i * (BAR_WIDTH + BAR_GAP) + 4,
                      bottom: HALF_CANVAS,
                      height: halfH,
                      backgroundColor: color,
                    },
                  ]}
                />
                {/* Lower half — extends from center downward, mirroring. */}
                <View
                  style={[
                    styles.bar,
                    {
                      left: i * (BAR_WIDTH + BAR_GAP) + 4,
                      top: HALF_CANVAS,
                      height: halfH,
                      backgroundColor: color,
                    },
                  ]}
                />
              </React.Fragment>
            );
          })
        )}
        {/* Playhead — vertical line at the fractional playback position.
            Previously snapped to bar-index integers (~2 % steps). */}
        {playheadPct >= 0 && env.length > 0 && (
          <View
            style={[styles.playhead, { left: `${playheadPct}%` }]}
            pointerEvents="none"
          />
        )}
      </View>
      <View style={styles.timeRow}>
        <Text style={styles.timeText}>{mmss(clockSec)}</Text>
        <Text style={styles.timeText}>{mmss(takeDurationSec)}</Text>
      </View>
      <Text style={styles.status}>{statusLine}</Text>
    </View>
  );
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: { marginTop: 8, marginBottom: 12 },
    canvas: {
      height: CANVAS_H,
      borderColor: C.edge,
      borderWidth: 1,
      borderRadius: 4,
      backgroundColor: C.bg,
      position: 'relative',
      overflow: 'hidden',
    },
    centerLine: {
      position: 'absolute',
      left: 0, right: 0,
      top: HALF_CANVAS - 0.5,
      height: 1,
      backgroundColor: C.edgeSoft,
      opacity: 0.7,
    },
    bar: {
      position: 'absolute',
      width: BAR_WIDTH,
      borderRadius: 1,
      opacity: 0.9,
    },
    playhead: {
      position: 'absolute',
      top: 4, bottom: 4,
      width: 2,
      marginLeft: -1,
      backgroundColor: C.ink,
    },
    placeholder: { color: C.inkDim, fontSize: 12, letterSpacing: 4, fontWeight: '700', alignSelf: 'center', marginTop: HALF_CANVAS - 8 },
    timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, paddingHorizontal: 4 },
    timeText: { color: C.inkMid, fontSize: 12, letterSpacing: 1, fontVariant: ['tabular-nums'] },
    status: { color: C.inkDim, fontSize: 11, letterSpacing: 3, marginTop: 6, textAlign: 'center', fontWeight: '700' },
  });
}
