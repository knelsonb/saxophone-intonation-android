/**
 * TunerScreen — the TUNER tab. Mirrors the original tuner experience from
 * AppInner: cent arc, big note/cents/Hz readout (LIVE) or bucket stats card
 * (COLLECT), TAP TO LOG bar, LIVE/COLLECT slider, optional DRONE controls,
 * BottomStrip (input meter), optional DiagnosticLine.
 *
 * **Layout rule (hard):** the three main tabs (TUNER / METRO / DECK) MUST
 * fit on one screen — no ScrollView, no off-screen content. If a new feature
 * needs space it has to live elsewhere (modal, SETUP tab, collapsed by
 * default). Vertical centring is handled by `centerStyle` (flex:1) so fixed
 * controls along the bottom always remain visible.
 *
 * Stateful concerns (engine, refHz, hornNameEditor, modals) stay in App.tsx
 * and are passed down via props. This screen only renders.
 */
import React, { useMemo } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { makeStyles } from '../uiShared';
import {
  BottomStrip, BucketStatsCard,
  TapToLogCta, PeakSlideToggle, SessionStrip, DiagnosticLine,
  TunerInCarSwitch,
} from '../tunerWidgets';
import type { NoteDisplay } from '../tunerWidgets';
import { CentArcDisplay } from '../components/tunerStyles/CentArcDisplay';
import { StrobeDisplay } from '../components/tunerStyles/StrobeDisplay';
import { LedRowDisplay } from '../components/tunerStyles/LedRowDisplay';
import type { useAudioEngine } from '../useAudioEngine';
import type { DisplayMode } from '../useAudioEngine';
import type { DroneState } from '../useDrone';
import type { CarConnectionState, CallState } from '../../modules/auto-mic-claim';

export interface TunerScreenProps {
  engine: ReturnType<typeof useAudioEngine>;
  refHz: number;
  noteDisplay: NoteDisplay | null;
  isLandscape: boolean;
  noteFontSize: number;
  isOutOfRange: boolean;
  displayMode: DisplayMode;
  transp: number;
  fillAnim: Animated.Value;
  peakAnim: Animated.Value;
  showDebugOverlay: boolean;
  // Drone
  drone: DroneState;
  droneVolume: number;
  droneSemitones: number;
  setDroneVolume: (v: number) => void;
  setDroneSemitones: (n: number) => void;
  // Android Auto in-car mic claim. Previously lived in the persistent
  // header (visible on all tabs); now scoped to TUNER only since claiming
  // / releasing the mic is meaningless from METRO / DECK / SETUP.
  carState: CarConnectionState;
  callState: CallState;
  onClaimMic: () => void;
  onReleaseMic: () => void;
}

