/**
 * MetroScreen — v1.3 (the big screen refactor).
 *
 * Two sub-pages under a TopPillNav:
 *   - METRONOME  → BPM + visualizer + ProfileSlotGrid (2×4 preset + user) +
 *                  TAP + START/STOP. Hard rule (§10 / U6): fits one screen,
 *                  NO ScrollView — visualization flex absorbs height.
 *   - CUSTOMIZATION → ProfileEditorAccordion (4 user profile slots; one
 *                     expanded at a time). MAY scroll (it's an editor).
 *
 * Sub-page state (`subPage`) is LOCAL to this screen, never persisted (per
 * §2 + F-decisions). On tab return the user always lands on METRONOME.
 *
 * v1.3 wave-3 gap (option-a):
 *   useMetronome does NOT yet expose profile slots / activeProfileSlot /
 *   loadProfile / updateProfile. We mock the four user profile slots with
 *   local state here so the UI shape lands. Wave 3.5 will plumb these into
 *   the real hook surface. The TODO comments below mark the touch points.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useTheme } from '../theme';
import { makeStyles } from '../uiShared';
import type {
  BeatInstrument,
  MetronomeState,
  TimeSig,
  TimeSigPreset,
} from '../useMetronome';
import { beatsPerBar } from '../useMetronome';
import { PulseDisplay } from '../components/metroStyles/PulseDisplay';
import { FlashDisplay } from '../components/metroStyles/FlashDisplay';
import { PendulumDisplay } from '../components/metroStyles/PendulumDisplay';
import { TopPillNav } from '../components/TopPillNav';
import { ProfileSlotGrid } from '../components/ProfileSlotGrid';
import type { ProfileSlotMeta } from '../components/ProfileSlotGrid';
import { ProfileEditorAccordion } from '../components/ProfileEditorAccordion';
import type {
  EditableProfile,
  EditableProfilePatch,
} from '../components/ProfileEditorAccordion';
import { DrumPicker } from '../components/DrumPicker';
import type { BeatSlotContext } from '../drumVoices';
import type { MidiBusState } from '../useMidiBusCore';

const PRESETS: TimeSigPreset[] = ['2/4', '3/4', '4/4', '6/8'];
type SubPage = 'metronome' | 'customization';
type SlotIndex = 1 | 2 | 3 | 4;

const DEFAULT_BEAT_1: BeatInstrument = { midi: 36, velocity: 110 };
const DEFAULT_BEAT_N: BeatInstrument = { midi: 76, velocity: 90 };
const DEFAULT_SUB:    BeatInstrument = { midi: 42, velocity: 70 };

/** Render-time label for the time-sig (used in accessibility strings only). */
function tsLabel(ts: TimeSig): string {
  return ts.kind === 'preset' ? ts.value : `${ts.num}/${ts.den}`;
}

/** Legacy metro-display contract still wants a preset string. Pick the
 *  closest by numerator. Beats-per-bar count is what the displays actually
 *  use, so this fallback never misleads visually. */
function tsAsPresetForDisplay(ts: TimeSig): TimeSigPreset {
  if (ts.kind === 'preset') return ts.value;
  if (ts.num === 2) return '2/4';
  if (ts.num === 3) return '3/4';
  if (ts.num === 6) return '6/8';
  return '4/4';
}

function buildDefaultPattern(beats: number): BeatInstrument[] {
  const out: BeatInstrument[] = new Array(beats);
  for (let i = 0; i < beats; i++) out[i] = i === 0 ? { ...DEFAULT_BEAT_1 } : { ...DEFAULT_BEAT_N };
  return out;
}

