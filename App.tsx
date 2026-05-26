/**
 * Intonation Analyzer — Android, chunk 1 of 5.
 *
 * This chunk only proves the audio pipeline end-to-end. We request mic
 * permission, open a recording with metering enabled, and drive a
 * faceplate-style level meter from the metering callback. No pitch
 * detection, no notes, no table — that's chunks 2-4.
 *
 * The visual language is "stripped-back hardware tuner": dark faceplate,
 * thin metal frame, single readout, no chrome that doesn't earn its
 * pixels. Korg/Peterson-adjacent.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  AudioModule,
  RecordingPresets,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

const APP_NAME = 'INTONATION';
const APP_SUBTITLE = 'ANALYZER';
const APP_VERSION = '0.1.0';
const STAGE_LABEL = 'pipeline test · 1 of 5';

// Metering returns dBFS in roughly [-160, 0]. Anything below the noise
// floor we treat as silence; anything above the headroom mark we treat
// as full deflection. Tuned for vocal/instrument input on a tablet mic.
const METER_FLOOR_DB = -60;
const METER_CEIL_DB = -6;

// Peak hold decay (units per second). The peak marker snaps up to a new
// max instantly, then drifts back down at this rate — same behavior as
// every studio level meter for the last forty years.
const PEAK_DECAY_PER_SEC = 0.6;

// Idle glow keeps the meter from looking dead at silence. Tiny.
const IDLE_GLOW = 0.02;

export default function App() {
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>(
    'unknown'
  );
  const [recording, setRecording] = useState(false);
  const [levelDb, setLevelDb] = useState<number>(METER_FLOOR_DB);

  // Smoothed bar fill (0..1). Animated values so the bar moves on the
  // UI thread without re-rendering React each frame.
  const fill = useRef(new Animated.Value(IDLE_GLOW)).current;
  const peak = useRef(new Animated.Value(IDLE_GLOW)).current;
  const peakValue = useRef(IDLE_GLOW);
  const peakUpdatedAt = useRef(Date.now());

  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });

  // RecordingStatus (the statusListener event payload) does not carry metering.
  // Metering lives on RecorderState, surfaced by useAudioRecorderState at the
  // requested poll interval. 100ms keeps the meter visually smooth without
  // hammering the bridge.
  const recorderState = useAudioRecorderState(recorder, 100);

  // Request mic permission once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await AudioModule.requestRecordingPermissionsAsync();
      if (cancelled) return;
      setPermission(res.granted ? 'granted' : 'denied');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Once permission lands, start (and keep) recording for chunk 1.
  // We never save the file — we only consume the metering stream. The
  // recorder must be told to .record() before metering ticks fire;
  // .prepareToRecordAsync() alone isn't enough.
  //
  // dep array: [permission] only. recorder is a stable SharedObject reference
  // (useAudioRecorder uses useReleasingSharedObject keyed on JSON-stringified
  // options), so listing it here would only re-fire the effect if the options
  // object changes, which we never do. eslint-disable-next-line is intentional.
  useEffect(() => {
    if (permission !== 'granted') return;

    // prepared tracks whether prepareToRecordAsync completed so the cleanup
    // path can avoid calling stop() on an unprepared recorder, which would
    // race against the still-running prepare.
    let prepared = false;
    let cancelled = false;

    (async () => {
      try {
        await recorder.prepareToRecordAsync();
        prepared = true;
        if (cancelled) {
          // Cleanup ran while we were preparing — stop now that we're safe.
          recorder.stop().catch(() => {});
          return;
        }
        recorder.record();
        setRecording(true);
      } catch {
        // Recording failure surfaces as a frozen meter — be honest
        // rather than silently swallow.
        if (!cancelled) setPermission('denied');
      }
    })();

    return () => {
      cancelled = true;
      if (prepared) {
        recorder.stop().catch(() => {});
      }
      // If not prepared, the async block will call stop() once prepare
      // resolves and sees the cancelled flag.
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission]);

  // Feed the recorderState metering into levelDb state so the display
  // and the animated bar both stay current.
  useEffect(() => {
    if (typeof recorderState.metering === 'number') {
      setLevelDb(recorderState.metering);
    }
  }, [recorderState.metering]);

  // Drive the animated bar + peak hold from the latest dB sample.
  useEffect(() => {
    const norm =
      (levelDb - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB);
    const clamped = Math.min(1, Math.max(IDLE_GLOW, norm));

    Animated.spring(fill, {
      toValue: clamped,
      useNativeDriver: false,
      damping: 18,
      stiffness: 140,
      mass: 0.4,
    }).start();

    const now = Date.now();
    const elapsed = (now - peakUpdatedAt.current) / 1000;
    const decayed = Math.max(
      IDLE_GLOW,
      peakValue.current - PEAK_DECAY_PER_SEC * elapsed
    );
    const newPeak = Math.max(decayed, clamped);
    peakValue.current = newPeak;
    peakUpdatedAt.current = now;
    Animated.timing(peak, {
      toValue: newPeak,
      duration: 60,
      useNativeDriver: false,
    }).start();
  }, [levelDb, fill, peak]);

  const requestAgain = async () => {
    const res = await AudioModule.requestRecordingPermissionsAsync();
    setPermission(res.granted ? 'granted' : 'denied');
  };

  if (permission === 'denied') {
    return <PermissionGate onRetry={requestAgain} />;
  }

  return (
    <View style={styles.root}>
      <View style={styles.faceplate}>
        <View style={styles.brandRow}>
          <Text style={styles.brand}>{APP_NAME}</Text>
          <Text style={styles.brandSub}>{APP_SUBTITLE}</Text>
        </View>

        <View style={styles.readout}>
          <Text style={styles.readoutLabel}>INPUT LEVEL</Text>
          <View style={styles.meterTrack}>
            <Animated.View
              style={[
                styles.meterFill,
                {
                  width: fill.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0%', '100%'],
                  }),
                },
              ]}
            />
            <Animated.View
              style={[
                styles.peakMark,
                {
                  left: peak.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0%', '100%'],
                  }),
                },
              ]}
            />
            <View style={[styles.tick, { left: `${tickPct(-40)}%` }]} />
            <View style={[styles.tick, { left: `${tickPct(-20)}%` }]} />
            <View
              style={[styles.tickHot, { left: `${tickPct(-6)}%` }]}
            />
          </View>
          <View style={styles.scale}>
            <Text style={styles.scaleTick}>-60</Text>
            <Text style={styles.scaleTick}>-40</Text>
            <Text style={styles.scaleTick}>-20</Text>
            <Text style={[styles.scaleTick, styles.scaleTickHot]}>-6 dB</Text>
          </View>
          <Text style={styles.readoutValue}>
            {recording ? `${levelDb.toFixed(0)} dBFS` : 'INIT…'}
          </Text>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerL}>v{APP_VERSION}</Text>
          <Text style={styles.footerR}>{STAGE_LABEL}</Text>
        </View>
      </View>
    </View>
  );
}

function tickPct(db: number): number {
  const n = (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB);
  return Math.max(0, Math.min(100, n * 100));
}

function PermissionGate({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.root}>
      <View style={styles.faceplate}>
        <View style={styles.brandRow}>
          <Text style={styles.brand}>{APP_NAME}</Text>
          <Text style={styles.brandSub}>{APP_SUBTITLE}</Text>
        </View>
        <View style={styles.gate}>
          <Text style={styles.gateTitle}>Microphone needed</Text>
          <Text style={styles.gateBody}>
            The tuner reads your horn through the microphone. Audio is
            processed on-device and never leaves the tablet.
          </Text>
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Allow microphone access"
            style={({ pressed }) => [
              styles.gateBtn,
              pressed && styles.gateBtnPressed,
            ]}
          >
            <Text style={styles.gateBtnText}>ALLOW MICROPHONE</Text>
          </Pressable>
        </View>
        <View style={styles.footer}>
          <Text style={styles.footerL}>v{APP_VERSION}</Text>
          <Text style={styles.footerR}>{STAGE_LABEL}</Text>
        </View>
      </View>
    </View>
  );
}

const C = {
  bg: '#0b0c10',
  face: '#15181f',
  edge: '#2a2f3a',
  ink: '#e8e8ea',
  inkDim: '#7a8089',
  accent: '#6ec1e4',
  hot: '#e0a13a',
  glow: '#1f3a4a',
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  faceplate: {
    width: '100%',
    maxWidth: 880,
    backgroundColor: C.face,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 6,
    padding: 28,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    borderBottomColor: C.edge,
    borderBottomWidth: 1,
    paddingBottom: 14,
    marginBottom: 22,
  },
  brand: {
    color: C.ink,
    fontSize: 22,
    letterSpacing: 6,
    fontWeight: '600',
  },
  brandSub: {
    color: C.inkDim,
    fontSize: 14,
    letterSpacing: 4,
  },
  readout: {
    paddingVertical: 18,
  },
  readoutLabel: {
    color: C.inkDim,
    fontSize: 11,
    letterSpacing: 3,
    marginBottom: 12,
  },
  meterTrack: {
    height: 28,
    backgroundColor: C.bg,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 3,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  meterFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: C.accent,
    shadowColor: C.accent,
    shadowOpacity: 0.5,
    shadowRadius: 6,
  },
  peakMark: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: C.ink,
  },
  tick: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: C.edge,
    opacity: 0.6,
  },
  tickHot: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: C.hot,
    opacity: 0.7,
  },
  scale: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  scaleTick: {
    color: C.inkDim,
    fontSize: 10,
    letterSpacing: 1,
  },
  scaleTickHot: {
    color: C.hot,
  },
  readoutValue: {
    marginTop: 26,
    color: C.ink,
    fontSize: 38,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
    letterSpacing: 2,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 22,
    paddingTop: 12,
    borderTopColor: C.edge,
    borderTopWidth: 1,
  },
  footerL: {
    color: C.inkDim,
    fontSize: 11,
    letterSpacing: 2,
  },
  footerR: {
    color: C.inkDim,
    fontSize: 11,
    letterSpacing: 2,
  },
  gate: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  gateTitle: {
    color: C.ink,
    fontSize: 18,
    letterSpacing: 3,
    marginBottom: 16,
  },
  gateBody: {
    color: C.inkDim,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 440,
    marginBottom: 28,
  },
  gateBtn: {
    backgroundColor: C.glow,
    borderColor: C.accent,
    borderWidth: 1,
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 4,
  },
  gateBtnPressed: {
    opacity: 0.7,
  },
  gateBtnText: {
    color: C.accent,
    fontSize: 13,
    letterSpacing: 3,
  },
});