export function TunerScreen(props: TunerScreenProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  const {
    engine,
    refHz,
    noteDisplay,
    isLandscape,
    noteFontSize,
    isOutOfRange,
    displayMode,
    transp,
    fillAnim,
    peakAnim,
    showDebugOverlay,
    drone,
    droneVolume,
    droneSemitones,
    setDroneVolume,
    setDroneSemitones,
    carState,
    callState,
    onClaimMic,
    onReleaseMic,
  } = props;
  void isLandscape;

  const isListening = engine.status === 'listening';
  const centerStyle = styles.centerPortrait;
  const centsText = noteDisplay
    ? `${noteDisplay.cents >= 0 ? '+' : ''}${noteDisplay.cents.toFixed(noteDisplay.precision === 1.0 ? 0 : 1)}`
    : '+00';
  const noteLabel = noteDisplay
    ? `${noteDisplay.letter}${noteDisplay.accidental}${noteDisplay.octave}`
    : '—';

  return (
    <View style={{ flex: 1 }}>
      {carState === 'connected' && (
        <TunerInCarSwitch
          callState={callState}
          onClaim={onClaimMic}
          onRelease={onReleaseMic}
        />
      )}
      <View style={centerStyle}>
        {engine.peakLock ? (
          engine.freqHz === null ? (
            <>
              {/* Empty state: still show the chosen visualisation so the
                  layout doesn't jump on first detection. The components are
                  designed to be inert when noteDisplay is null. */}
              {engine.tunerStyle === 'strobe' ? (
                <StrobeDisplay noteDisplay={null} freqHz={null} isOutOfRange={false} />
              ) : engine.tunerStyle === 'led' ? (
                <LedRowDisplay noteDisplay={null} freqHz={null} noteFontSize={noteFontSize} isOutOfRange={false} />
              ) : (
                <CentArcDisplay noteDisplay={null} freqHz={null} noteFontSize={noteFontSize} isOutOfRange={false} />
              )}
              <View style={styles.emptyHint}>
                <Text style={styles.emptyHintText}>Play a note. Hold it for a sec.</Text>
              </View>
            </>
          ) : engine.tunerStyle === 'strobe' ? (
            <StrobeDisplay noteDisplay={noteDisplay} freqHz={engine.freqHz} isOutOfRange={isOutOfRange} />
          ) : engine.tunerStyle === 'led' ? (
            <LedRowDisplay noteDisplay={noteDisplay} freqHz={engine.freqHz} noteFontSize={noteFontSize} isOutOfRange={isOutOfRange} />
          ) : (
            <CentArcDisplay noteDisplay={noteDisplay} freqHz={engine.freqHz} noteFontSize={noteFontSize} isOutOfRange={isOutOfRange} />
          )
        ) : (
          <BucketStatsCard
            bucket={engine.activeBucket}
            displayMode={displayMode}
            a4Hz={refHz}
            transp={transp}
          />
        )}
      </View>

      {!engine.peakLock && (
        <View style={styles.collectActionRow}>
          <Pressable
            onPress={() => engine.clearActiveBucket()}
            accessibilityRole="button"
            accessibilityLabel={
              engine.activeBucket
                ? `Clear the current bucket (${engine.activeBucket.n} samples)`
                : 'Clear current bucket — disabled, no active bucket'
            }
            disabled={engine.activeBucket === null}
            style={({ pressed }) => [
              styles.statsButton,
              styles.statsButtonDanger,
              pressed && styles.statsButtonPressed,
              engine.activeBucket === null && { opacity: 0.4 },
            ]}
          >
            <Text style={[styles.statsButtonText, styles.statsButtonTextDanger]}>CLEAR</Text>
          </Pressable>
          <SessionStrip
            active={engine.sessionActive}
            startedAtMs={engine.sessionStartedAtMs}
            onToggle={engine.setSessionActive}
          />
        </View>
      )}

      <TapToLogCta
        freqHz={engine.freqHz}
        noteLabel={noteLabel}
        centsText={centsText}
        count={engine.activeBucket?.n ?? 0}
        onLog={engine.logCurrentReading}
        onUndo={engine.undoLastLog}
      />
      <View style={styles.modeRow}>
        <PeakSlideToggle value={engine.peakLock} onChange={engine.setPeakLock} />
      </View>

      {/* DRONE — toggle pill + inline volume/offset when ON. */}
      <View style={styles.droneBar}>
        {drone.enabled && (
          <View style={styles.droneControlsRow}>
            <View style={styles.droneControl}>
              <Text style={styles.droneControlLabel}>VOL</Text>
              <Pressable
                onPress={() => setDroneVolume(Math.max(0, droneVolume - 0.1))}
                accessibilityRole="button"
                accessibilityLabel="Decrease drone volume"
                style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
              >
                <Text style={styles.lowCutStepText}>−</Text>
              </Pressable>
              <Text style={styles.droneControlValue}>{Math.round(droneVolume * 100)}%</Text>
              <Pressable
                onPress={() => setDroneVolume(Math.min(1, droneVolume + 0.1))}
                accessibilityRole="button"
                accessibilityLabel="Increase drone volume"
                style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
              >
                <Text style={styles.lowCutStepText}>+</Text>
              </Pressable>
            </View>
            <View style={styles.droneControl}>
              <Text style={styles.droneControlLabel}>SEMI</Text>
              <Pressable
                onPress={() => setDroneSemitones(Math.max(-12, droneSemitones - 1))}
                accessibilityRole="button"
                accessibilityLabel="Lower drone by one semitone"
                style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
              >
                <Text style={styles.lowCutStepText}>−</Text>
              </Pressable>
              <Text style={styles.droneControlValue}>{droneSemitones > 0 ? `+${droneSemitones}` : `${droneSemitones}`}</Text>
              <Pressable
                onPress={() => setDroneSemitones(Math.min(12, droneSemitones + 1))}
                accessibilityRole="button"
                accessibilityLabel="Raise drone by one semitone"
                style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
              >
                <Text style={styles.lowCutStepText}>+</Text>
              </Pressable>
            </View>
          </View>
        )}
        <Pressable
          onPress={drone.toggle}
          accessibilityRole="switch"
          accessibilityState={{ checked: drone.enabled }}
          accessibilityLabel={drone.enabled
            ? `Drone on. Following the detected pitch with a ${droneSemitones} semitone offset. Tap to silence.`
            : 'Drone off. Tap to play a sustained reference tone that tracks your pitch.'}
          style={({ pressed }) => [
            styles.dronePill,
            drone.enabled && styles.dronePillActive,
            pressed && styles.dronePillPressed,
          ]}
        >
          <View style={[styles.dronePillDot, drone.enabled && styles.dronePillDotActive]} />
          <Text style={[styles.dronePillText, drone.enabled && styles.dronePillTextActive]}>
            {drone.enabled ? 'DRONE ON' : 'DRONE OFF'}
          </Text>
        </Pressable>
      </View>

      <BottomStrip
        fillAnim={fillAnim}
        peakAnim={peakAnim}
        rmsDb={engine.rmsDb}
        isListening={isListening}
        hiFiFallbackVisible={engine.hiFiMode && !engine.hiFiActive}
        audioSourceLabel={engine.audioSourceLabel}
      />
      {showDebugOverlay && (
        <DiagnosticLine
          rmsDb={engine.rmsDb}
          yinCallCount={engine.yinCallCount}
          rawFreqHz={engine.rawFreqHz}
        />
      )}
    </View>
  );
}
