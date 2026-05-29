/**
 * ProfileEditorAccordion — v1.3 CUSTOMIZATION sub-page editor (§4, F1 locked).
 *
 * Four section headers; tap to expand one at a time (accordion). The expanded
 * body holds the per-profile editor:
 *   - Name (TextInput, maxLength 24)
 *   - Time signature (preset/custom kind toggle + pills/CustomTimeSigPanel)
 *   - Beat pattern (PerBeatRow opens DrumPicker)
 *   - Subdivisions (SubdivisionPicker)
 *
 * NOTE (Wave 3): useMetronome v1.3 does NOT yet expose profile slot state /
 * loadProfile / updateProfile. This component renders against an EXTERNAL
 * `MockProfileShape` constructed locally in MetroScreen so the UI lands now;
 * Wave 3.5 will plumb the editor's `onUpdate` calls into the real hook surface
 * once it's extended.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import { DRAG_FRIENDLY_PRESS_DELAY_MS, makeStyles } from '../uiShared';
import type { BeatInstrument, Subdivision, TimeSig, TimeSigPreset } from '../useMetronome';
import { beatsPerBar } from '../useMetronome';
import { CustomTimeSigPanel } from './CustomTimeSigPanel';
import { PerBeatRow } from './PerBeatRow';
import { SubdivisionPicker } from './SubdivisionPicker';
import type { MidiBusState } from '../useMidiBusCore';

const PRESETS: TimeSigPreset[] = ['2/4', '3/4', '4/4', '6/8'];

/** Editable profile shape. v1.3 only exposes the 'drums' channel; matches the
 *  v1.2 surface plus a name field. Wave 3.5 may reshape under channels.drums
 *  per §18 — the editor only consumes these flat fields today. */
export interface EditableProfile {
  slot: 1 | 2 | 3 | 4;
  name: string;
  timeSig: TimeSig;
  pattern: BeatInstrument[];
  subdivisions: Subdivision;
  subdivisionVoice: BeatInstrument;
}

export type EditableProfilePatch = Partial<Omit<EditableProfile, 'slot'>>;

export interface ProfileEditorAccordionProps {
  profiles: ReadonlyArray<EditableProfile>;
  expandedSlot: 1 | 2 | 3 | 4 | null;
  onToggleExpand: (slot: 1 | 2 | 3 | 4) => void;
  onUpdate: (slot: 1 | 2 | 3 | 4, patch: EditableProfilePatch) => void;
  /** Open the drum picker for a beat cell in the given slot. Parent owns
   *  the sheet (single host pattern — see §11.Q12). */
  onOpenBeatPicker: (slot: 1 | 2 | 3 | 4, beatIdx: number) => void;
  /** Open the drum picker for the sub voice in the given slot. */
  onOpenSubPicker: (slot: 1 | 2 | 3 | 4) => void;
  /**
   * v1.3.2 — MIDI bus reference threaded down to PerBeatRow for the live
   * flash subscription (F18-15). Optional so this component stays usable
   * from tests / preview surfaces without a live bus.
   */
  bus?: MidiBusState;
}

export function ProfileEditorAccordion({
  profiles,
  expandedSlot,
  onToggleExpand,
  onUpdate,
  onOpenBeatPicker,
  onOpenSubPicker,
  bus,
}: ProfileEditorAccordionProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  return (
    <View>
      {/* v1.3 — header per U18 / §4 naming */}
      <Text style={styles.profileEditor_header}>CUSTOM SOUND SET · CUSTOM BEAT PATTERNS</Text>

      {profiles.map((profile) => {
        const expanded = expandedSlot === profile.slot;
        return (
          <ProfileEditorSection
            key={profile.slot}
            profile={profile}
            expanded={expanded}
            onToggle={() => onToggleExpand(profile.slot)}
            onUpdate={(patch) => onUpdate(profile.slot, patch)}
            onOpenBeatPicker={(idx) => onOpenBeatPicker(profile.slot, idx)}
            onOpenSubPicker={() => onOpenSubPicker(profile.slot)}
            styles={styles}
            inkDim={C.inkDim}
            bus={bus}
          />
        );
      })}
    </View>
  );
}

