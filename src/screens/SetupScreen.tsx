/**
 * SetupScreen — the SETUP tab. Hosts everything that lived in the old
 * SettingsSheet modal: AUDIO SOURCE, THEME, NIGHT TUNING, HORN, RESPONSE,
 * INPUT GAIN, NOISE GATE, TUNING REFERENCE, DRONE VOICE, MORE.
 *
 * Layout: full-screen ScrollView (no modal wrapper). The same group / row
 * pattern from the sheet is preserved so the controls feel identical — just
 * lifted out of the slide-up modal and into a permanent tab. Settings live
 * here now; tapping SETUP at the bottom IS how a user reaches them.
 */
import React, { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useAudioEngine } from '../useAudioEngine';
import type { FilterMode } from '../filterModes';
import type { ThemeName } from '../theme';
import { useTheme, THEME_NAMES } from '../theme';
import { makeStyles, DRAG_FRIENDLY_PRESS_DELAY_MS, REF_HZ_MIN, REF_HZ_MAX } from '../uiShared';
import { DRONE_VOICES, droneVoiceLabel } from '../audioGen';
import type { DroneVoice } from '../audioGen';

const GAIN_OPTIONS = [
  { value: 'low'  as const, label: 'LOW'  },
  { value: 'high' as const, label: 'HIGH' },
];

const FILTER_OPTIONS: { value: FilterMode; label: string; hint: string }[] = [
  { value: 'fast',   label: 'FAST',   hint: 'Live play, scale drills (~140 ms)' },
  { value: 'normal', label: 'NORMAL', hint: 'Practice, tuning long tones (~230 ms)' },
  { value: 'slow',   label: 'SLOW',   hint: 'Setup, instrument repair (~460 ms)' },
];

export interface SetupScreenProps {
  engine: ReturnType<typeof useAudioEngine>;
  refHz: number;
  setRefHz: (v: number) => void;
  showDebugOverlay: boolean;
  setShowDebugOverlay: (v: boolean) => void;
  onOpenPipes: () => void;
  onOpenRangeEditor: () => void;
  onEditHornName: () => void;
  droneVoice: DroneVoice;
  setDroneVoice: (v: DroneVoice) => void;
}

