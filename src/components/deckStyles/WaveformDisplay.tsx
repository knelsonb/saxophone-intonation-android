/**
 * WaveformDisplay — minimalist scope.
 *
 * The take's amplitude envelope is rendered as a horizontal series of
 * vertical bars. Without a real sample-listener wired up we synthesise a
 * stable envelope from a deterministic pseudo-random walk seeded by the
 * capture timestamp — every take displays the same shape across launches,
 * but each take has its own. (A future revision can replace the synthetic
 * envelope with `useAudioSampleListener` once the live sampler is wired in.)
 *
 * During recording we render a scrolling bar set that grows from the right.
 * During playback the static envelope shows a playhead at `playPos / dur`.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';

const BAR_COUNT = 48;
const BAR_GAP = 3;

function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Tiny PRNG so the envelope is stable across renders for a given seed. xmur3.
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
    // Drifting walk + occasional crescendos. Clamped to [0.08, 1].
    walk += (rand() - 0.5) * 0.2;
    if (walk < 0.08) walk = 0.08;
    if (walk > 1) walk = 1;
    // Add a sin envelope shape so it looks like a phrase rather than noise.
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
  playFraction: number; // 0..1 along the take
  clockSec: number;
  statusLine: string;
}

export function WaveformDisplay({
  mode, recordingSec, takeSeed, takeDurationSec, playFraction, clockSec, statusLine,
}: WaveformDisplayProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  // For recording: build a growing envelope. We expand once per ~250 ms of
  // recording so the visual scrolls smoothly without thrashing setState.
  const [recordEnv, setRecordEnv] = useState<number[]>([]);
  const recordSeedRef = useRef<number | null>(null);

  useEffect(() => {
    if (mode === 'recording') {
      if (recordSeedRef.current === null) recordSeedRef.current = Date.now();
      const N = Math.min(BAR_COUNT, Math.max(1, Math.floor(recordingSec * 4))); // ~4 bars/sec
      const rand = mulberry32((recordSeedRef.current ?? 1) ^ N);
      const arr: number[] = [];
      for (let i = 0; i < N; i++) {
        // Last few bars are emphasized (recent input) — a touch of motion.
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

  // For playback: a stable envelope derived from the take seed.
  const playEnv = useMemo(() => {
    if (takeSeed === null) return [] as number[];
    return envelopeFor(takeSeed, BAR_COUNT);
  }, [takeSeed]);

  const env = mode === 'recording' ? recordEnv : playEnv;
  const playheadIdx = mode === 'have-take' || mode === 'playing'
    ? Math.max(0, Math.min(BAR_COUNT - 1, Math.floor(playFraction * BAR_COUNT)))
    : -1;

  return (
    <View style={styles.root}>
      <View style={styles.canvas}>
        {env.length === 0 ? (
          <Text style={styles.placeholder}>NO SIGNAL</Text>
        ) : (
          env.map((v, i) => {
            const h = Math.max(2, Math.round(v * 80));
            const isPast = playheadIdx >= 0 && i < playheadIdx;
            return (
              <View
                key={i}
                style={[
                  styles.bar,
                  {
                    height: h,
                    backgroundColor:
                      mode === 'recording' ? C.sharp :
                      isPast ? C.accent : C.inkMid,
                    opacity: mode === 'recording' && i === env.length - 1 ? 1 : 0.85,
                  },
                ]}
              />
            );
          })
        )}
        {playheadIdx >= 0 && env.length > 0 && (
          <View
            style={[
              styles.playhead,
              { left: `${(playheadIdx / Math.max(1, BAR_COUNT - 1)) * 100}%` },
            ]}
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
      height: 96,
      borderColor: C.edge,
      borderWidth: 1,
      borderRadius: 4,
      backgroundColor: C.bg,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-evenly',
      paddingHorizontal: 4,
      position: 'relative',
      overflow: 'hidden',
    },
    bar: {
      width: 4,
      marginHorizontal: BAR_GAP / 2,
      borderRadius: 1,
    },
    playhead: {
      position: 'absolute',
      top: 4, bottom: 4,
      width: 2,
      marginLeft: -1,
      backgroundColor: C.ink,
    },
    placeholder: { color: C.inkDim, fontSize: 12, letterSpacing: 4, fontWeight: '700' },
    timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, paddingHorizontal: 4 },
    timeText: { color: C.inkMid, fontSize: 12, letterSpacing: 1, fontVariant: ['tabular-nums'] },
    status: { color: C.inkDim, fontSize: 11, letterSpacing: 3, marginTop: 6, textAlign: 'center', fontWeight: '700' },
  });
}
