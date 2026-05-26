/**
 * Intonation Analyzer — Android, chunk 1 of 5.
 *
 * Professional chromatic-tuner faceplate. The audio pipeline is wired
 * end-to-end (mic permission, recording with metering, animated input
 * strip), but pitch detection lands in chunk 2. Until then the
 * centerpiece readouts (note, cent arc, Hz) show idle placeholders that
 * look like a tuner warming up — not lorem ipsum, not TODO.
 *
 * Visual reference set: Korg TM-60, Peterson StroboPlus HD, Boss TU-3,
 * TonalEnergy. Dark panel, monochrome ink, single accent for the active
 * indicator, restrained typography. The only animated element in this
 * chunk is the input level strip along the bottom edge.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
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

const APP_NAME = 'INTONATION ANALYZER';
const APP_VERSION = '0.1.0';
const STAGE_LABEL = 'pipeline test · 1 of 5';
const REFERENCE_HZ = 440;

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

// Cent arc geometry. We span ±50 cents across an arc of N tick marks,
// with the center mark slightly taller. The arc is drawn as a row of
// positioned View segments — no SVG dependency.
const CENT_TICK_COUNT = 21; // -50, -45, ..., 0, ..., +45, +50
const CENT_RANGE = 50;

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

  // Status line tracks where we are in the boot sequence. The user sees
  // this as the small word under the note: NO MIC / WAITING / LISTENING.
  const status =
    permission === 'unknown'
      ? 'WAITING FOR MIC'
      : !recording
      ? 'WARMING UP'
      : 'LISTENING';

  return (
    <View style={styles.root}>
      <View style={styles.faceplate}>
        <TopBar status={status} />
        <CenterReadout />
        <BottomStrip
          fill={fill}
          peak={peak}
          levelDb={levelDb}
          recording={recording}
        />
      </View>
    </View>
  );
}

function TopBar({ status }: { status: string }) {
  return (
    <View style={styles.topBar}>
      <View style={styles.topLeft}>
        <Text style={styles.brand}>{APP_NAME}</Text>
        <Text style={styles.brandVersion}>v{APP_VERSION}</Text>
      </View>
      <View style={styles.topRight}>
        <Text style={styles.refLabel}>REF</Text>
        <Text style={styles.refValue}>A = {REFERENCE_HZ} Hz</Text>
        <View style={styles.statusPill}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>{status}</Text>
        </View>
      </View>
    </View>
  );
}

function CenterReadout() {
  // Idle state for chunk 1: no pitch yet. Note slot shows an em-dash in
  // the same weight the real note will use, octave is blank, Hz is dim
  // placeholder. The cent arc sits at center with no active deflection.
  return (
    <View style={styles.center}>
      <CentArc activeIndex={null} />
      <View style={styles.noteRow}>
        <View style={styles.noteSlot}>
          <Text style={styles.note}>—</Text>
          <Text style={styles.accidental}> </Text>
        </View>
        <Text style={styles.octave}> </Text>
      </View>
      <View style={styles.hzRow}>
        <Text style={styles.hzValue}>— — —</Text>
        <Text style={styles.hzUnit}>Hz</Text>
      </View>
      <View style={styles.centValueRow}>
        <Text style={styles.centValueLabel}>CENTS</Text>
        <Text style={styles.centValue}>+00</Text>
      </View>
    </View>
  );
}

function CentArc({ activeIndex }: { activeIndex: number | null }) {
  // Render the ±50¢ deflection scale as a row of vertical tick marks.
  // Center tick (0¢) is taller and brighter. The "needle" is a thin
  // vertical bar over the active tick — null means no signal, in which
  // case we still render a dim marker at zero so the layout reads as
  // calibrated rather than empty.
  const ticks = useMemo(() => {
    const arr: { cents: number; major: boolean; center: boolean }[] = [];
    for (let i = 0; i < CENT_TICK_COUNT; i++) {
      const cents = -CENT_RANGE + (i * (CENT_RANGE * 2)) / (CENT_TICK_COUNT - 1);
      const isCenter = Math.abs(cents) < 0.001;
      const major = isCenter || cents === -CENT_RANGE || cents === CENT_RANGE;
      arr.push({ cents, major, center: isCenter });
    }
    return arr;
  }, []);

  const needleIdx = activeIndex ?? Math.floor(CENT_TICK_COUNT / 2);
  const needleActive = activeIndex !== null;

  return (
    <View style={styles.arc}>
      <View style={styles.arcScaleRow}>
        <Text style={styles.arcEnd}>-50</Text>
        <Text style={styles.arcEnd}>-25</Text>
        <Text style={styles.arcCenterLabel}>0</Text>
        <Text style={styles.arcEnd}>+25</Text>
        <Text style={styles.arcEnd}>+50</Text>
      </View>
      <View style={styles.arcTrack}>
        {ticks.map((t, i) => (
          <View
            key={i}
            style={[
              styles.arcTick,
              t.major && styles.arcTickMajor,
              t.center && styles.arcTickCenter,
              i === needleIdx && needleActive && styles.arcTickActive,
            ]}
          />
        ))}
        <View
          style={[
            styles.arcNeedle,
            {
              left: `${(needleIdx / (CENT_TICK_COUNT - 1)) * 100}%`,
              opacity: needleActive ? 1 : 0.35,
            },
          ]}
        />
      </View>
      <View style={styles.arcZones}>
        <View style={[styles.arcZone, styles.arcZoneFlat]} />
        <View style={[styles.arcZone, styles.arcZoneInTune]} />
        <View style={[styles.arcZone, styles.arcZoneSharp]} />
      </View>
    </View>
  );
}

function BottomStrip({
  fill,
  peak,
  levelDb,
  recording,
}: {
  fill: Animated.Value;
  peak: Animated.Value;
  levelDb: number;
  recording: boolean;
}) {
  return (
    <View style={styles.bottom}>
      <View style={styles.bottomLeft}>
        <Text style={styles.bottomLabel}>INPUT</Text>
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
          <View style={[styles.meterTick, { left: `${tickPct(-40)}%` }]} />
          <View style={[styles.meterTick, { left: `${tickPct(-20)}%` }]} />
          <View style={[styles.meterTickHot, { left: `${tickPct(-6)}%` }]} />
        </View>
        <View style={styles.meterScale}>
          <Text style={styles.meterScaleTick}>-60</Text>
          <Text style={styles.meterScaleTick}>-40</Text>
          <Text style={styles.meterScaleTick}>-20</Text>
          <Text style={[styles.meterScaleTick, styles.meterScaleTickHot]}>
            -6 dB
          </Text>
        </View>
      </View>
      <View style={styles.bottomRight}>
        <Text style={styles.dbValue}>
          {recording ? `${levelDb.toFixed(0)}` : '--'}
          <Text style={styles.dbUnit}> dBFS</Text>
        </Text>
        <Text style={styles.stage}>{STAGE_LABEL}</Text>
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
        <TopBar status="NO MIC" />
        <View style={styles.gate}>
          <Text style={styles.gateTitle}>MICROPHONE REQUIRED</Text>
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
        <View style={styles.gateFooter}>
          <Text style={styles.stage}>{STAGE_LABEL}</Text>
        </View>
      </View>
    </View>
  );
}

const C = {
  bg: '#07080b',
  face: '#0e1116',
  edge: '#1e242e',
  edgeSoft: '#161b22',
  ink: '#f0f1f3',
  inkMid: '#a6acb6',
  inkDim: '#5a626d',
  inkVeryDim: '#3a4049',
  accent: '#d6b86a', // Peterson-amber ink
  inTune: '#5fb87a',
  flat: '#5b8fb8',
  sharp: '#b8635f',
  hot: '#d6b86a',
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
    padding: 16,
  },
  faceplate: {
    flex: 1,
    backgroundColor: C.face,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 28,
    paddingVertical: 18,
  },

  // Top bar -------------------------------------------------------------
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomColor: C.edgeSoft,
    borderBottomWidth: 1,
    paddingBottom: 12,
  },
  topLeft: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 14,
  },
  topRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  brand: {
    color: C.ink,
    fontSize: 14,
    letterSpacing: 6,
    fontWeight: '600',
  },
  brandVersion: {
    color: C.inkDim,
    fontSize: 10,
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  refLabel: {
    color: C.inkDim,
    fontSize: 10,
    letterSpacing: 3,
  },
  refValue: {
    color: C.inkMid,
    fontSize: 12,
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 2,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.accent,
  },
  statusText: {
    color: C.inkMid,
    fontSize: 10,
    letterSpacing: 3,
  },

  // Center readout ------------------------------------------------------
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  arc: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
  },
  arcScaleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  arcEnd: {
    color: C.inkDim,
    fontSize: 11,
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  arcCenterLabel: {
    color: C.inkMid,
    fontSize: 11,
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  arcTrack: {
    height: 38,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    position: 'relative',
  },
  arcTick: {
    width: 1,
    height: 10,
    backgroundColor: C.inkVeryDim,
  },
  arcTickMajor: {
    height: 18,
    backgroundColor: C.inkDim,
  },
  arcTickCenter: {
    width: 2,
    height: 26,
    backgroundColor: C.inkMid,
  },
  arcTickActive: {
    backgroundColor: C.accent,
  },
  arcNeedle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    marginLeft: -1,
    backgroundColor: C.accent,
  },
  arcZones: {
    flexDirection: 'row',
    marginTop: 4,
    height: 2,
  },
  arcZone: {
    height: 2,
  },
  arcZoneFlat: {
    flex: 35,
    backgroundColor: C.flat,
    opacity: 0.35,
  },
  arcZoneInTune: {
    flex: 30,
    backgroundColor: C.inTune,
    opacity: 0.5,
  },
  arcZoneSharp: {
    flex: 35,
    backgroundColor: C.sharp,
    opacity: 0.35,
  },

  noteRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    marginTop: 18,
  },
  noteSlot: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  note: {
    color: C.ink,
    fontSize: 180,
    lineHeight: 184,
    fontWeight: '300',
    letterSpacing: -2,
    fontVariant: ['tabular-nums'],
  },
  accidental: {
    color: C.inkMid,
    fontSize: 80,
    lineHeight: 100,
    fontWeight: '300',
    marginTop: 18,
  },
  octave: {
    color: C.inkDim,
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    marginLeft: 10,
    marginTop: 30,
    letterSpacing: 1,
  },

  hzRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginTop: -8,
  },
  hzValue: {
    color: C.inkMid,
    fontSize: 22,
    letterSpacing: 4,
    fontVariant: ['tabular-nums'],
  },
  hzUnit: {
    color: C.inkDim,
    fontSize: 12,
    letterSpacing: 3,
  },

  centValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    marginTop: 10,
  },
  centValueLabel: {
    color: C.inkDim,
    fontSize: 10,
    letterSpacing: 3,
  },
  centValue: {
    color: C.inkMid,
    fontSize: 14,
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },

  // Bottom strip --------------------------------------------------------
  bottom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
    borderTopColor: C.edgeSoft,
    borderTopWidth: 1,
    paddingTop: 12,
  },
  bottomLeft: {
    flex: 1,
  },
  bottomLabel: {
    color: C.inkDim,
    fontSize: 10,
    letterSpacing: 3,
    marginBottom: 6,
  },
  meterTrack: {
    height: 10,
    backgroundColor: C.bg,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 1,
    overflow: 'hidden',
  },
  meterFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: C.accent,
    opacity: 0.85,
  },
  peakMark: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: C.ink,
  },
  meterTick: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: C.edge,
  },
  meterTickHot: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: C.hot,
    opacity: 0.6,
  },
  meterScale: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  meterScaleTick: {
    color: C.inkDim,
    fontSize: 9,
    letterSpacing: 1,
    fontVariant: ['tabular-nums'],
  },
  meterScaleTickHot: {
    color: C.hot,
  },
  bottomRight: {
    alignItems: 'flex-end',
    minWidth: 140,
  },
  dbValue: {
    color: C.inkMid,
    fontSize: 18,
    letterSpacing: 1,
    fontVariant: ['tabular-nums'],
  },
  dbUnit: {
    color: C.inkDim,
    fontSize: 11,
    letterSpacing: 2,
  },
  stage: {
    color: C.inkDim,
    fontSize: 10,
    letterSpacing: 2,
    marginTop: 4,
  },

  // Permission gate -----------------------------------------------------
  gate: {
    flex: 1,
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gateTitle: {
    color: C.ink,
    fontSize: 16,
    letterSpacing: 4,
    marginBottom: 16,
  },
  gateBody: {
    color: C.inkMid,
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 480,
    marginBottom: 28,
  },
  gateBtn: {
    backgroundColor: 'transparent',
    borderColor: C.accent,
    borderWidth: 1,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 2,
  },
  gateBtnPressed: {
    opacity: 0.6,
  },
  gateBtnText: {
    color: C.accent,
    fontSize: 12,
    letterSpacing: 4,
  },
  gateFooter: {
    alignItems: 'flex-end',
    borderTopColor: C.edgeSoft,
    borderTopWidth: 1,
    paddingTop: 12,
  },
});