// v1.3 — fresh-install defaults per §9. Wave 3.5 will move these into
// useMetronome once profile state lands; for Wave 3 they're the seed for
// the local mock state below.
function buildInitialProfiles(): EditableProfile[] {
  return [
    {
      slot: 1,
      name: 'User 1',
      timeSig: { kind: 'preset', value: '4/4' },
      pattern: buildDefaultPattern(4),
      subdivisions: 'off',
      subdivisionVoice: { ...DEFAULT_SUB },
    },
    {
      slot: 2,
      name: 'User 2',
      timeSig: { kind: 'preset', value: '3/4' },
      pattern: buildDefaultPattern(3),
      subdivisions: 'off',
      subdivisionVoice: { ...DEFAULT_SUB },
    },
    {
      slot: 3,
      name: 'User 3',
      timeSig: { kind: 'preset', value: '4/4' },
      pattern: buildDefaultPattern(4),
      subdivisions: 'off',
      subdivisionVoice: { ...DEFAULT_SUB },
    },
    {
      slot: 4,
      name: 'User 4',
      timeSig: { kind: 'preset', value: '4/4' },
      pattern: buildDefaultPattern(4),
      subdivisions: 'off',
      subdivisionVoice: { ...DEFAULT_SUB },
    },
  ];
}

export interface MetroScreenProps {
  metro: MetronomeState;
  metroStyle: 'pulse' | 'pendulum' | 'flash';
  /** Selected output route — drives the BT-latency warning banner. */
  outputRoute: 'speaker' | 'wired' | 'bluetooth';
  /**
   * v1.3 — bus reference for the PerBeatRow live-flash subscription (F18-15).
   * Optional so existing callers that haven't been updated still compile;
   * when undefined the editor's PerBeatRow simply never flashes.
   */
  bus?: MidiBusState;
}

