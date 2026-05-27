/**
 * SubdivisionPicker — v1.2 mutually-exclusive radio for subdivision mode
 * (§5 + §15.Q11.2). Four pills: OFF | 8TH | 16TH | TRIPLET. Below the radio,
 * a single row shows the current sub voice's label and opens the drum picker
 * via `onOpenSubVoicePicker` (the parent supplies the right slot context
 * matching the current subdivisions setting).
 *
 * Reuses the metroSigPill style for the radio so the look matches the time-
 * sig pill row on the METRO tab (§9 + §16.U6).
 */
import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { makeStyles } from '../uiShared';
import { resolveDrumByMidi } from '../drumVoices';
import type { BeatInstrument, Subdivision } from '../useMetronome';

const OPTIONS: { value: Subdivision; label: string; aria: string }[] = [
  { value: 'off',     label: 'OFF',     aria: 'Subdivisions off' },
  { value: '8th',     label: '8TH',     aria: 'Eighth-note subdivisions' },
  { value: '16th',    label: '16TH',    aria: 'Sixteenth-note subdivisions' },
  { value: 'triplet', label: 'TRIPLET', aria: 'Triplet subdivisions' },
];

export interface SubdivisionPickerProps {
  subdivisions: Subdivision;
  subdivisionVoice: BeatInstrument;
  onChangeSubdivisions: (s: Subdivision) => void;
  onOpenSubVoicePicker: () => void;
}

export function SubdivisionPicker({
  subdivisions,
  subdivisionVoice,
  onChangeSubdivisions,
  onOpenSubVoicePicker,
}: SubdivisionPickerProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  const drum = resolveDrumByMidi(subdivisionVoice.midi);
  const subLabel = drum?.label ?? `GM ${subdivisionVoice.midi}`;
  const subOn = subdivisions !== 'off';

  return (
    <View>
      {/* Radio row */}
      <View style={styles.subdivPicker_radioRow}>
        {OPTIONS.map((opt) => {
          const selected = subdivisions === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => onChangeSubdivisions(opt.value)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={opt.aria}
              style={({ pressed }) => [
                styles.metroSigPill,
                selected && styles.metroSigPillActive,
                pressed && styles.gainPillPressed,
              ]}
            >
              <Text style={[styles.metroSigPillText, selected && styles.metroSigPillTextActive]}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Sub voice row — hidden when OFF (§5: "When subdivisions are OFF,
          hide the Sub voice row"). SETUP is the scrollable surface so
          display:'none' is fine here per §5 flicker-relaxed rule. */}
      {subOn && (
        <Pressable
          onPress={onOpenSubVoicePicker}
          accessibilityRole="button"
          accessibilityLabel={`Sub voice: ${subLabel}. Tap to change.`}
          style={({ pressed }) => [styles.subdivPicker_voiceRow, pressed && styles.subdivPicker_voiceRowPressed]}
        >
          <Text style={styles.subdivPicker_voiceRowLabel}>Sub voice</Text>
          <Text style={styles.subdivPicker_voiceRowValue} numberOfLines={1} ellipsizeMode="tail">
            {subLabel}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
