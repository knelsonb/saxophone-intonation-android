/**
 * DrumPicker — v1.2 bottom-sheet for assigning a GM drum voice to a beat slot.
 *
 * Implements §6 (drum voice picker), §17.R1 (grouped + prioritized + power-user
 * MIDI toggle), §17.R2 (context suggestions), §15.Q11.11 (no preview), §16.U13
 * (simple by default, complex behind toggle).
 *
 * Structural template: PitchPipes.tsx / IntonationTable.tsx. The PARENT owns
 * the BottomSheetModal ref + calls .present()/.dismiss(); this component owns
 * the in-sheet UI only.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import {
  DRUM_FAMILIES,
  DRUM_FLAT_BY_MIDI,
  getSuggestionsForSlot,
} from '../drumVoices';
import type { BeatSlotContext, DrumVoice } from '../drumVoices';
import { useTheme, H } from '../theme';
import type { ThemePalette } from '../theme';

export interface DrumPickerProps {
  // Identity of the slot whose drum we're picking. Drives the
  // "Suggested for this beat" row at the top of the sheet.
  slotContext: BeatSlotContext;

  // Optional human-readable label like "Beat 1" or "Sub-tick" shown
  // in the sheet header so the user knows which slot they're editing.
  slotLabel: string;

  // Currently-selected MIDI note in the parent's state. The list shows
  // a checkmark/highlight on this row.
  currentMidi: number | null;

  // Fires when the user taps a row. Parent persists + dismisses the sheet.
  onSelect: (midi: number) => void;

  // Optional dismiss handler; if absent, the sheet just closes.
  onDismiss?: () => void;
}

// v1.2 — match PitchPipes/IntonationTable idiom but give the user a 50% rest
// position so the suggested row alone is visible above the fold, then a flick
// up for the full grouped/flat list.
// v1.3.2 — drop the upper snap from 85% → 78%. On the tablet (891dp logical
// height) the locked persistent header zone is ~178dp (top inset ≈ 51 + TopBar
// 136 ≈ 187, plus the new TopPillNav ~48 below it). 85% = 134dp from top —
// the sheet's drag handle overlapped the TopPillNav. 78% = 196dp from top
// leaves ~10dp clear of the header zone. Phones (lower 1080–891 budgets)
// scale proportionally; the bottom-sheet handle remains hit-testable.
const SNAP_POINTS = ['50%', '78%'] as const;

export const DrumPicker = React.forwardRef<BottomSheetModal, DrumPickerProps>(
  ({ slotContext, slotLabel, currentMidi, onSelect, onDismiss }, ref) => {
    const C = useTheme();
    const s = useMemo(() => makeStyles(C), [C]);

    // v1.2 — §17.R1 power-user toggle. Local state; orchestrator may wire a
    // prefs round-trip later (drumPickerShowAll). Default OFF per §16.U13.
    const [showAll, setShowAll] = useState(false);

    const suggestions = useMemo(
      () => getSuggestionsForSlot(slotContext),
      [slotContext],
    );

    const snapPoints = useMemo(() => SNAP_POINTS as unknown as string[], []);

    const renderBackdrop = useCallback(
      (props: BottomSheetBackdropProps) => (
        <BottomSheetBackdrop
          {...props}
          disappearsOnIndex={-1}
          appearsOnIndex={0}
          opacity={0.72}
          pressBehavior="close"
        />
      ),
      [],
    );

    const handleClose = useCallback(() => {
      if (onDismiss) onDismiss();
      // Parent owns dismissal via the ref; if the parent didn't pass an
      // onDismiss, BottomSheetModal's own backdrop/drag still works.
    }, [onDismiss]);

    const renderVoiceRow = useCallback(
      (voice: DrumVoice) => {
        const selected = voice.midi === currentMidi;
        return (
          <Pressable
            key={`row-${voice.midi}`}
            onPress={() => onSelect(voice.midi)}
            accessibilityRole="button"
            accessibilityLabel={`Select ${voice.label}, MIDI ${voice.midi}`}
            accessibilityState={{ selected }}
            style={({ pressed }) => [
              s.drumPickerVoiceRow,
              selected && s.drumPickerVoiceRowSelected,
              pressed && s.drumPickerVoiceRowPressed,
            ]}
          >
            <Text style={s.drumPickerMidiNumber}>{String(voice.midi).padStart(2, '0')}</Text>
            <Text
              style={s.drumPickerVoiceLabel}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {voice.label}
            </Text>
            {voice.shortLabel ? (
              <Text style={s.drumPickerVoiceShort}>{voice.shortLabel}</Text>
            ) : null}
          </Pressable>
        );
      },
      [currentMidi, onSelect, s],
    );

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={snapPoints}
        onDismiss={handleClose}
        backdropComponent={renderBackdrop}
        handleIndicatorStyle={{ backgroundColor: C.inkDim }}
        backgroundStyle={{
          backgroundColor: C.bg,
          borderTopLeftRadius: 6,
          borderTopRightRadius: 6,
        }}
      >
        <View style={s.drumPickerSheet}>
          {/* Header — title + close button. Fixed height so toggling showAll
              below cannot shift it (per "no layout flicker" hard rule). */}
          <View style={s.drumPickerHeader}>
            <Text
              style={s.drumPickerHeaderTitle}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {`Drum for ${slotLabel}`}
            </Text>
            <Pressable
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Close drum picker"
              style={({ pressed }) => [
                s.drumPickerHeaderClose,
                pressed && s.drumPickerHeaderClosePressed,
              ]}
            >
              <Text style={s.drumPickerHeaderCloseText}>{'✕'}</Text>
            </Pressable>
          </View>

          {/* §17.R2 — Suggested for this beat. Wrap so 5 pills flow safely on
              narrow phones; reuses the metroSigPill visual idiom. */}
          <View style={s.drumPickerSuggestedRow}>
            <Text style={s.drumPickerSuggestedLabel}>SUGGESTED</Text>
            <View style={s.drumPickerSuggestedPillRow}>
              {suggestions.map((voice) => {
                const selected = voice.midi === currentMidi;
                return (
                  <Pressable
                    key={`sug-${voice.midi}`}
                    onPress={() => onSelect(voice.midi)}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${voice.label}, MIDI ${voice.midi}`}
                    accessibilityState={{ selected }}
                    style={({ pressed }) => [
                      s.drumPickerSuggestedPill,
                      selected && s.drumPickerSuggestedPillActive,
                      pressed && s.drumPickerSuggestedPillPressed,
                    ]}
                  >
                    <Text
                      style={[
                        s.drumPickerSuggestedPillText,
                        selected && s.drumPickerSuggestedPillTextActive,
                      ]}
                      numberOfLines={1}
                    >
                      {voice.shortLabel ?? voice.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* §17.R1 / §16.U13 — Show-all toggle. Single row, fixed height. */}
          <Pressable
            onPress={() => setShowAll((v) => !v)}
            accessibilityRole="switch"
            accessibilityLabel="Show all sounds in MIDI order"
            accessibilityState={{ checked: showAll }}
            style={({ pressed }) => [
              s.drumPickerToggleRow,
              pressed && s.drumPickerToggleRowPressed,
            ]}
          >
            <Text style={s.drumPickerToggleLabel}>Show all sounds (MIDI order)</Text>
            <View
              style={[
                s.drumPickerToggleSwitch,
                showAll && s.drumPickerToggleSwitchOn,
              ]}
            >
              <Text style={s.drumPickerToggleSwitchText}>{showAll ? 'ON' : 'OFF'}</Text>
            </View>
          </Pressable>

          {/* Body — grouped or flat. Toggle re-renders only this region so
              the header + suggested row + toggle row stay rock-still. */}
          <BottomSheetScrollView
            style={s.drumPickerBody}
            contentContainerStyle={s.drumPickerBodyContent}
            showsVerticalScrollIndicator
          >
            {showAll ? (
              // Power-user mode: flat ascending MIDI. Keep it visually simple
              // per §17.R1 — no section headers, just rows.
              DRUM_FLAT_BY_MIDI.map(renderVoiceRow)
            ) : (
              // Default mode: grouped + prioritized. One section header per
              // family with the MIDI range, then the family's voices in
              // musical-priority order.
              DRUM_FAMILIES.map((family) => {
                const midis = family.voices.map((v) => v.midi);
                const min = Math.min(...midis);
                const max = Math.max(...midis);
                const range = min === max ? `${min}` : `${min}–${max}`;
                return (
                  <View key={`fam-${family.id}`}>
                    <Text style={s.drumPickerFamilyHeader}>
                      {`${family.label.toUpperCase()} · ${range}`}
                    </Text>
                    {family.voices.map(renderVoiceRow)}
                  </View>
                );
              })
            )}
            <View style={{ height: 24 }} />
          </BottomSheetScrollView>
        </View>
      </BottomSheetModal>
    );
  },
);

DrumPicker.displayName = 'DrumPicker';

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    drumPickerSheet: { flex: 1, backgroundColor: C.bg },

    // Header — ~48dp tall, fixed. Mirrors IntonationTable's header idiom.
    drumPickerHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderBottomColor: C.edge,
      borderBottomWidth: 1,
      minHeight: H.touchTarget,
    },
    drumPickerHeaderTitle: {
      flex: 1,
      color: C.ink,
      fontSize: 14,
      letterSpacing: 3,
      fontWeight: '700',
    },
    drumPickerHeaderClose: {
      width: H.touchTarget,
      height: H.touchTarget,
      alignItems: 'center',
      justifyContent: 'center',
      borderColor: C.edge,
      borderWidth: 1,
      borderRadius: 4,
    },
    drumPickerHeaderClosePressed: { backgroundColor: C.edge },
    drumPickerHeaderCloseText: { color: C.inkMid, fontSize: 16, fontWeight: '700' },

    // Suggested-for-this-beat row. Pills reuse metroSigPill idiom (same look).
    drumPickerSuggestedRow: {
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 10,
      borderBottomColor: C.edgeSoft,
      borderBottomWidth: 1,
      gap: 8,
    },
    drumPickerSuggestedLabel: {
      color: C.inkDim,
      fontSize: 10,
      letterSpacing: 3,
      fontWeight: '700',
    },
    drumPickerSuggestedPillRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    drumPickerSuggestedPill: {
      minWidth: 56,
      height: H.pillHeight,
      paddingHorizontal: 10,
      borderColor: C.edge,
      borderWidth: 1,
      borderRadius: 4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    drumPickerSuggestedPillActive: { backgroundColor: C.accent, borderColor: C.accent },
    drumPickerSuggestedPillPressed: { opacity: 0.7 },
    drumPickerSuggestedPillText: {
      color: C.inkMid,
      fontSize: 12,
      letterSpacing: 1,
      fontWeight: '700',
    },
    drumPickerSuggestedPillTextActive: { color: C.onAccent },

    // Show-all toggle. One row, ≥48dp tall (HIG).
    drumPickerToggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderBottomColor: C.edge,
      borderBottomWidth: 1,
      minHeight: H.touchTarget,
    },
    drumPickerToggleRowPressed: { backgroundColor: C.edgeSoft },
    drumPickerToggleLabel: {
      flex: 1,
      color: C.inkMid,
      fontSize: 13,
      letterSpacing: 1,
    },
    drumPickerToggleSwitch: {
      minWidth: 56,
      height: H.pillHeight,
      paddingHorizontal: 12,
      borderColor: C.edge,
      borderWidth: 1,
      borderRadius: 4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    drumPickerToggleSwitchOn: { backgroundColor: C.accent, borderColor: C.accent },
    drumPickerToggleSwitchText: {
      color: C.inkMid,
      fontSize: 11,
      letterSpacing: 2,
      fontWeight: '700',
    },

    // Body scroll region.
    drumPickerBody: { flex: 1 },
    drumPickerBodyContent: { paddingBottom: 24 },

    // Family section header — flush, terse, MIDI range appended.
    drumPickerFamilyHeader: {
      color: C.inkDim,
      fontSize: 10,
      letterSpacing: 3,
      fontWeight: '700',
      paddingHorizontal: 20,
      paddingTop: 14,
      paddingBottom: 6,
      backgroundColor: C.bg,
    },

    // Individual voice row. ≥48dp tall, parallels setupVoiceGmRow idiom.
    drumPickerVoiceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 20,
      paddingVertical: 12,
      minHeight: H.touchTarget,
      borderBottomColor: C.edgeSoft,
      borderBottomWidth: 1,
    },
    drumPickerVoiceRowSelected: { backgroundColor: C.accentTint },
    drumPickerVoiceRowPressed: { backgroundColor: C.edgeSoft },

    drumPickerMidiNumber: {
      color: C.inkDim,
      fontSize: 11,
      letterSpacing: 1,
      fontVariant: ['tabular-nums'],
      minWidth: 28,
    },
    drumPickerVoiceLabel: {
      flex: 1,
      color: C.ink,
      fontSize: 14,
      letterSpacing: 0.5,
    },
    drumPickerVoiceShort: {
      color: C.inkDim,
      fontSize: 10,
      letterSpacing: 2,
      fontWeight: '700',
      minWidth: 52,
      textAlign: 'right',
    },
  });
}