export function MetroScreen({ metro, metroStyle, outputRoute, bus }: MetroScreenProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  void C;
  // v1.3.2 — bus is now threaded through to ProfileEditorAccordion → PerBeatRow
  // for live flash inside the editor. Sauron's wave-3.5 PerBeatRow listener
  // requires bus to be passed in (no longer optional in practice).

  // v1.3 — sub-page state lives on the screen, not persisted. Tab return
  // always lands on METRONOME (per §2 + locked decisions).
  const [subPage, setSubPage] = useState<SubPage>('metronome');

  // v1.3 — mock profile slot state. TODO(Wave 3.5): replace with
  // metro.profiles / metro.activeProfileSlot / metro.loadProfile /
  // metro.updateProfile once useMetronome exposes them.
  const [profiles, setProfiles] = useState<EditableProfile[]>(() => buildInitialProfiles());
  const [activeProfileSlot, setActiveProfileSlot] = useState<SlotIndex | null>(null);
  const [expandedSlot, setExpandedSlot] = useState<SlotIndex | null>(1);

  const bpmAccessible = `Tempo ${metro.bpm} beats per minute, ${tsLabel(metro.timeSig)}`;
  const displayPreset = tsAsPresetForDisplay(metro.timeSig);

  // ProfileSlotGrid expects { slot, name } only.
  const profileMetas = useMemo<ProfileSlotMeta[]>(
    () => profiles.map((p) => ({ slot: p.slot, name: p.name })),
    [profiles],
  );

  // v1.3 — active selection key for the grid.
  // If a profile is loaded → 'profile' source; else if metro.timeSig is a
  // preset, mark that preset active; else null (legacy custom sig with no
  // profile loaded — leave the whole grid unlit, per v1.3.2 Sauron W3 fix).
  const gridActiveKind: 'preset' | 'profile' = activeProfileSlot !== null ? 'profile' : 'preset';
  const gridActiveKey: TimeSigPreset | SlotIndex | null =
    activeProfileSlot !== null
      ? activeProfileSlot
      : metro.timeSig.kind === 'preset'
        ? metro.timeSig.value
        : null;

  // ---- preset / profile tap handlers ----

  const onTapPreset = useCallback((p: TimeSigPreset) => {
    // Tapping a preset clears any profile source AND resets pattern/subdiv
    // back to defaults for that beat count (per v1.2 behavior preserved).
    setActiveProfileSlot(null);
    metro.setTimeSig({ kind: 'preset', value: p });
    metro.setSubdivisions('off');
    // Pattern is auto-resized to default by useMetronome's setTimeSig path.
  }, [metro]);

  const onTapProfile = useCallback((slot: SlotIndex) => {
    // v1.4 — L3: single atomic call; replaces the cascade of 4 setters.
    // metro.loadProfile batches all state + one prefsUpdate() write.
    const p = profiles.find((x) => x.slot === slot);
    if (!p) return;
    setActiveProfileSlot(slot);
    metro.loadProfile(p);
  }, [profiles, metro]);

  // ---- editor accordion handlers ----

  const onToggleExpand = useCallback((slot: SlotIndex) => {
    setExpandedSlot((cur) => (cur === slot ? null : slot));
  }, []);

  const onUpdate = useCallback((slot: SlotIndex, patch: EditableProfilePatch) => {
    setProfiles((prev) => {
      const next = prev.slice();
      const idx = next.findIndex((p) => p.slot === slot);
      if (idx < 0) return prev;
      const merged: EditableProfile = { ...next[idx], ...patch };
      // If the time-sig changed, resize the pattern so the editor's PerBeatRow
      // stays consistent. Preserve existing cells where indices overlap.
      if (patch.timeSig) {
        const newBeats = beatsPerBar(patch.timeSig);
        const old = merged.pattern;
        if (old.length !== newBeats) {
          const resized: BeatInstrument[] = [];
          for (let i = 0; i < newBeats; i++) {
            resized.push(old[i] ?? (i === 0 ? { ...DEFAULT_BEAT_1 } : { ...DEFAULT_BEAT_N }));
          }
          merged.pattern = resized;
        }
      }
      next[idx] = merged;
      return next;
    });
    // v1.3 — edit-while-loaded sync (§8 + §4 save-commit). If the user is
    // editing the slot currently loaded, mirror to live state immediately.
    if (activeProfileSlot === slot) {
      if (patch.timeSig) metro.setTimeSig(patch.timeSig);
      if (patch.subdivisions) metro.setSubdivisions(patch.subdivisions);
      if (patch.subdivisionVoice) metro.setSubdivisionVoice(patch.subdivisionVoice.midi);
      if (patch.pattern) {
        const beats = beatsPerBar(patch.timeSig ?? metro.timeSig);
        for (let i = 0; i < beats; i++) {
          const cell = patch.pattern[i];
          if (cell) metro.setBeatInstrument(i, cell.midi);
        }
      }
    }
  }, [activeProfileSlot, metro]);

  // ---- drum picker (single host for the editor, per §11.Q12) ----

  const drumPickerRef = useRef<BottomSheetModal>(null);
  const [pickerCtx, setPickerCtx] = useState<
    | { kind: 'beat'; slot: SlotIndex; idx: number }
    | { kind: 'sub'; slot: SlotIndex }
    | null
  >(null);

  const onOpenBeatPicker = useCallback((slot: SlotIndex, beatIdx: number) => {
    setPickerCtx({ kind: 'beat', slot, idx: beatIdx });
    drumPickerRef.current?.present();
  }, []);
  const onOpenSubPicker = useCallback((slot: SlotIndex) => {
    setPickerCtx({ kind: 'sub', slot });
    drumPickerRef.current?.present();
  }, []);
  const onPickerSelect = useCallback((midi: number) => {
    if (!pickerCtx) return;
    setProfiles((prev) => {
      const next = prev.slice();
      const idx = next.findIndex((p) => p.slot === pickerCtx.slot);
      if (idx < 0) return prev;
      const target = next[idx];
      if (pickerCtx.kind === 'beat') {
        const pat = target.pattern.slice();
        const cur = pat[pickerCtx.idx];
        pat[pickerCtx.idx] = {
          midi,
          velocity: cur?.velocity ?? (pickerCtx.idx === 0 ? 110 : 90),
        };
        next[idx] = { ...target, pattern: pat };
      } else {
        next[idx] = {
          ...target,
          subdivisionVoice: { midi, velocity: target.subdivisionVoice.velocity },
        };
      }
      return next;
    });
    // Edit-while-loaded sync into live state.
    if (activeProfileSlot === pickerCtx.slot) {
      if (pickerCtx.kind === 'beat') metro.setBeatInstrument(pickerCtx.idx, midi);
      else metro.setSubdivisionVoice(midi);
    }
    drumPickerRef.current?.dismiss();
  }, [pickerCtx, activeProfileSlot, metro]);

  const slotContext: BeatSlotContext = (() => {
    if (!pickerCtx) return 'downbeat';
    if (pickerCtx.kind === 'beat') return pickerCtx.idx === 0 ? 'downbeat' : 'offbeat';
    const slotProfile = profiles.find((p) => p.slot === pickerCtx.slot);
    const sub = slotProfile?.subdivisions ?? 'off';
    if (sub === '16th') return 'sub-16th';
    if (sub === 'triplet') return 'sub-triplet';
    return 'sub-8th';
  })();
  const slotLabel: string = (() => {
    if (!pickerCtx) return 'Beat 1';
    if (pickerCtx.kind === 'beat') return `User ${pickerCtx.slot} · Beat ${pickerCtx.idx + 1}`;
    return `User ${pickerCtx.slot} · Sub voice`;
  })();
  const currentMidi: number | null = (() => {
    if (!pickerCtx) return null;
    const slotProfile = profiles.find((p) => p.slot === pickerCtx.slot);
    if (!slotProfile) return null;
    if (pickerCtx.kind === 'beat') return slotProfile.pattern[pickerCtx.idx]?.midi ?? null;
    return slotProfile.subdivisionVoice.midi;
  })();

  return (
    <View style={{ flex: 1 }}>
      {/* v1.3 — top sub-page nav. Locked height; doesn't move on swap. */}
      <TopPillNav<SubPage>
        options={[
          { key: 'metronome', label: 'METRONOME' },
          { key: 'customization', label: 'CUSTOMIZATION' },
        ]}
        active={subPage}
        onChange={setSubPage}
      />

      {/* Bluetooth latency banner — METRONOME sub-page only. CUSTOMIZATION is
          an editor; banner there is just noise. v1.3.2 anti-flicker: ALWAYS
          reserve the banner's vertical slot when on METRONOME so visualizer
          height doesn't jump when output route changes mid-session. */}
      {subPage === 'metronome' && (
        outputRoute === 'bluetooth' ? (
          <View
            style={styles.silenceBanner}
            accessibilityRole="alert"
            accessibilityLabel="Bluetooth output is latent. Click may feel slightly behind the visual."
          >
            <Text style={styles.silenceBannerText}>
              <Text style={styles.silenceBannerBold}>Bluetooth output is latent.</Text>
              {'  '}Wired or speaker keeps the click tight with the visual.
            </Text>
          </View>
        ) : (
          // Height-matched invisible spacer (same paddings + borders as
          // silenceBanner ≈ 40dp incl. marginTop). Keeps the BPM row anchored.
          <View style={[styles.silenceBanner, { opacity: 0, borderColor: 'transparent', backgroundColor: 'transparent' }]} pointerEvents="none">
            <Text style={styles.silenceBannerText}> </Text>
          </View>
        )
      )}

      {subPage === 'metronome' ? (
        <View style={{ flex: 1 }}>
          {/* BPM row — unchanged from v1.2 */}
          <View style={styles.metroBpmRow}>
            <Pressable
              onPress={() => metro.bumpBpm(-5)}
              accessibilityRole="button"
              accessibilityLabel="Decrease tempo by 5 BPM"
              style={({ pressed }) => [styles.metroBpmFlankStepper, pressed && styles.metroBpmFlankStepperPressed]}
            >
              <Text style={styles.metroBpmFlankStepperText}>−5</Text>
            </Pressable>
            <Pressable
              onPress={() => metro.bumpBpm(-1)}
              accessibilityRole="button"
              accessibilityLabel="Decrease tempo by 1 BPM"
              style={({ pressed }) => [styles.metroBpmFlankStepper, styles.metroBpmFlankStepperAccent, pressed && styles.metroBpmFlankStepperPressed]}
            >
              <Text style={[styles.metroBpmFlankStepperText, styles.metroBpmFlankStepperTextAccent]}>−1</Text>
            </Pressable>
            <Text
              style={styles.metroBpmDisplay}
              numberOfLines={1}
              accessibilityRole="text"
              accessibilityLabel={bpmAccessible}
            >
              {metro.bpm}
            </Text>
            <Pressable
              onPress={() => metro.bumpBpm(1)}
              accessibilityRole="button"
              accessibilityLabel="Increase tempo by 1 BPM"
              style={({ pressed }) => [styles.metroBpmFlankStepper, styles.metroBpmFlankStepperAccent, pressed && styles.metroBpmFlankStepperPressed]}
            >
              <Text style={[styles.metroBpmFlankStepperText, styles.metroBpmFlankStepperTextAccent]}>+1</Text>
            </Pressable>
            <Pressable
              onPress={() => metro.bumpBpm(5)}
              accessibilityRole="button"
              accessibilityLabel="Increase tempo by 5 BPM"
              style={({ pressed }) => [styles.metroBpmFlankStepper, pressed && styles.metroBpmFlankStepperPressed]}
            >
              <Text style={styles.metroBpmFlankStepperText}>+5</Text>
            </Pressable>
          </View>

          {/* Visualization — flex:1 absorbs height. */}
          <View style={{ flex: 1, justifyContent: 'center' }}>
            {metroStyle === 'flash' ? (
              <FlashDisplay
                running={metro.running}
                beat={metro.beat}
                pulse={metro.pulse}
                bpm={metro.bpm}
                timeSig={displayPreset}
                bus={bus}
              />
            ) : metroStyle === 'pendulum' ? (
              <PendulumDisplay
                running={metro.running}
                beat={metro.beat}
                pulse={metro.pulse}
                bpm={metro.bpm}
                bus={bus}
              />
            ) : (
              <PulseDisplay
                running={metro.running}
                beat={metro.beat}
                pulse={metro.pulse}
                timeSig={displayPreset}
                bus={bus}
              />
            )}
          </View>

          {/* v1.3 — 2×4 grid replaces the v1.2 5-pill row + CUSTOM pill. */}
          <ProfileSlotGrid
            presets={PRESETS}
            profiles={profileMetas}
            activeKind={gridActiveKind}
            activeKey={gridActiveKey}
            onTapPreset={onTapPreset}
            onTapProfile={onTapProfile}
          />

          {/* TAP — unchanged */}
          <Pressable
            onPress={() => metro.registerTap()}
            accessibilityRole="button"
            accessibilityLabel="Tap tempo. Tap on each beat, the metronome sets BPM from the average."
            style={({ pressed }) => [styles.metroTap, pressed && styles.metroTapPressed]}
          >
            <Text style={styles.metroTapText}>TAP</Text>
          </Pressable>

          {/* START / STOP — unchanged */}
          <Pressable
            onPress={metro.toggle}
            accessibilityRole="button"
            accessibilityLabel={metro.running ? 'Stop metronome' : 'Start metronome'}
            style={({ pressed }) => [
              styles.metroPrimary,
              metro.running ? styles.metroPrimaryActive : styles.metroPrimaryIdle,
              pressed && styles.metroPrimaryPressed,
            ]}
          >
            <Text style={[styles.metroPrimaryText, metro.running ? styles.metroPrimaryTextActive : styles.metroPrimaryTextIdle]}>
              {metro.running ? 'STOP' : 'START'}
            </Text>
          </Pressable>
        </View>
      ) : (
        // v1.3.2 — wrap CUSTOMIZATION ScrollView in KeyboardAvoidingView so
        // the profile-name TextInput + CustomTimeSigPanel direct-entry inputs
        // don't get hidden behind the soft keyboard on small phones.
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 24 }}
            showsVerticalScrollIndicator
            keyboardShouldPersistTaps="handled"
          >
            <ProfileEditorAccordion
              bus={bus}
              profiles={profiles}
              expandedSlot={expandedSlot}
              onToggleExpand={onToggleExpand}
              onUpdate={onUpdate}
              onOpenBeatPicker={onOpenBeatPicker}
              onOpenSubPicker={onOpenSubPicker}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* v1.3 — single DrumPicker host shared by the accordion's beat-cell
          taps and sub-voice rows. Sibling of the body so the sheet renders
          above either sub-page; remains harmless when subPage='metronome'
          because nothing calls present(). */}
      <DrumPicker
        ref={drumPickerRef}
        slotContext={slotContext}
        slotLabel={slotLabel}
        currentMidi={currentMidi}
        onSelect={onPickerSelect}
      />

      {/* v1.3.2 — bus is now threaded through to the editor's PerBeatRow via
          ProfileEditorAccordion. The live METRONOME body still drives flash
          via the visualizer; no additional screen-level subscription needed. */}
    </View>
  );
}