interface ProfileEditorSectionProps {
  profile: EditableProfile;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (patch: EditableProfilePatch) => void;
  onOpenBeatPicker: (idx: number) => void;
  onOpenSubPicker: () => void;
  styles: ReturnType<typeof makeStyles>;
  inkDim: string;
  bus?: MidiBusState;
}

function ProfileEditorSection({
  profile,
  expanded,
  onToggle,
  onUpdate,
  onOpenBeatPicker,
  onOpenSubPicker,
  styles,
  inkDim,
  bus,
}: ProfileEditorSectionProps) {
  // v1.3 — local name buffer so typing doesn't fight the parent. Commit on blur.
  const [nameBuf, setNameBuf] = useState<string>(profile.name);
  // Sync external changes (e.g. parent reset).
  React.useEffect(() => { setNameBuf(profile.name); }, [profile.name]);

  // v1.4 closeout (Frodo NOTE-3) — tiny inline hint when the user blurs an
  // empty name. The old guardrail SILENTLY rewrote the field to "User N" on an
  // empty blur, which surprised users who'd only meant to clear-and-retype.
  // Now we keep the existing saved name, revert the buffer to it, and flash a
  // short "name can't be empty" hint instead. (The persistence layer in
  // useMetronome ALSO coerces empty → "User N" on both read and write, so the
  // saved-name round-trip from #10 is unaffected no matter what we send.)
  const [nameHint, setNameHint] = useState<string | null>(null);
  const nameHintTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (nameHintTimerRef.current !== null) clearTimeout(nameHintTimerRef.current);
  }, []);
  const flashNameHint = useCallback(() => {
    setNameHint("Name can't be empty");
    if (nameHintTimerRef.current !== null) clearTimeout(nameHintTimerRef.current);
    nameHintTimerRef.current = setTimeout(() => {
      setNameHint(null);
      nameHintTimerRef.current = null;
    }, 2500);
  }, []);

  const commitName = useCallback(() => {
    const trimmed = nameBuf.trim();
    if (trimmed.length === 0) {
      // Don't silently rename to "User N". Keep the saved name, revert the
      // buffer to it, and signal why nothing was saved.
      setNameBuf(profile.name);
      flashNameHint();
      return;
    }
    if (trimmed !== profile.name) onUpdate({ name: trimmed });
    setNameBuf(trimmed);
  }, [nameBuf, profile.name, onUpdate, flashNameHint]);

  const ts = profile.timeSig;
  const isCustom = ts.kind === 'custom';
  const customNum = ts.kind === 'custom' ? ts.num : 5;
  const customDen: 2 | 4 | 8 | 16 | 32 = ts.kind === 'custom' ? ts.den : 8;
  const beats = beatsPerBar(ts);

  // v1.3 — collapsed subtitle string (time-sig label).
  const tsLabel = ts.kind === 'preset' ? ts.value : `${ts.num}/${ts.den}`;

  return (
    <View style={styles.profileEditor_section}>
      <Pressable
        onPress={onToggle}
        unstable_pressDelay={DRAG_FRIENDLY_PRESS_DELAY_MS}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`User ${profile.slot}, ${profile.name}, ${tsLabel}. ${expanded ? 'Tap to collapse.' : 'Tap to expand.'}`}
        style={({ pressed }) => [
          styles.profileEditor_sectionHeader,
          pressed && styles.profileEditor_sectionHeaderPressed,
        ]}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.profileEditor_sectionHeaderTitle} numberOfLines={1} ellipsizeMode="tail">
            USER {profile.slot} · {profile.name || `User ${profile.slot}`}
          </Text>
          <Text style={styles.profileEditor_sectionHeaderSubtitle} numberOfLines={1}>
            {tsLabel}
          </Text>
        </View>
        <Text style={styles.profileEditor_sectionHeaderChevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded && (
        <View style={styles.profileEditor_sectionBody}>
          {/* Name input */}
          <Text style={styles.profileEditor_fieldLabel}>Name</Text>
          <TextInput
            value={nameBuf}
            onChangeText={(t) => { setNameBuf(t); if (nameHint) setNameHint(null); }}
            onBlur={commitName}
            onSubmitEditing={commitName}
            maxLength={24}
            placeholder={`User ${profile.slot}`}
            placeholderTextColor={inkDim}
            accessibilityLabel="Profile name"
            style={styles.profileEditor_nameInput}
          />
          {nameHint && (
            <Text style={styles.profileEditor_nameHint} accessibilityLiveRegion="polite">
              {nameHint}
            </Text>
          )}

          {/* Time signature — preset/custom kind toggle + value picker */}
          <Text style={styles.profileEditor_fieldLabel}>Time signature</Text>
          <View style={styles.profileEditor_tsKindRow}>
            <Pressable
              onPress={() => {
                if (!isCustom) return;
                // Switch back to a sane preset (4/4) — keeps the editor flat
                // by letting the user re-pick from the preset row.
                onUpdate({ timeSig: { kind: 'preset', value: '4/4' } });
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: !isCustom }}
              accessibilityLabel="Preset time signature"
              style={({ pressed }) => [
                styles.metroSigPill,
                !isCustom && styles.metroSigPillActive,
                pressed && styles.gainPillPressed,
              ]}
            >
              <Text style={[styles.metroSigPillText, !isCustom && styles.metroSigPillTextActive]}>
                PRESET
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (isCustom) return;
                onUpdate({ timeSig: { kind: 'custom', num: customNum, den: customDen } });
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: isCustom }}
              accessibilityLabel="Custom time signature"
              style={({ pressed }) => [
                styles.metroSigPill,
                isCustom && styles.metroSigPillActive,
                pressed && styles.gainPillPressed,
              ]}
            >
              <Text style={[styles.metroSigPillText, isCustom && styles.metroSigPillTextActive]}>
                CUSTOM
              </Text>
            </Pressable>
          </View>

          {/* v1.3.2 — reserve the height of the taller of (preset pill row)
              vs (CustomTimeSigPanel) so flipping PRESET↔CUSTOM doesn't shift
              the Beat pattern / Subdivisions sections below by ~70dp. The
              CustomTimeSigPanel renders at minHeight 52 + label/margins ≈
              110dp; the preset row is ~52dp. Reserve 110dp. */}
          <View style={styles.profileEditor_tsValueReserve}>
            {!isCustom ? (
              <View style={styles.profileEditor_tsPresetRow}>
                {PRESETS.map((p) => {
                  const selected = ts.kind === 'preset' && ts.value === p;
                  return (
                    <Pressable
                      key={p}
                      onPress={() => onUpdate({ timeSig: { kind: 'preset', value: p } })}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Preset ${p}`}
                      style={({ pressed }) => [
                        styles.metroSigPill,
                        selected && styles.metroSigPillActive,
                        pressed && styles.gainPillPressed,
                      ]}
                    >
                      <Text style={[styles.metroSigPillText, selected && styles.metroSigPillTextActive]}>
                        {p}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <CustomTimeSigPanel
                num={customNum}
                den={customDen}
                onChangeNum={(n) => onUpdate({ timeSig: { kind: 'custom', num: n, den: customDen } })}
                onChangeDen={(d) => onUpdate({ timeSig: { kind: 'custom', num: customNum, den: d } })}
              />
            )}
          </View>

          {/* Per-beat pattern */}
          <Text style={styles.profileEditor_fieldLabel}>Beat pattern</Text>
          <PerBeatRow
            pattern={profile.pattern}
            beatsPerBar={beats}
            // v1.3.2 — bus threaded down so PerBeatRow's noteOn subscription
            // can flash the live beat-cell border per F18-15.
            bus={bus}
            // v1.3 — running state irrelevant inside the editor; pass false so
            // no flash. Live flash subscription remains on the METRONOME body.
            runningPulse={0}
            running={false}
            onCellTap={onOpenBeatPicker}
          />

          {/* Subdivisions */}
          <Text style={styles.profileEditor_fieldLabel}>Subdivisions</Text>
          <SubdivisionPicker
            subdivisions={profile.subdivisions}
            subdivisionVoice={profile.subdivisionVoice}
            onChangeSubdivisions={(s) => onUpdate({ subdivisions: s })}
            onOpenSubVoicePicker={onOpenSubPicker}
          />
        </View>
      )}
    </View>
  );
}
