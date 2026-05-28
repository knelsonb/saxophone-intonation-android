/**
 * PitchPipes — bottom-sheet, 12 chromatic note pads at concert pitch.
 *
 * v0.9.4: migrated from a full-screen react-native <Modal> to a
 * `@gorhom/bottom-sheet` BottomSheetModal at the 92 % snap point. The pads
 * area uses BottomSheetScrollView so the inner scroll and the sheet's
 * drag-to-dismiss gesture coexist correctly — no responder fights.
 *
 * v1.3 Wave 2C: audio path swapped from the expo-audio WAV-loop to a
 * MIDI-bus-mediated infinite-sustain pipe (see src/usePitchPipes.ts and
 * docs/v1.3-state-machine-scrub.md §6.5.10). UI layout unchanged — only
 * the tap handler and the "is playing" highlight bind through the hook.
 * The legacy WAV synth (pitchTones.buildWavBase64) is retained for now
 * per G15 (`@deprecated` one release, delete in v1.4).
 *
 * v1.4 wave-9 — T1: close button calls sheetRef.current?.dismiss() instead
 * of onClose() directly. onDismiss is now the sole entry point for every
 * dismiss path (button, drag, backdrop, programmatic visible=false). This
 * eliminates the double-onClose that fired when the button called onClose →
 * parent set visible=false → useEffect issued dismiss() → onDismiss fired
 * onClose() again.
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { type DimensionValue, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { CHROMATIC_OCTAVE, midiToFrequency, tuningNoteForInstrument } from '../pitchTones';
import type { PipesState } from '../usePitchPipes';
import { useTheme, H } from '../theme';
import type { ThemePalette } from '../theme';

interface PitchPipesProps {
  visible: boolean;
  onClose: () => void;
  refHz: number;
  instrumentKey: string;
  // v1.3.1 hotfix — pipes state lifted to App.tsx (single owner of the
  // 'pipes' channel reservation). Passing the hook return down as a prop
  // so the modal doesn't claim the channel a second time and lose to the
  // bus's first-claimant-wins policy. (U23 silent fallback was hiding this.)
  pipes: PipesState;
}

// v1.4 wave-11 — L1: column count by viewport width for narrow-phone support.
function colCount(width: number): 3 | 4 | 6 {
  if (width < 380) return 3;
  if (width < 600) return 4;
  return 6;
}

export function PitchPipes({ visible, onClose, refHz, instrumentKey, pipes }: PitchPipesProps) {
  const C = useTheme();
  const { width } = useWindowDimensions();
  const cols = colCount(width);
  const s = useMemo(() => makeStyles(C, cols), [C, cols]);
  void refHz; // a4Hz is consumed inside the App-level usePitchPipes call.

  const playingMidi = pipes.currentMidi;

  const tuningMidi = tuningNoteForInstrument(instrumentKey)?.sounding_midi ?? null;

  const sheetRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => ['92%'], []);
  useEffect(() => {
    if (visible) sheetRef.current?.present();
    else sheetRef.current?.dismiss();
  }, [visible]);

  const renderBackdrop = useCallback((props: BottomSheetBackdropProps) => (
    <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.72} pressBehavior="close" />
  ), []);

  const handlePadPress = useCallback((midi: number) => {
    pipes.toggle(midi);
  }, [pipes]);

  // When the modal hides, kill the sustaining pipe so the user never has a
  // "ghost note" continuing when they expect silence. The hook's a4Hz dep
  // already handles refHz mid-sustain by re-applying the baseline bend, so
  // we don't need to stop on refHz change.
  useEffect(() => {
    if (!visible) pipes.release();
  }, [visible, pipes]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={snapPoints}
      onDismiss={() => { pipes.release(); onClose(); }}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: C.inkDim }}
      backgroundStyle={{ backgroundColor: C.face, borderTopLeftRadius: 6, borderTopRightRadius: 6 }}
    >
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.title}>PITCH PIPES</Text>
          <Text style={s.subtitle}>A = {refHz} Hz  ·  concert pitch</Text>
        </View>
        {/* v1.4 wave-9 — T1: dismiss via sheetRef so onDismiss is the sole
            onClose entry point for ALL paths (button, drag, backdrop, programmatic). */}
        <Pressable onPress={() => sheetRef.current?.dismiss()} accessibilityRole="button" accessibilityLabel="Close pitch pipes"
          style={({ pressed }) => [s.closeBtn, pressed && s.closeBtnPressed]}>
          <Text style={s.closeBtnText}>✕</Text>
        </Pressable>
      </View>

      <BottomSheetScrollView contentContainerStyle={s.pads}>
        {CHROMATIC_OCTAVE.map((note) => {
          const isPlaying = playingMidi === note.midi;
          const isTuning = tuningMidi === note.midi;
          const freqHz = midiToFrequency(note.midi, refHz);
          return (
            <Pressable key={note.midi} onPress={() => handlePadPress(note.midi)}
              accessibilityRole="button"
              accessibilityLabel={`${note.name}4, ${freqHz.toFixed(1)} Hz${isTuning ? ', tuning note' : ''}${isPlaying ? ', playing' : ''}`}
              accessibilityState={{ selected: isPlaying }}
              style={({ pressed }) => [s.pad, isTuning && s.padTuning, isPlaying && s.padPlaying, pressed && s.padPressed]}>
              <Text style={[s.padNote, isPlaying && s.active]}>{note.name}</Text>
              <Text style={[s.padOctave, isPlaying && s.active]}>4</Text>
              <Text style={[s.padHz, isPlaying && s.active]}>{freqHz.toFixed(1)} Hz</Text>
              {isPlaying && <View style={s.dot} />}
            </Pressable>
          );
        })}
      </BottomSheetScrollView>

      <View style={s.footer}>
        <Text style={s.footerText}>Tap a note to play. Tap again to stop. Notes are at concert pitch.</Text>
      </View>
    </BottomSheetModal>
  );
}

