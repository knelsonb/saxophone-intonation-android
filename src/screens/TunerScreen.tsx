/**
 * TunerScreen — v1.3 (top-pill nav + CUSTOMIZATION sub-page).
 *
 * Two sub-pages under a TopPillNav:
 *   - TUNER → existing tuner body (CentArc/Strobe/LedRow + NoteReadout + Drone
 *             bar + BottomStrip). Layout unchanged from v1.2.1.
 *   - CUSTOMIZATION → per F10 + G17, absorbs from SETUP:
 *       • TUNER STYLE picker (arc/strobe/led)
 *       • DRONE VOICE picker (5 presets + 128-GM expander)
 *       • DRONE volume + semitones steppers
 *       • PIPES VOICE picker (same idiom, U25-locked default GM 80)
 *     This sub-page MAY scroll (it's an editor surface).
 *
 * Sub-page state is local to this screen, never persisted; tab return lands
 * the user on TUNER.
 *
 * Layout invariant (carried from v1.2): the TUNER sub-page must fit on one
 * screen without ScrollView — the v1.2.1 emptyHint reservation fix is
 * preserved unchanged.
 */
import React, { useMemo, useState } from 'react';
import { Animated, Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { makeStyles, DRAG_FRIENDLY_PRESS_DELAY_MS } from '../uiShared';
import {
  BottomStrip, BucketStatsCard,
  TapToLogCta, PeakSlideToggle, SessionStrip, DiagnosticLine,
  TunerInCarSwitch,
} from '../tunerWidgets';
import type { NoteDisplay } from '../tunerWidgets';
import { CentArcDisplay } from '../components/tunerStyles/CentArcDisplay';
import { StrobeDisplay } from '../components/tunerStyles/StrobeDisplay';
import { LedRowDisplay } from '../components/tunerStyles/LedRowDisplay';
import { TopPillNav } from '../components/TopPillNav';
import type { useAudioEngine } from '../useAudioEngine';
import type { DisplayMode } from '../useAudioEngine';
import type { DroneState } from '../useDrone';
import type { CarConnectionState, CallState } from '../../modules/auto-mic-claim';
import { DRONE_PRESETS, DRONE_FULL_GM, resolveDroneVoice } from '../droneVoices';

type SubPage = 'tuner' | 'customization';

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
  // v1.3 — drone voice id (per F10 move from SETUP).
  droneVoice: string;
  setDroneVoice: (v: string) => void;
  // v1.3 — pipes voice GM program 0..127 (per G17 move from SETUP).
  pipesVoice: number;
  setPipesVoice: (program: number) => void;
  // Android Auto in-car mic claim.
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
    droneVoice,
    setDroneVoice,
    pipesVoice,
    setPipesVoice,
    carState,
    callState,
    onClaimMic,
    onReleaseMic,
  } = props;
  void isLandscape;
  void refHz;

  // v1.3 — sub-page state. Local-only; tab return lands on TUNER.
  const [subPage, setSubPage] = useState<SubPage>('tuner');

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
      {/* v1.3 — top-pill nav. Locked height across sub-page swaps. */}
      <TopPillNav<SubPage>
        options={[
          { key: 'tuner', label: 'TUNER' },
          { key: 'customization', label: 'CUSTOMIZATION' },
        ]}
        active={subPage}
        onChange={setSubPage}
      />

      {subPage === 'tuner' ? (
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
              <>
                {engine.tunerStyle === 'strobe' ? (
                  <StrobeDisplay noteDisplay={noteDisplay} freqHz={engine.freqHz} isOutOfRange={isOutOfRange} />
                ) : engine.tunerStyle === 'led' ? (
                  <LedRowDisplay noteDisplay={noteDisplay} freqHz={engine.freqHz} noteFontSize={noteFontSize} isOutOfRange={isOutOfRange} />
                ) : (
                  <CentArcDisplay noteDisplay={noteDisplay} freqHz={engine.freqHz} noteFontSize={noteFontSize} isOutOfRange={isOutOfRange} />
                )}
                {/* v1.2.1 — empty-state hint always rendered to reserve its
                    vertical space; opacity drops to 0 once a note is detected. */}
                <View style={styles.emptyHint} pointerEvents="none">
                  <Text style={[styles.emptyHintText, engine.freqHz !== null && { opacity: 0 }]}>
                    Play a note. Hold it for a sec.
                  </Text>
                </View>
              </>
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
      ) : (
        // v1.3 — CUSTOMIZATION sub-page. Per F10 + G17 absorbs from SETUP:
        // TUNER STYLE + DRONE VOICE + drone vol/semis + PIPES VOICE.
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 24 }}
          showsVerticalScrollIndicator
          persistentScrollbar
        >
          {/* TUNER STYLE */}
          <View style={styles.settingsGroup}>
            <Text style={styles.settingsGroupLabel}>TUNER STYLE</Text>
            <View style={styles.settingsRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingsRowLabel}>Visual</Text>
                <Text style={styles.settingsRowHint}>
                  ARC is the cents arc + needle. STROBE imitates a Peterson strobe. LED is a stage-tuner-style row of dots.
                </Text>
              </View>
              <View style={styles.settingsToggle}>
                {(['arc', 'strobe', 'led'] as const).map((v) => {
                  const selected = engine.tunerStyle === v;
                  const label = v === 'arc' ? 'ARC' : v === 'strobe' ? 'STROBE' : 'LED';
                  return (
                    <Pressable
                      key={v}
                      onPress={() => engine.setTunerStyle(v)}
                      unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Tuner style ${label}`}
                      style={({ pressed }) => [styles.gainPill, selected && styles.gainPillActive, pressed && styles.gainPillPressed]}
                    >
                      <Text style={[styles.gainPillText, selected && styles.gainPillTextActive]}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </View>

          {/* DRONE VOICE (moved from SETUP per F10) */}
          <DroneVoicePicker droneVoice={droneVoice} setDroneVoice={setDroneVoice} styles={styles} C={C} />

          {/* DRONE volume + semitones (moved from SETUP per F10) */}
          <View style={styles.settingsGroup}>
            <Text style={styles.settingsGroupLabel}>DRONE LEVEL</Text>
            <View style={styles.settingsRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingsRowLabel}>Volume</Text>
                <Text style={styles.settingsRowHint}>0% silences the drone but keeps it armed.</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Pressable
                  onPress={() => setDroneVolume(Math.max(0, droneVolume - 0.1))}
                  unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                  accessibilityRole="button"
                  accessibilityLabel="Decrease drone volume by 10%"
                  style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
                >
                  <Text style={styles.lowCutStepText}>−</Text>
                </Pressable>
                <Text style={styles.settingsRowValue}>{Math.round(droneVolume * 100)}%</Text>
                <Pressable
                  onPress={() => setDroneVolume(Math.min(1, droneVolume + 0.1))}
                  unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                  accessibilityRole="button"
                  accessibilityLabel="Increase drone volume by 10%"
                  style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
                >
                  <Text style={styles.lowCutStepText}>+</Text>
                </Pressable>
              </View>
            </View>
            <View style={styles.settingsRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.settingsRowLabel}>Semitones</Text>
                <Text style={styles.settingsRowHint}>Offset relative to the detected pitch.</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Pressable
                  onPress={() => setDroneSemitones(Math.max(-12, droneSemitones - 1))}
                  unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                  accessibilityRole="button"
                  accessibilityLabel="Lower drone by one semitone"
                  style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
                >
                  <Text style={styles.lowCutStepText}>−</Text>
                </Pressable>
                <Text style={styles.settingsRowValue}>{droneSemitones > 0 ? `+${droneSemitones}` : droneSemitones}</Text>
                <Pressable
                  onPress={() => setDroneSemitones(Math.min(12, droneSemitones + 1))}
                  unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                  accessibilityRole="button"
                  accessibilityLabel="Raise drone by one semitone"
                  style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
                >
                  <Text style={styles.lowCutStepText}>+</Text>
                </Pressable>
              </View>
            </View>
          </View>

          {/* PIPES VOICE (per G17) — same idiom as DroneVoicePicker but
              backed by a numeric GM program 0..127 (no preset id catalog). */}
          <PipesVoicePicker pipesVoice={pipesVoice} setPipesVoice={setPipesVoice} styles={styles} C={C} />
        </ScrollView>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// DroneVoicePicker — relocated from SETUP per F10. Identical surface to v1.2.
// ---------------------------------------------------------------------------

interface DroneVoicePickerProps {
  droneVoice: string;
  setDroneVoice: (id: string) => void;
  styles: ReturnType<typeof makeStyles>;
  C: import('../theme').ThemePalette;
}

function DroneVoicePicker({ droneVoice, setDroneVoice, styles, C }: DroneVoicePickerProps) {
  const [expanded, setExpanded] = useState(false);
  const presetIds = useMemo(() => DRONE_PRESETS.map((v) => v.id), []);
  const isPresetSelected = presetIds.includes(droneVoice);
  const resolved = resolveDroneVoice(droneVoice);

  return (
    <View style={styles.settingsGroup}>
      <Text style={styles.settingsGroupLabel}>DRONE VOICE</Text>

      <View style={styles.setupVoicePresetRow}>
        {DRONE_PRESETS.map((voice) => {
          const selected = droneVoice === voice.id;
          return (
            <Pressable
              key={voice.id}
              onPress={() => setDroneVoice(voice.id)}
              unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`Select ${voice.label} drone voice, General MIDI patch ${String(voice.program).padStart(3, '0')}`}
              style={({ pressed }) => [
                styles.metroSigPill,
                selected && styles.metroSigPillActive,
                pressed && styles.gainPillPressed,
              ]}
            >
              <Text style={[styles.metroSigPillText, selected && styles.metroSigPillTextActive]}>
                {voice.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {!isPresetSelected && (
        <Text style={styles.setupVoiceSelectedHint}>
          Selected: {resolved.label} (GM {String(resolved.program).padStart(3, '0')})
        </Text>
      )}

      <Pressable
        onPress={() => setExpanded((e) => !e)}
        unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse full voice list' : 'Browse all 128 General MIDI voices'}
        style={({ pressed }) => [styles.setupVoiceMoreBtn, pressed && styles.gainPillPressed]}
      >
        <Text style={styles.setupVoiceMoreText}>
          {expanded ? 'Hide voices ▲' : 'More voices · 128 GM patches ▼'}
        </Text>
      </Pressable>

      {expanded && (
        <View style={styles.setupVoiceListWrap}>
          <ScrollView
            style={styles.setupVoiceListScroll}
            showsVerticalScrollIndicator
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
          >
            {DRONE_FULL_GM.map((voice) => {
              const selected = droneVoice === voice.id;
              return (
                <Pressable
                  key={voice.id}
                  onPress={() => setDroneVoice(voice.id)}
                  unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Select ${voice.label} drone voice, General MIDI patch ${String(voice.program).padStart(3, '0')}`}
                  style={({ pressed }) => [
                    styles.setupVoiceGmRow,
                    selected && styles.setupVoiceGmRowSelected,
                    pressed && styles.setupVoiceGmRowPressed,
                  ]}
                >
                  <Text style={[styles.setupVoiceGmProgram, selected && { color: C.accent }]}>
                    {String(voice.program).padStart(3, '0')}
                  </Text>
                  <Text style={[styles.setupVoiceGmLabel, selected && { color: C.accent, fontWeight: '700' }]}>
                    {voice.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// PipesVoicePicker — v1.3 per G17. The pipes API is GM-program-numeric
// (no id catalog), so the picker drives directly off DRONE_FULL_GM by
// program-number lookup. Five curated quick-picks at top + the 128-entry
// expander identical to the drone picker idiom.
// ---------------------------------------------------------------------------

interface PipesVoicePickerProps {
  pipesVoice: number;
  setPipesVoice: (program: number) => void;
  styles: ReturnType<typeof makeStyles>;
  C: import('../theme').ThemePalette;
}

// v1.3 — five curated quick-pick programs that play well as sustained pipes.
// Includes the U25-locked default GM 80 first so the user can return to it
// in one tap.
const PIPES_QUICK_PICKS: ReadonlyArray<{ program: number; label: string }> = [
  { program: 80, label: 'Square Lead' },   // U25 default
  { program: 73, label: 'Flute' },
  { program: 74, label: 'Recorder' },
  { program: 78, label: 'Whistle' },
  { program: 71, label: 'Clarinet' },
];

function PipesVoicePicker({ pipesVoice, setPipesVoice, styles, C }: PipesVoicePickerProps) {
  const [expanded, setExpanded] = useState(false);
  const isQuickPick = PIPES_QUICK_PICKS.some((q) => q.program === pipesVoice);
  const resolvedLabel = DRONE_FULL_GM[pipesVoice]?.label ?? `GM ${pipesVoice}`;

  return (
    <View style={styles.settingsGroup}>
      <Text style={styles.settingsGroupLabel}>PIPES VOICE</Text>

      <View style={styles.setupVoicePresetRow}>
        {PIPES_QUICK_PICKS.map((q) => {
          const selected = pipesVoice === q.program;
          return (
            <Pressable
              key={q.program}
              onPress={() => setPipesVoice(q.program)}
              unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`Select ${q.label} pipes voice, General MIDI patch ${String(q.program).padStart(3, '0')}`}
              style={({ pressed }) => [
                styles.metroSigPill,
                selected && styles.metroSigPillActive,
                pressed && styles.gainPillPressed,
              ]}
            >
              <Text style={[styles.metroSigPillText, selected && styles.metroSigPillTextActive]}>
                {q.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {!isQuickPick && (
        <Text style={styles.setupVoiceSelectedHint}>
          Selected: {resolvedLabel} (GM {String(pipesVoice).padStart(3, '0')})
        </Text>
      )}

      <Pressable
        onPress={() => setExpanded((e) => !e)}
        unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse full pipes voice list' : 'Browse all 128 General MIDI voices for pipes'}
        style={({ pressed }) => [styles.setupVoiceMoreBtn, pressed && styles.gainPillPressed]}
      >
        <Text style={styles.setupVoiceMoreText}>
          {expanded ? 'Hide voices ▲' : 'More voices · 128 GM patches ▼'}
        </Text>
      </Pressable>

      {expanded && (
        <View style={styles.setupVoiceListWrap}>
          <ScrollView
            style={styles.setupVoiceListScroll}
            showsVerticalScrollIndicator
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
          >
            {DRONE_FULL_GM.map((voice) => {
              const selected = pipesVoice === voice.program;
              return (
                <Pressable
                  key={`pipes-${voice.program}`}
                  onPress={() => setPipesVoice(voice.program)}
                  unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Select ${voice.label} pipes voice, General MIDI patch ${String(voice.program).padStart(3, '0')}`}
                  style={({ pressed }) => [
                    styles.setupVoiceGmRow,
                    selected && styles.setupVoiceGmRowSelected,
                    pressed && styles.setupVoiceGmRowPressed,
                  ]}
                >
                  <Text style={[styles.setupVoiceGmProgram, selected && { color: C.accent }]}>
                    {String(voice.program).padStart(3, '0')}
                  </Text>
                  <Text style={[styles.setupVoiceGmLabel, selected && { color: C.accent, fontWeight: '700' }]}>
                    {voice.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}
    </View>
  );
}