export function SetupScreen(props: SetupScreenProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  const {
    engine,
    refHz, setRefHz,
    showDebugOverlay, setShowDebugOverlay,
    onOpenPipes, onOpenRangeEditor, onEditHornName,
    droneVoice, setDroneVoice,
  } = props;

  const hiFiSelected = engine.hiFiActive;
  const hiFiCaption =
    engine.hiFiMode && !engine.hiFiActive
      ? 'UNPROCESSED unavailable — falling back to processed audio.'
      : engine.audioSourceLabel || 'Use UNPROCESSED mic when available.';

  return (
    <ScrollView
      style={styles.screenScroll}
      contentContainerStyle={styles.screenScrollContent}
      showsVerticalScrollIndicator
      persistentScrollbar
    >
      <View style={styles.screenHeader}>
        <Text style={styles.screenTitle}>SETUP</Text>
        <Text style={styles.screenSubtitle}>Audio, theme, response, tuning</Text>
      </View>

      {/* AUDIO SOURCE */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>AUDIO SOURCE</Text>
        <View style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingsRowLabel}>HI-FI capture</Text>
            <Text style={styles.settingsRowHint}>{hiFiCaption}</Text>
          </View>
          <View style={styles.settingsToggle}>
            <Pressable
              onPress={() => { engine.setHiFiMode(true).catch(() => {}); }}
              unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
              accessibilityRole="button"
              accessibilityState={{ selected: hiFiSelected }}
              accessibilityLabel="Enable hi-fi capture"
              style={({ pressed }) => [styles.gainPill, hiFiSelected && styles.gainPillActive, pressed && styles.gainPillPressed]}
            >
              <Text style={[styles.gainPillText, hiFiSelected && styles.gainPillTextActive]}>ON</Text>
            </Pressable>
            <Pressable
              onPress={() => { engine.setHiFiMode(false).catch(() => {}); }}
              unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
              accessibilityRole="button"
              accessibilityState={{ selected: !hiFiSelected }}
              accessibilityLabel="Disable hi-fi capture"
              style={({ pressed }) => [styles.gainPill, !hiFiSelected && styles.gainPillActive, pressed && styles.gainPillPressed]}
            >
              <Text style={[styles.gainPillText, !hiFiSelected && styles.gainPillTextActive]}>OFF</Text>
            </Pressable>
          </View>
        </View>
      </View>

      {/* THEME */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>THEME</Text>
        <View style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingsRowLabel}>Appearance</Text>
            <Text style={styles.settingsRowHint}>
              DARK is the workhorse (amber on near-black). NIGHT is pure AMOLED black with optional darken/warmth. LIGHT is high-contrast white.
            </Text>
          </View>
          <View style={styles.settingsToggle}>
            {THEME_NAMES.map((tn: ThemeName) => {
              const selected = engine.theme === tn;
              const label = tn === 'dark' ? 'DARK' : tn === 'night' ? 'NIGHT' : 'LIGHT';
              return (
                <Pressable
                  key={tn}
                  onPress={() => engine.setTheme(tn)}
                  unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${label} theme`}
                  style={({ pressed }) => [styles.gainPill, selected && styles.gainPillActive, pressed && styles.gainPillPressed]}
                >
                  <Text style={[styles.gainPillText, selected && styles.gainPillTextActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>

      {/* NIGHT TUNING — only when night theme is active */}
      {engine.theme === 'night' && (
        <View style={styles.settingsGroup}>
          <Text style={styles.settingsGroupLabel}>NIGHT TUNING</Text>
          <View style={styles.settingsRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingsRowLabel}>Screen darken</Text>
              <Text style={styles.settingsRowHint}>
                Multiplicative — lower dims foreground tones while pure-black backgrounds stay off (AMOLED).
              </Text>
            </View>
            <View style={styles.lowCutRow}>
              <Pressable
                onPress={() => engine.setNightDarken(engine.nightDarken - 0.1)}
                unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                accessibilityRole="button"
                accessibilityLabel="Darken screen further"
                style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
              >
                <Text style={styles.lowCutStepText}>−</Text>
              </Pressable>
              <Text style={styles.lowCutValue}>{Math.round(engine.nightDarken * 100)}%</Text>
              <Pressable
                onPress={() => engine.setNightDarken(engine.nightDarken + 0.1)}
                unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                accessibilityRole="button"
                accessibilityLabel="Brighten screen"
                style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
              >
                <Text style={styles.lowCutStepText}>+</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.settingsRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingsRowLabel}>Warmth</Text>
              <Text style={styles.settingsRowHint}>
                Negative cools, positive warms. Like night-shift — useful late-night.
              </Text>
            </View>
            <View style={styles.lowCutRow}>
              <Pressable
                onPress={() => engine.setNightWarmth(engine.nightWarmth - 0.2)}
                unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                accessibilityRole="button"
                accessibilityLabel="Cooler tint"
                style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
              >
                <Text style={styles.lowCutStepText}>−</Text>
              </Pressable>
              <Text style={styles.lowCutValue}>
                {engine.nightWarmth > 0 ? '+' : ''}{Math.round(engine.nightWarmth * 10) / 10}
              </Text>
              <Pressable
                onPress={() => engine.setNightWarmth(engine.nightWarmth + 0.2)}
                unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                accessibilityRole="button"
                accessibilityLabel="Warmer tint"
                style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
              >
                <Text style={styles.lowCutStepText}>+</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      {/* HORN */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>HORN</Text>
        <Pressable
          onPress={onEditHornName}
          unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
          accessibilityRole="button"
          accessibilityLabel={
            engine.nickname.length > 0
              ? `Horn nickname: ${engine.nickname}. Tap to edit.`
              : 'Horn nickname not set. Tap to add one.'
          }
          style={({ pressed }) => [styles.settingsRow, pressed && { backgroundColor: C.edgeSoft }]}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.settingsRowLabel}>Nickname</Text>
            <Text style={styles.settingsRowHint}>
              Tag your horn so the Table view can compare runs across instruments.
            </Text>
          </View>
          <Text style={[styles.settingsRowValue, { color: engine.nickname.length > 0 ? C.accent : C.inkDim, minWidth: 120, fontSize: 12 }]} numberOfLines={1}>
            {engine.nickname.length > 0 ? engine.nickname : 'TAP TO SET'}
          </Text>
        </Pressable>
      </View>

      {/* RESPONSE */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>RESPONSE</Text>
        <View style={styles.settingsRow}>
          <Text style={styles.settingsRowLabel}>Smoothing window</Text>
          <View style={styles.settingsToggle}>
            {FILTER_OPTIONS.map(({ value, label, hint }) => (
              <Pressable
                key={value}
                onPress={() => engine.setFilterMode(value)}
                unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                accessibilityRole="button"
                accessibilityLabel={`Response ${label}: ${hint}`}
                style={({ pressed }) => [styles.filterPill, engine.filterMode === value && styles.filterPillActive, pressed && styles.gainPillPressed]}
              >
                <Text style={[styles.filterPillText, engine.filterMode === value && styles.filterPillTextActive]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>

      {/* INPUT GAIN */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>INPUT GAIN</Text>
        <View style={styles.settingsRow}>
          <Text style={styles.settingsRowLabel}>Meter scale</Text>
          <View style={styles.settingsToggle}>
            {GAIN_OPTIONS.map(({ value, label }) => (
              <Pressable
                key={value}
                onPress={() => engine.setGainMode(value)}
                unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                accessibilityRole="button"
                accessibilityLabel={`Gain ${label}`}
                style={({ pressed }) => [styles.gainPill, engine.gainMode === value && styles.gainPillActive, pressed && styles.gainPillPressed]}
              >
                <Text style={[styles.gainPillText, engine.gainMode === value && styles.gainPillTextActive]}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>

      {/* NOISE GATE */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>NOISE GATE</Text>
        <View style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingsRowLabel}>Low-cut threshold</Text>
            <Text style={styles.settingsRowHint}>
              Raise to reject room noise. The filter floor is the minimum.
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Pressable
              onPress={() => engine.setLowCutDb(engine.lowCutDb - 5)}
              unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
              accessibilityRole="button"
              accessibilityLabel="Lower noise gate by 5 decibels"
              style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
            >
              <Text style={styles.lowCutStepText}>−</Text>
            </Pressable>
            <Text style={styles.settingsRowValue}>{engine.lowCutDb} dB</Text>
            <Pressable
              onPress={() => engine.setLowCutDb(engine.lowCutDb + 5)}
              unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
              accessibilityRole="button"
              accessibilityLabel="Raise noise gate by 5 decibels"
              style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
            >
              <Text style={styles.lowCutStepText}>+</Text>
            </Pressable>
          </View>
        </View>
      </View>

      {/* TUNING REFERENCE */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>TUNING REFERENCE</Text>
        <View style={styles.settingsRow}>
          <Text style={styles.settingsRowLabel}>A4</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Pressable
              onPress={() => setRefHz(Math.max(REF_HZ_MIN, refHz - 1))}
              unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
              accessibilityRole="button"
              accessibilityLabel="Decrease A4 by 1 Hz"
              style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
            >
              <Text style={styles.lowCutStepText}>−</Text>
            </Pressable>
            <Text style={styles.settingsRowValue}>{refHz} Hz</Text>
            <Pressable
              onPress={() => setRefHz(Math.min(REF_HZ_MAX, refHz + 1))}
              unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
              accessibilityRole="button"
              accessibilityLabel="Increase A4 by 1 Hz"
              style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
            >
              <Text style={styles.lowCutStepText}>+</Text>
            </Pressable>
          </View>
        </View>
      </View>

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

      {/* METRO STYLE */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>METRO STYLE</Text>
        <View style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingsRowLabel}>Visual</Text>
            <Text style={styles.settingsRowHint}>
              PULSE is the dot row + throb. FLASH lights the screen on every beat. PENDULUM is deferred to a follow-up release.
            </Text>
          </View>
          <View style={styles.settingsToggle}>
            {(['pulse', 'pendulum', 'flash'] as const).map((v) => {
              const selected = engine.metroStyle === v;
              const label = v === 'pulse' ? 'PULSE' : v === 'pendulum' ? 'PEND' : 'FLASH';
              return (
                <Pressable
                  key={v}
                  onPress={() => engine.setMetroStyle(v)}
                  unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Metro style ${label}`}
                  style={({ pressed }) => [styles.gainPill, selected && styles.gainPillActive, pressed && styles.gainPillPressed]}
                >
                  <Text style={[styles.gainPillText, selected && styles.gainPillTextActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>

      {/* METRO CALIBRATION (v0.9.1) */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>METRO CALIBRATION</Text>
        <View style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingsRowLabel}>Output route</Text>
            <Text style={styles.settingsRowHint}>
              Used to pre-roll the click against output latency. Bluetooth A2DP is intrinsically late (~200 ms) — wired or speaker stays tight.
            </Text>
          </View>
          <View style={styles.settingsToggle}>
            {(['speaker', 'wired', 'bluetooth'] as const).map((r) => {
              const selected = engine.metroOutputRoute === r;
              const label = r === 'speaker' ? 'SPKR' : r === 'wired' ? 'WIRED' : 'BT';
              return (
                <Pressable
                  key={r}
                  onPress={() => engine.setMetroOutputRoute(r)}
                  unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Metro output route ${label}`}
                  style={({ pressed }) => [styles.gainPill, selected && styles.gainPillActive, pressed && styles.gainPillPressed]}
                >
                  <Text style={[styles.gainPillText, selected && styles.gainPillTextActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <View style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingsRowLabel}>Click offset</Text>
            <Text style={styles.settingsRowHint}>
              Adjust if visual and click feel out of sync. Negative = click earlier. Stacks on top of the route latency.
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Pressable
              onPress={() => engine.setMetroClickOffsetMs(engine.metroClickOffsetMs - 5)}
              unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
              accessibilityRole="button"
              accessibilityLabel="Pull click earlier by 5 ms"
              style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
            >
              <Text style={styles.lowCutStepText}>−</Text>
            </Pressable>
            <Text style={styles.settingsRowValue}>
              {engine.metroClickOffsetMs > 0 ? '+' : ''}{engine.metroClickOffsetMs} ms
            </Text>
            <Pressable
              onPress={() => engine.setMetroClickOffsetMs(engine.metroClickOffsetMs + 5)}
              unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
              accessibilityRole="button"
              accessibilityLabel="Push click later by 5 ms"
              style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
            >
              <Text style={styles.lowCutStepText}>+</Text>
            </Pressable>
          </View>
        </View>
      </View>

      {/* DECK STYLE */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>DECK STYLE</Text>
        <View style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingsRowLabel}>Visual</Text>
            <Text style={styles.settingsRowHint}>
              REELS is twin tape spools. WAVEFORM is a minimalist scope with a playhead. VU meters are deferred to a follow-up release.
            </Text>
          </View>
          <View style={styles.settingsToggle}>
            {(['reels', 'vu', 'waveform'] as const).map((v) => {
              const selected = engine.deckStyle === v;
              const label = v === 'reels' ? 'REELS' : v === 'vu' ? 'VU' : 'WAVE';
              return (
                <Pressable
                  key={v}
                  onPress={() => engine.setDeckStyle(v)}
                  unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Deck style ${label}`}
                  style={({ pressed }) => [styles.gainPill, selected && styles.gainPillActive, pressed && styles.gainPillPressed]}
                >
                  <Text style={[styles.gainPillText, selected && styles.gainPillTextActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>

      {/* DRONE VOICE */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>DRONE</Text>
        <View style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingsRowLabel}>Voice</Text>
            <Text style={styles.settingsRowHint}>
              CELLO is the warm default (fundamental + harmonics, slight vibrato). SINE is pure tone. SAW is brighter for noisy rooms.
            </Text>
          </View>
          <View style={styles.settingsToggle}>
            {DRONE_VOICES.map((v) => {
              const selected = droneVoice === v;
              return (
                <Pressable
                  key={v}
                  onPress={() => setDroneVoice(v)}
                  unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Drone voice ${droneVoiceLabel(v)}`}
                  style={({ pressed }) => [styles.gainPill, selected && styles.gainPillActive, pressed && styles.gainPillPressed]}
                >
                  <Text style={[styles.gainPillText, selected && styles.gainPillTextActive]}>{droneVoiceLabel(v)}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>

      {/* MORE */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>MORE</Text>
        <View style={styles.settingsRow}>
          <Text style={styles.settingsRowLabel}>Show debug overlay</Text>
          <View style={styles.settingsToggle}>
            <Pressable
              onPress={() => setShowDebugOverlay(true)}
              unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
              accessibilityRole="button"
              accessibilityLabel="Enable debug overlay"
              style={({ pressed }) => [styles.gainPill, showDebugOverlay && styles.gainPillActive, pressed && styles.gainPillPressed]}
            >
              <Text style={[styles.gainPillText, showDebugOverlay && styles.gainPillTextActive]}>ON</Text>
            </Pressable>
            <Pressable
              onPress={() => setShowDebugOverlay(false)}
              unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
              accessibilityRole="button"
              accessibilityLabel="Disable debug overlay"
              style={({ pressed }) => [styles.gainPill, !showDebugOverlay && styles.gainPillActive, pressed && styles.gainPillPressed]}
            >
              <Text style={[styles.gainPillText, !showDebugOverlay && styles.gainPillTextActive]}>OFF</Text>
            </Pressable>
          </View>
        </View>
        <Pressable
          onPress={onOpenPipes}
          unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
          accessibilityRole="button"
          accessibilityLabel="Open pitch pipes"
          style={({ pressed }) => [styles.settingsLinkBtn, pressed && styles.settingsLinkBtnPressed, { marginTop: 8 }]}
        >
          <Text style={styles.settingsLinkBtnText}>PITCH PIPES ›</Text>
        </Pressable>
        <Pressable
          onPress={onOpenRangeEditor}
          unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
          accessibilityRole="button"
          accessibilityLabel="Edit instrument range"
          style={({ pressed }) => [styles.settingsLinkBtn, pressed && styles.settingsLinkBtnPressed, { marginTop: 8 }]}
        >
          <Text style={styles.settingsLinkBtnText}>INSTRUMENT RANGE ›</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
