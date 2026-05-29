/**
 * DeckScreen — the DECK tab. Tape-deck recorder UI: a visualisation strip
 * (style-selected), a giant record button, a playback transport, scrubber,
 * save + clear.
 *
 * **Layout rule (hard, PORTRAIT):** fits on one screen — no ScrollView. The
 * playback card appears below the record button only when a take exists;
 * that's the one piece of conditional vertical content. If it pushes anything
 * off screen on small devices, we shrink the record button — never scroll the
 * deck in portrait.
 * **Landscape (v1.5 #69):** the short landscape body can't hold the fixed
 * portrait stack, so the body is wrapped in a ScrollView when isLandscape.
 * Portrait is unaffected (identical no-scroll tree).
 *
 * State + behavior live in `useDeck` so the screen body is mostly layout.
 */
import React, { useMemo } from 'react';
import { GestureResponderEvent, Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import * as Sharing from 'expo-sharing';
import { useTheme } from '../theme';
import { makeStyles } from '../uiShared';
import type { DeckState } from '../useDeck';
import type { DisplayMode } from '../useAudioEngine';
import { LandscapeChromeControls } from '../tunerWidgets';
import { ReelsDisplay } from '../components/deckStyles/ReelsDisplay';
import { WaveformDisplay } from '../components/deckStyles/WaveformDisplay';
import { VuDisplay } from '../components/deckStyles/VuDisplay';

export interface DeckScreenProps {
  deck: DeckState;
  deckStyle: 'reels' | 'vu' | 'waveform';
  // #69 — landscape chrome relocation. The A= stepper is suppressed in the
  // rail in landscape, so DECK must render its own plain LandscapeChromeControls
  // (returns null in portrait, so portrait is untouched). All six are required
  // by the component even though variant="plain" only uses refHz/setRefHz.
  refHz: number;
  setRefHz: (v: number) => void;
  displayMode: DisplayMode;
  setDisplayMode: (m: DisplayMode) => void;
  onTablePress: () => void;
  onPipesPress: () => void;
  /**
   * Dual-pane override (tablet landscape). A pane forces PORTRAIT layout by
   * passing `isLandscape={false}` so the deck fits a tall, narrow column even
   * though the device is physically landscape. Undefined → fall back to the
   * device orientation (winW >= winH), so every existing caller is unchanged.
   */
  isLandscape?: boolean;
}

function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function DeckScreen({
  deck, deckStyle,
  refHz, setRefHz, displayMode, setDisplayMode, onTablePress, onPipesPress,
  isLandscape: isLandscapeProp,
}: DeckScreenProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  void C;

  // Honour DeckScreen's hard layout rule (no ScrollView — shrink the record
  // button on small devices so nothing falls off-screen). On short screens
  // (e.g. pixel_2 731dp) the default 140dp button pushed the empty-state
  // helper text's last line behind the bottom nav; shrink to 112dp there.
  // Taller phones (pixel_7 914dp, Pixel 9 Pro) keep the full 140dp.
  const { width: winW, height: winH } = useWindowDimensions();
  const isLandscape = isLandscapeProp ?? (winW >= winH);
  const recordSize = winH < 780 ? 112 : 140;

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

  // v1.0.1 — local toast slot for SHARE errors. useDeck owns the canonical
  // toast; we render this one in the same toast component only when deck.toast
  // is null, so the two never collide. Same `DeckToast` shape.
  const [shareToast, setShareToast] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const shareToastIdRef = React.useRef(0);
  // v1.4 wave-10 T2 — duration split mirrors useDeck.flashToast: errors stay
  // up 5000 ms; successes use 2500 ms. Old 2400 ms was too short to read.
  const flashShareToast = React.useCallback((text: string, kind: 'ok' | 'error') => {
    shareToastIdRef.current += 1;
    const id = shareToastIdRef.current;
    setShareToast({ kind, text });
    const durationMs = kind === 'error' ? 5000 : 2500;
    setTimeout(() => {
      if (shareToastIdRef.current === id) setShareToast(null);
    }, durationMs);
  }, []);

  // v1.0.1 — SHARE handler. Hands the take URI to the OS share sheet.
  // `expo-sharing.shareAsync` covers Drive / Files / email / Messages.
  const handleShare = React.useCallback(async () => {
    if (!deck.take) return;
    // v1.0.1 — capture uri before any await so a concurrent CLEAR can't null it mid-handler.
    const uri = deck.take.uri;
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        flashShareToast("Sharing not available on this device — try SAVE.", 'error');
        return;
      }
      await Sharing.shareAsync(uri, {
        mimeType: 'audio/mp4',
        dialogTitle: 'Share take',
        UTI: 'public.mpeg-4-audio',
      });
    } catch {
      flashShareToast("Couldn't share — try SAVE first.", 'error');
    }
  }, [deck.take, flashShareToast]);

  const visibleToast = deck.toast ?? shareToast;

  // v1.5 #69 — landscape gives DECK a left/right split mirroring TUNER.
  //   LEFT  (deckLeft)  = the visualisation strip (Waveform / Vu / Reels).
  //   RIGHT (deckRight) = plain LandscapeChromeControls (A= stepper, reachable
  //                       again since the rail suppresses it in landscape) +
  //                       the record button + the playback-card-or-empty block.
  // PORTRAIT renders `<>{deckLeft}{deckRight}</>` — fragments are transparent
  // and the chrome control returns null in portrait, so the portrait tree is
  // byte-identical to before (strip → record → playback/empty, same order).
  // Toast + Modals stay siblings of the root so the absolute toast pins and the
  // Modal backdrops cover full-screen.
  const deckLeft = (
    <>
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
    </>
  );

  const deckRight = (
    <>
      {/* #69 — plain landscape chrome (A= stepper). Returns null in portrait,
          so portrait order is unchanged: this contributes nothing there. */}
      <LandscapeChromeControls
        variant="plain"
        refHz={refHz}
        setRefHz={setRefHz}
        displayMode={displayMode}
        setDisplayMode={setDisplayMode}
        onTablePress={onTablePress}
        onPipesPress={onPipesPress}
      />

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
          { width: recordSize, height: recordSize, borderRadius: recordSize / 2 },
          isRecording && styles.deckRecordBtnActive,
          pressed && styles.deckRecordBtnPressed,
        ]}
      >
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          style={[styles.deckRecordBtnText, isRecording && styles.deckRecordBtnTextActive]}
        >
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

          {/* v1.4 closeout (Frodo NOTE-2) — persistent broken-take error. When
              the take can't be loaded into a player, ▶ is a no-op; without this
              band each tap just re-fired a 5 s toast into a silent dead loop.
              Explains the state + offers CLEAR (routes through the same confirm
              gate, then drops the dead take so RECORD is available again). */}
          {deck.playerError && (
            <View style={styles.deckPlayError}>
              <Text style={styles.deckPlayErrorText}>
                This take won't play back — the audio file may be missing or
                damaged. Clear it and record again.
              </Text>
              <Pressable
                onPress={deck.requestClearTake}
                accessibilityRole="button"
                accessibilityLabel="Clear this broken take and record again (will ask to confirm)"
                style={({ pressed }) => [styles.deckActionBtn, styles.deckActionBtnDanger, pressed && styles.deckActionBtnPressed]}
              >
                <Text style={[styles.deckActionBtnText, styles.deckActionBtnTextDanger]}>CLEAR &amp; RE-RECORD</Text>
              </Pressable>
            </View>
          )}

          {/* v0.9.8 — SAVE/CLEAR hierarchy: SAVE is the dominant accent-fill
              destination action (wider, taller, on the LEFT — primary
              position). CLEAR is a smaller secondary destructive action
              with thin red outline on the RIGHT, so accidental taps on
              SAVE don't hit CLEAR. */}
          {/* v1.0.1 — SAVE | SHARE | CLEAR. SHARE uses the default outlined
              (neutral) deckActionBtn style — secondary between primary SAVE
              and danger CLEAR. */}
          <View style={styles.deckActionRow}>
            <Pressable
              onPress={() => deck.saveTake().catch(() => {})}
              accessibilityRole="button"
              accessibilityLabel="Save this take to the recordings folder. Tap SHARE to send it elsewhere."
              style={({ pressed }) => [styles.deckActionBtn, styles.deckActionBtnPrimary, pressed && styles.deckActionBtnPressed]}
            >
              <Text style={[styles.deckActionBtnText, styles.deckActionBtnTextPrimary]}>SAVE</Text>
            </Pressable>
            <Pressable
              onPress={() => { handleShare(); }}
              accessibilityRole="button"
              accessibilityLabel="Share this take to another app — save it, send it to your teacher, copy it to Drive."
              style={({ pressed }) => [styles.deckActionBtn, pressed && styles.deckActionBtnPressed]}
            >
              <Text style={styles.deckActionBtnText}>SHARE</Text>
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
    </>
  );

  return (
    <View style={{ flex: 1 }}>
      {isLandscape ? (
        <View style={{ flex: 1, flexDirection: 'row', gap: 16 }}>
          <View style={{ flex: 1, justifyContent: 'center' }}>{deckLeft}</View>
          {/* RIGHT column can over-run the short landscape height when a take is
              present (chrome + record + playback card). Contain the scroll to
              THIS column so every control stays reachable without a whole-screen
              scroll. Portrait never hits this branch. */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingVertical: 12 }}
            showsVerticalScrollIndicator={false}
          >
            {deckRight}
          </ScrollView>
        </View>
      ) : (
        <>{deckLeft}{deckRight}</>
      )}

      {/* Toast — bottom of the screen body. v1.0.1 — local SHARE toasts share
          the same slot via visibleToast (deck.toast takes precedence). */}
      {visibleToast !== null && (
        <View style={[styles.deckToast, visibleToast.kind === 'error' && styles.deckToastError]} pointerEvents="none">
          <Text style={[styles.deckToastText, visibleToast.kind === 'error' && styles.deckToastTextError]}>
            {visibleToast.text}
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