// v1.4 wave-11 — L1: makeStyles accepts cols (3 | 4 | 6) to set pad flex-basis.
// Gap is 12dp between pads; container has paddingHorizontal:16.
// Width percentage leaves ~1% slack per pad so rounding never causes an extra
// wrap row. Gap spacing is handled by the `gap:12` on the container.
function makeStyles(C: ThemePalette, cols: 3 | 4 | 6) {
  // e.g. cols=3 → '32%', cols=4 → '24%', cols=6 → '15%'
  const padWidthPct = `${Math.floor(100 / cols) - 1}%` as DimensionValue;
  return StyleSheet.create({
    header:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingVertical: 16, borderBottomColor: C.edge, borderBottomWidth: 1 },
    headerLeft:     { flex: 1 },
    title:          { color: C.ink, fontSize: 16, letterSpacing: 6, fontWeight: '700' },
    subtitle:       { color: C.inkMid, fontSize: 12, letterSpacing: 2, marginTop: 4 },
    closeBtn:       { width: H.touchTarget, height: H.touchTarget, alignItems: 'center', justifyContent: 'center', borderColor: C.edge, borderWidth: 1, borderRadius: 4 },
    closeBtnPressed:{ backgroundColor: C.edge },
    closeBtnText:   { color: C.inkMid, fontSize: 18, fontWeight: '700' },
    pads:           { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, paddingVertical: 24, gap: 12, justifyContent: 'center' },
    pad:            { width: padWidthPct, minHeight: 96, paddingVertical: 14, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, borderColor: C.edge, borderWidth: 1, borderRadius: 4 },
    padTuning:      { borderColor: C.accent, borderWidth: 2 },
    padPlaying:     { backgroundColor: C.successTint, borderColor: C.inTune, borderWidth: 2 },
    padPressed:     { opacity: 0.7 },
    padNote:        { color: C.ink, fontSize: 24, fontWeight: '400', letterSpacing: -1 },
    padOctave:      { color: C.inkMid, fontSize: 13, letterSpacing: 1, marginTop: -2 },
    padHz:          { color: C.inkDim, fontSize: 10, letterSpacing: 1, marginTop: 4, fontVariant: ['tabular-nums'] },
    active:         { color: C.inTune },
    dot:            { width: 8, height: 8, borderRadius: 4, backgroundColor: C.inTune, marginTop: 6 },
    footer:         { paddingHorizontal: 24, paddingVertical: 16, borderTopColor: C.edge, borderTopWidth: 1, gap: 6 },
    footerText:     { color: C.inkMid, fontSize: 12, letterSpacing: 1, textAlign: 'center' },
  });
}
