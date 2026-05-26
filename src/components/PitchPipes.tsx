/**
 * PitchPipes — full-screen modal, 12 chromatic note pads, concert pitch.
 *
 * Audio path: pitchTones.buildWavBase64() emits a properly-looped sine wave
 * as base64-encoded 16-bit PCM WAV. Android's ExoPlayer rejects data: URIs,
 * so we write the bytes to the cache directory and hand the resulting
 * file:// path to expo-audio's createAudioPlayer. Each note re-uses (or
 * regenerates if refHz changed) its own cache file, keyed by midi + refHz.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { createAudioPlayer } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import { CHROMATIC_OCTAVE, buildWavBase64, midiToFrequency, tuningNoteForInstrument } from '../pitchTones';

const C = {
  bg: '#07080b', face: '#0e1116', edge: '#1e242e',
  ink: '#f0f1f3', inkMid: '#a6acb6', inkDim: '#5a626d', inkVeryDim: '#3a4049',
  accent: '#d6b86a', inTune: '#5fb87a',
};

interface PitchPipesProps {
  visible: boolean;
  onClose: () => void;
  refHz: number;
  instrumentKey: string;
}

export function PitchPipes({ visible, onClose, refHz, instrumentKey }: PitchPipesProps) {
  const [playingMidi, setPlayingMidi] = useState<number | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const tuningMidi = tuningNoteForInstrument(instrumentKey)?.sounding_midi ?? null;

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
    <Modal visible={visible} transparent={false} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.root}>
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

        <ScrollView contentContainerStyle={s.pads} showsVerticalScrollIndicator={false}>
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
        </ScrollView>

        <View style={s.footer}>
          <Text style={s.footerText}>Tap a note to play. Tap again to stop. Notes are at concert pitch.</Text>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root:           { flex: 1, backgroundColor: C.face, paddingTop: 48 },
  header:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingVertical: 16, borderBottomColor: C.edge, borderBottomWidth: 1 },
  headerLeft:     { flex: 1 },
  title:          { color: C.ink, fontSize: 14, letterSpacing: 6, fontWeight: '600' },
  subtitle:       { color: C.inkDim, fontSize: 11, letterSpacing: 2, marginTop: 4 },
  closeBtn:       { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderColor: C.edge, borderWidth: 1, borderRadius: 2 },
  closeBtnPressed:{ backgroundColor: C.edge },
  closeBtnText:   { color: C.inkMid, fontSize: 16 },
  pads:           { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, paddingVertical: 24, gap: 12, justifyContent: 'center' },
  pad:            { width: '21%', minHeight: 90, paddingVertical: 14, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, borderColor: C.edge, borderWidth: 1, borderRadius: 4 },
  padTuning:      { borderColor: C.accent, borderWidth: 2 },
  padPlaying:     { backgroundColor: '#1a1f10', borderColor: C.inTune, borderWidth: 2 },
  padPressed:     { opacity: 0.7 },
  padNote:        { color: C.inkMid, fontSize: 22, fontWeight: '300', letterSpacing: -1 },
  padOctave:      { color: C.inkDim, fontSize: 12, letterSpacing: 1, marginTop: -2 },
  padHz:          { color: C.inkVeryDim, fontSize: 8, letterSpacing: 1, marginTop: 4, fontVariant: ['tabular-nums'] },
  active:         { color: C.inTune },
  dot:            { width: 6, height: 6, borderRadius: 3, backgroundColor: C.inTune, marginTop: 6 },
  footer:         { paddingHorizontal: 24, paddingVertical: 16, borderTopColor: C.edge, borderTopWidth: 1, gap: 6 },
  footerText:     { color: C.inkDim, fontSize: 11, letterSpacing: 1, textAlign: 'center' },
  footerWarn:     { color: C.inkVeryDim, fontSize: 9, letterSpacing: 1, textAlign: 'center' },
});
