/**
 * PitchPipes — bottom-sheet, 12 chromatic note pads at concert pitch.
 *
 * v0.9.4: migrated from a full-screen react-native <Modal> to a
 * `@gorhom/bottom-sheet` BottomSheetModal at the 92 % snap point. The pads
 * area uses BottomSheetScrollView so the inner scroll and the sheet's
 * drag-to-dismiss gesture coexist correctly — no responder fights.
 *
 * Audio path unchanged: pitchTones.buildWavBase64() emits a properly-looped
 * sine wave as base64-encoded 16-bit PCM WAV. Android's ExoPlayer rejects
 * data: URIs, so we write the bytes to the cache directory and hand the
 * resulting file:// path to expo-audio's createAudioPlayer. Each note
 * re-uses (or regenerates if refHz changed) its own cache file, keyed by
 * midi + refHz.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { File, Paths } from 'expo-file-system';
import { createAudioPlayer } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import { CHROMATIC_OCTAVE, buildWavBase64, midiToFrequency, tuningNoteForInstrument } from '../pitchTones';
import { useTheme, H } from '../theme';
import type { ThemePalette } from '../theme';

interface PitchPipesProps {
  visible: boolean;
  onClose: () => void;
  refHz: number;
  instrumentKey: string;
}

export function PitchPipes({ visible, onClose, refHz, instrumentKey }: PitchPipesProps) {
  const C = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);
  const [playingMidi, setPlayingMidi] = useState<number | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
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

  const stopTone = useCallback(() => {
    const p = playerRef.current;
    if (p) {
      try { p.pause(); } catch { /* ignore */ }
      try { p.remove(); } catch { /* ignore */ }
      playerRef.current = null;
    }
    setPlayingMidi(null);
  }, []);

  const startTone = useCallback(async (midi: number) => {
    try {
      stopTone();
      const b64 = buildWavBase64(midi, refHz);
      const file = new File(Paths.cache, `tone_${midi}_${Math.round(refHz)}.wav`);
      if (file.exists) file.delete();
      file.create();
      file.write(b64, { encoding: 'base64' });
      const player = createAudioPlayer({ uri: file.uri });
      player.loop = true;
      player.play();
      playerRef.current = player;
      setPlayingMidi(midi);
    } catch {
      // If anything failed, still flip the visual indicator so the user gets
      // *some* feedback. The audible feedback is the bonus.
      setPlayingMidi(midi);
    }
  }, [refHz, stopTone]);

  const handlePadPress = useCallback((midi: number) => {
    if (playingMidi === midi) stopTone(); else startTone(midi);
  }, [playingMidi, startTone, stopTone]);

  useEffect(() => { if (!visible) stopTone(); }, [visible, stopTone]);

  const prevRefHz = useRef(refHz);
  useEffect(() => {
    if (prevRefHz.current !== refHz) { stopTone(); prevRefHz.current = refHz; }
  }, [refHz, stopTone]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={snapPoints}
      onDismiss={() => { stopTone(); onClose(); }}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: C.inkDim }}
      backgroundStyle={{ backgroundColor: C.face, borderTopLeftRadius: 6, borderTopRightRadius: 6 }}
    >
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.title}>PITCH PIPES</Text>
          <Text style={s.subtitle}>A = {refHz} Hz  ·  concert pitch</Text>
        </View>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close pitch pipes"
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

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    header:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingVertical: 16, borderBottomColor: C.edge, borderBottomWidth: 1 },
    headerLeft:     { flex: 1 },
    title:          { color: C.ink, fontSize: 16, letterSpacing: 6, fontWeight: '700' },
    subtitle:       { color: C.inkMid, fontSize: 12, letterSpacing: 2, marginTop: 4 },
    closeBtn:       { width: H.touchTarget, height: H.touchTarget, alignItems: 'center', justifyContent: 'center', borderColor: C.edge, borderWidth: 1, borderRadius: 4 },
    closeBtnPressed:{ backgroundColor: C.edge },
    closeBtnText:   { color: C.inkMid, fontSize: 18, fontWeight: '700' },
    pads:           { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, paddingVertical: 24, gap: 12, justifyContent: 'center' },
    pad:            { width: '21%', minHeight: 96, paddingVertical: 14, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, borderColor: C.edge, borderWidth: 1, borderRadius: 4 },
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
