/**
 * SetupScreen — v1.3 (globals-only after the per-tab move).
 *
 * Per F4 + F10 + G17 + §6, SETUP loses three groups to TUNER/CUSTOMIZATION
 * (tuner style, drone voice, drone vol/semis, pipes voice) and one group to
 * METRO/CUSTOMIZATION (METRO VOICES — per-beat editor + sub picker + drum
 * picker host). What remains is engine-wide.
 *
 * Groups still here:
 *   AUDIO SOURCE · THEME · NIGHT TUNING · HORN · RESPONSE · INPUT GAIN ·
 *   NOISE GATE · TUNING REFERENCE · METRO CALIBRATION (F4: stays SETUP-global,
 *   route+offset+click volume) · DECK STYLE (F5: defer DECK sub-pill) ·
 *   METRO STYLE (visualizer choice; per-tab nav doesn't replace style) ·
 *   MORE (debug overlay, pitch pipes link, instrument range link).
 *
 * No more DrumPicker host on SETUP — moved to MetroScreen.
 */
import React, { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useAudioEngine } from '../useAudioEngine';
import type { FilterMode } from '../filterModes';
import type { ThemeName } from '../theme';
import { useTheme, THEME_NAMES } from '../theme';
import { makeStyles, DRAG_FRIENDLY_PRESS_DELAY_MS, REF_HZ_MIN, REF_HZ_MAX } from '../uiShared';
import type { MetronomeState } from '../useMetronome';

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
  /**
   * v1.3 — metro is still threaded in so the METRO CALIBRATION group can show
   * the click-volume stepper. METRO VOICES (the per-beat editor) is gone from
   * SETUP and now lives on MetroScreen's CUSTOMIZATION sub-page.
   */
  metro?: MetronomeState;
}

export function SetupScreen(props: SetupScreenProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  const {
    engine,
    refHz, setRefHz,
    showDebugOverlay, setShowDebugOverlay,
    onOpenPipes, onOpenRangeEditor, onEditHornName,
    metro,
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
        <Text style={styles.screenSubtitle}>Globals — audio, theme, response, tuning</Text>
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

      {/* METRO STYLE — visualizer choice. Per-tab pill nav doesn't replace
          style; the user still picks PULSE vs PENDULUM vs FLASH. Kept on
          SETUP as a global preference. */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>METRO STYLE</Text>
        <View style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingsRowLabel}>Visual</Text>
            <Text style={styles.settingsRowHint}>
              PULSE is the dot row + throb. FLASH lights the screen on every beat. PENDULUM is the vintage mechanical swing.
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

      {/* METRO CALIBRATION (F4: stays SETUP-global) */}
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
        {/* CLICK VOLUME — only when the metro hook is wired in. */}
        {metro !== undefined && (
          <View style={styles.settingsRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingsRowLabel}>Click volume</Text>
              <Text style={styles.settingsRowHint}>
                Accent and normal clicks share this level. 0.0 = mute, 1.0 = full.
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Pressable
                onPress={() => metro.setClickVolume(metro.clickVolume - 0.1)}
                unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                accessibilityRole="button"
                accessibilityLabel="Decrease click volume by 10%"
                style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
              >
                <Text style={styles.lowCutStepText}>−</Text>
              </Pressable>
              <Text style={styles.settingsRowValue}>{metro.clickVolume.toFixed(1)}</Text>
              <Pressable
                onPress={() => metro.setClickVolume(metro.clickVolume + 0.1)}
                unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
                accessibilityRole="button"
                accessibilityLabel="Increase click volume by 10%"
                style={({ pressed }) => [styles.lowCutStep, pressed && styles.lowCutStepPressed]}
              >
                <Text style={styles.lowCutStepText}>+</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {/* DECK STYLE (F5: defer DECK sub-pill row in v1.3 → style stays here) */}
      <View style={styles.settingsGroup}>
        <Text style={styles.settingsGroupLabel}>DECK STYLE</Text>
        <View style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.settingsRowLabel}>Visual</Text>
            <Text style={styles.settingsRowHint}>
              REELS is twin tape spools that jog with the scrubber. WAVEFORM is a minimalist scope with a playhead. VU is twin analog needles with ballistic bounce.
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

      {/* MORE — debug overlay, pitch pipes link, instrument range link.
          v1.3: Open Source Licenses placeholder queued for v1.4. */}
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
        <Text style={[styles.settingsRowHint, { marginTop: 14 }]}>
          Open source licenses · coming in v1.4
        </Text>
        <Text style={[styles.settingsRowHint, { marginTop: 4 }]}>
          BELLCURVE v1.3.0
        </Text>
      </View>
    </ScrollView>
  );
}
