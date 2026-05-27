/**
 * DeckScreen — the DECK tab. Tape-deck recorder UI: a visualisation strip
 * (style-selected), a giant record button, a playback transport, scrubber,
 * save + clear.
 *
 * **Layout rule (hard):** fits on one screen — no ScrollView. The playback
 * card appears below the record button only when a take exists; that's the
 * one piece of conditional vertical content. If it pushes anything off
 * screen on small devices, we shrink the record button — never scroll the
 * deck.
 *
 * State + behavior live in `useDeck` so the screen body is mostly layout.
 */
import React, { useMemo } from 'react';
import { GestureResponderEvent, Modal, Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { makeStyles } from '../uiShared';
import type { DeckState } from '../useDeck';
import { ReelsDisplay } from '../components/deckStyles/ReelsDisplay';
import { WaveformDisplay } from '../components/deckStyles/WaveformDisplay';
import { VuDisplay } from '../components/deckStyles/VuDisplay';

export interface DeckScreenProps {
  deck: DeckState;
  deckStyle: 'reels' | 'vu' | 'waveform';
}

function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function DeckScreen({ deck, deckStyle }: DeckScreenProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  void C;

  const isRecording = deck.mode === 'recording';
  const isPlaying = deck.mode === 'playing';
  const hasTake = deck.take !== null;
  const dur = deck.playDur > 0 ? deck.playDur : (deck.take?.durationSec ?? 0);
  const frac = dur > 0 ? Math.max(0, Math.min(1, deck.playPos / dur)) : 0;

  const clockSec = isRecording ? deck.recordingSeconds : deck.playPos;
  const statusLine = isRecording
    ? 'RECORDING'
    : isPlaying
    ? `PLAYING · ${mmss(deck.playPos)} / ${mmss(dur)}`
    : hasTake
    ? `READY · ${mmss(dur)} take`
    : 'TAP RECORD TO START';

  // Scrubber: capture x and scrub to that fraction.
  const trackWidthRef = React.useRef<number>(0);
  const handleScrubFromX = (x: number) => {
    if (trackWidthRef.current <= 0) return;
    deck.scrubTo(x / trackWidthRef.current);
  };

  return (
    <View style={{ flex: 1 }}>
      {/* v0.9.8 — `screenHeader` ("DECK" + subtitle) removed for the same
          reason as METRO: tab bar already names this tab. */}

      {/* Visualisation strip */}
      {deckStyle === 'waveform' ? (
        <WaveformDisplay
          mode={deck.mode}
          recordingSec={deck.recordingSeconds}
          takeSeed={deck.take?.capturedAtMs ?? null}
          takeDurationSec={dur}
          playFraction={frac}
          clockSec={clockSec}
          statusLine={statusLine}
        />
      ) : deckStyle === 'vu' ? (
        <VuDisplay
          mode={deck.mode}
          clockSec={clockSec}
          statusLine={statusLine}
        />
      ) : (
        <ReelsDisplay
          spinning={isRecording || isPlaying}
          clockSec={clockSec}
          durationSec={dur > 0 ? dur : null}
          statusLine={statusLine}
          highlightClock={isRecording}
        />
      )}

      {/* Giant record / stop button */}
      <Pressable
        onPress={() => {
          if (isRecording) {
            deck.stopRecord().catch(() => {});
          } else {
            deck.startRecord();
          }
        }}
        accessibilityRole="button"
        accessibilityLabel={isRecording ? 'Stop recording' : 'Start recording'}
        style={({ pressed }) => [
          styles.deckRecordBtn,
          isRecording && styles.deckRecordBtnActive,
          pressed && styles.deckRecordBtnPressed,
        ]}
      >
        <Text style={[styles.deckRecordBtnText, isRecording && styles.deckRecordBtnTextActive]}>
          {isRecording ? 'STOP' : 'RECORD'}
        </Text>
      </Pressable>

      {/* Playback section — only when we have a take. */}
      {hasTake && !isRecording && (
        <View style={styles.deckPlaybackCard}>
          <View style={styles.deckPlayRow}>
            <Pressable
              onPress={deck.togglePlayPause}
              accessibilityRole="button"
              accessibilityLabel={isPlaying ? 'Pause playback' : 'Play recording'}
              style={({ pressed }) => [styles.deckPlayBtn, pressed && styles.deckPlayBtnPressed]}
            >
              <Text style={styles.deckPlayBtnText}>{isPlaying ? '||' : '▶'}</Text>
            </Pressable>
            <View
              style={styles.deckScrubOuter}
              onLayout={(e) => { trackWidthRef.current = e.nativeEvent.layout.width; }}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={(e: GestureResponderEvent) => handleScrubFromX(e.nativeEvent.locationX)}
              onResponderMove={(e: GestureResponderEvent) => handleScrubFromX(e.nativeEvent.locationX)}
              accessibilityRole="adjustable"
              accessibilityLabel={`Playback position. ${mmss(deck.playPos)} of ${mmss(dur)}.`}
            >
              <View style={styles.deckScrubTrack}>
                <View style={[styles.deckScrubFill, { width: `${frac * 100}%` }]} />
              </View>
              <View style={[styles.deckScrubKnob, { left: `${frac * 100}%` }]} pointerEvents="none" />
            </View>
          </View>
          <View style={styles.deckTimecodes}>
            <Text style={styles.deckTimecode}>{mmss(deck.playPos)}</Text>
            <Text style={styles.deckTimecode}>{mmss(dur)}</Text>
          </View>

          {/* v0.9.8 — SAVE/CLEAR hierarchy: SAVE is the dominant accent-fill
              destination action (wider, taller, on the LEFT — primary
              position). CLEAR is a smaller secondary destructive action
              with thin red outline on the RIGHT, so accidental taps on
              SAVE don't hit CLEAR. */}
          <View style={styles.deckActionRow}>
            <Pressable
              onPress={() => deck.saveTake().catch(() => {})}
              accessibilityRole="button"
              accessibilityLabel="Save this take to the recordings folder"
              style={({ pressed }) => [styles.deckActionBtn, styles.deckActionBtnPrimary, pressed && styles.deckActionBtnPressed]}
            >
              <Text style={[styles.deckActionBtnText, styles.deckActionBtnTextPrimary]}>SAVE</Text>
            </Pressable>
            <Pressable
              onPress={deck.requestClearTake}
              accessibilityRole="button"
              accessibilityLabel="Clear the current take (will ask to confirm)"
              style={({ pressed }) => [styles.deckActionBtn, styles.deckActionBtnDanger, pressed && styles.deckActionBtnPressed]}
            >
              <Text style={[styles.deckActionBtnText, styles.deckActionBtnTextDanger]}>CLEAR</Text>
            </Pressable>
          </View>
        </View>
      )}

      {!hasTake && !isRecording && (
        <View style={styles.deckEmpty}>
          <Text style={styles.deckEmptyText}>
            One take at a time, kept in memory until you SAVE or CLEAR.{'\n'}
            5-minute cap. Stops automatically if you switch tabs to the background.
          </Text>
        </View>
      )}

      {/* Toast — bottom of the screen body. */}
      {deck.toast !== null && (
        <View style={[styles.deckToast, deck.toast.kind === 'error' && styles.deckToastError]} pointerEvents="none">
          <Text style={[styles.deckToastText, deck.toast.kind === 'error' && styles.deckToastTextError]}>
            {deck.toast.text}
          </Text>
        </View>
      )}

      {/* Discard-and-record confirmation. Wrapped in <Modal> so the backdrop
          actually covers the screen and the underlying RECORD button can't be
          re-tapped while the prompt is up. Was an in-flow sibling before,
          which let touches leak through and pushed the layout. */}
      <Modal
        visible={deck.pendingConfirm === 'discard-and-record'}
        transparent
        animationType="fade"
        onRequestClose={deck.cancelDiscardAndRecord}
        statusBarTranslucent
      >
        <Pressable
          style={styles.deckConfirmRoot}
          onPress={deck.cancelDiscardAndRecord}
          accessibilityLabel="Dismiss confirmation"
        >
          <Pressable style={styles.deckConfirmCard} onPress={() => {}}>
            <Text style={styles.deckConfirmTitle}>DISCARD CURRENT TAKE?</Text>
            <Text style={styles.deckConfirmBody}>
              You have an unsaved recording. Recording a new take will throw it out. Save it first if you want to keep it.
            </Text>
            <View style={styles.deckConfirmRow}>
              <Pressable
                onPress={deck.cancelDiscardAndRecord}
                accessibilityRole="button"
                accessibilityLabel="Cancel and keep the existing take"
                style={({ pressed }) => [styles.deckActionBtn, pressed && styles.deckActionBtnPressed]}
              >
                <Text style={styles.deckActionBtnText}>CANCEL</Text>
              </Pressable>
              <Pressable
                onPress={deck.confirmDiscardAndRecord}
                accessibilityRole="button"
                accessibilityLabel="Discard the existing take and start a new recording"
                style={({ pressed }) => [styles.deckActionBtn, styles.deckActionBtnDanger, pressed && styles.deckActionBtnPressed]}
              >
                <Text style={[styles.deckActionBtnText, styles.deckActionBtnTextDanger]}>DISCARD + RECORD</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* v1.0 — CLEAR confirmation. Same Modal shape as discard-and-record so
          users see one consistent destructive-action pattern. */}
      <Modal
        visible={deck.pendingConfirm === 'clear-take'}
        transparent
        animationType="fade"
        onRequestClose={deck.cancelClearTake}
        statusBarTranslucent
      >
        <Pressable
          style={styles.deckConfirmRoot}
          onPress={deck.cancelClearTake}
          accessibilityLabel="Dismiss confirmation"
        >
          <Pressable style={styles.deckConfirmCard} onPress={() => {}}>
            <Text style={styles.deckConfirmTitle}>DISCARD CURRENT TAKE?</Text>
            <Text style={styles.deckConfirmBody}>
              Removes this take from playback. Saved copies on disk are not affected.
            </Text>
            <View style={styles.deckConfirmRow}>
              <Pressable
                onPress={deck.cancelClearTake}
                accessibilityRole="button"
                accessibilityLabel="Keep the current take"
                style={({ pressed }) => [styles.deckActionBtn, pressed && styles.deckActionBtnPressed]}
              >
                <Text style={styles.deckActionBtnText}>KEEP</Text>
              </Pressable>
              <Pressable
                onPress={deck.confirmClearTake}
                accessibilityRole="button"
                accessibilityLabel="Discard the take permanently"
                style={({ pressed }) => [styles.deckActionBtn, styles.deckActionBtnDanger, pressed && styles.deckActionBtnPressed]}
              >
                <Text style={[styles.deckActionBtnText, styles.deckActionBtnTextDanger]}>DISCARD</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
