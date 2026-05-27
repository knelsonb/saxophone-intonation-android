/**
 * useDeck — tape-deck recorder state. One in-memory recording at a time.
 *
 * Record path: `useAudioRecorder` from expo-audio with `RecordingPresets.HIGH_QUALITY`
 * (m4a / AAC on Android). The recorder lives at the hook scope; `record()` /
 * `stop()` toggle a single take. After `stop()`, the recorder's URI points to
 * a temp file we can hand to `createAudioPlayer` for review.
 *
 * Playback: a separate `AudioPlayer` instance is created once a take exists.
 * Replacing the player's source on each save would force a re-prepare; we
 * just dispose-and-recreate when the take changes (a discard or new record).
 *
 * Save path: write the take to `${documentDirectory}/bellcurve-recordings/`
 * with a timestamped filename. We use `File.copy` from `expo-file-system`
 * so the original temp file stays put (lets the user save AND keep reviewing
 * the same take). Output extension follows the recorder's `.m4a` default.
 *
 * Memory cap: 5 minutes of recording, enforced by the recorder's own status
 * — when `currentTime >= 300` we stop the take automatically.
 *
 * Lifecycle: AppState 'background' stops an in-progress recording (a
 * background mic-recording requires foreground service config we don't ship)
 * but leaves a finished take in memory for the next foregrounding.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { File, Directory, Paths } from 'expo-file-system';
import {
  useAudioRecorder,
  useAudioRecorderState,
  createAudioPlayer,
  RecordingPresets,
} from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';

const MAX_RECORDING_SECONDS = 5 * 60; // 5 minutes

// v1.0 — anything shorter than this on a background-forced stop is treated
// as an accidental tap and dropped rather than kept as an orphan take.
const MIN_VALID_TAKE_SEC = 0.5;

const SAVED_DIRNAME = 'bellcurve-recordings';

export type DeckMode = 'idle' | 'recording' | 'have-take' | 'playing';

export interface DeckTake {
  /** file:// uri to the temp recording */
  uri: string;
  /** Duration in seconds. May be approximate until playback first loads. */
  durationSec: number;
  /** Captured at this wall-clock ms. */
  capturedAtMs: number;
}

export interface DeckToast {
  text: string;
  kind: 'ok' | 'error';
  id: number;
}

export interface DeckState {
  mode: DeckMode;
  recordingSeconds: number;
  /** Current take, or null if no recording exists. */
  take: DeckTake | null;
  /** Playback position in seconds. */
  playPos: number;
  /** Playback duration in seconds. 0 until first load. */
  playDur: number;
  /** True while a confirmation dialog is pending. */
  pendingConfirm: 'discard-and-record' | 'clear-take' | null;
  toast: DeckToast | null;
  // Actions
  startRecord: () => void;
  stopRecord: () => Promise<void>;
  togglePlayPause: () => void;
  scrubTo: (frac: number) => void;
  /** Immediate clear — no confirm. Prefer `requestClearTake` from the UI. */
  clearTake: () => void;
  saveTake: () => Promise<void>;
  confirmDiscardAndRecord: () => void;
  cancelDiscardAndRecord: () => void;
  // v1.0 — CLEAR is destructive: route the UI through a confirm gate.
  requestClearTake: () => void;
  confirmClearTake: () => void;
  cancelClearTake: () => void;
}

export function useDeck(): DeckState {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recState = useAudioRecorderState(recorder, 200);

  const [take, setTake] = useState<DeckTake | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  // v1.0.1 BUG-5 — single-shot guard across the three recording-close paths
  // (manual stopRecord, 5-min cap auto-stop, AppState background). Whichever
  // path fires first wins; the others bail. Always cleared in a `finally`.
  const recordingClosingRef = useRef(false);
  const [playPos, setPlayPos] = useState(0);
  const [playDur, setPlayDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<DeckState['pendingConfirm']>(null);
  const [toast, setToast] = useState<DeckToast | null>(null);
  const toastIdRef = useRef(0);
  // v1.3.4 B8 — track pending toast timers so unmount can clear them and
  // avoid setState-on-unmounted-component warnings.
  const toastTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const flashToast = useCallback((text: string, kind: 'ok' | 'error') => {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToast({ text, kind, id });
    const t = setTimeout(() => {
      toastTimersRef.current.delete(t);
      setToast((prev) => (prev && prev.id === id ? null : prev));
    }, 2500);
    toastTimersRef.current.add(t);
  }, []);

  // Disposes the active player if any.
  const disposePlayer = useCallback(() => {
    const p = playerRef.current;
    if (p) {
      try { p.pause(); } catch { /* ignore */ }
      try { p.remove(); } catch { /* ignore */ }
      playerRef.current = null;
    }
    setPlaying(false);
    setPlayPos(0);
    setPlayDur(0);
  }, []);

  // Ensure a player exists for the current take. Idempotent.
  const ensurePlayer = useCallback((uri: string): AudioPlayer | null => {
    if (playerRef.current) return playerRef.current;
    try {
      const p = createAudioPlayer({ uri });
      playerRef.current = p;
      return p;
    } catch {
      return null;
    }
  }, []);

  // Poll the player for currentTime / duration while we have a take. Cheap —
  // 5 Hz keeps the scrubber smooth without taxing JS.
  useEffect(() => {
    if (!take) return;
    const id = setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      const ct = p.currentTime;
      const dur = p.duration;
      if (Number.isFinite(ct)) setPlayPos(ct);
      if (Number.isFinite(dur) && dur > 0) setPlayDur(dur);
      // If playback ran off the end, mirror that back to React.
      if (Number.isFinite(dur) && Number.isFinite(ct) && dur > 0 && ct >= dur - 0.05 && playing) {
        setPlaying(false);
      }
    }, 200);
    return () => clearInterval(id);
  }, [take, playing]);

  // Auto-stop recording at the 5-minute cap.
  useEffect(() => {
    if (!recState.isRecording) return;
    if ((recState.durationMillis ?? 0) >= MAX_RECORDING_SECONDS * 1000) {
      // Trigger a normal stop; the take will land in `take` via the handler.
      // Inline to avoid a stale closure.
      (async () => {
        if (recordingClosingRef.current) return;
        recordingClosingRef.current = true;
        try {
          try { await recorder.stop(); } catch { /* ignore */ }
          const uri = recorder.uri;
          if (uri) {
            // v1.0.1 BUG-4 — mirror manual stopRecord ordering: dispose any
            // stale player from the previous take BEFORE installing the new
            // take, otherwise the orphan AudioPlayer leaks.
            disposePlayer();
            setTake({
              uri,
              durationSec: MAX_RECORDING_SECONDS,
              capturedAtMs: Date.now(),
            });
            flashToast('Reached 5 min cap — recording stopped', 'ok');
          }
        } finally {
          recordingClosingRef.current = false;
        }
      })();
    }
  }, [recState.isRecording, recState.durationMillis, recorder, disposePlayer, flashToast]);

  // ---------- actions ----------

  const startRecord = useCallback(() => {
    if (take !== null) {
      // Confirm before overwriting an unsaved take.
      setPendingConfirm('discard-and-record');
      return;
    }
    (async () => {
      try {
        await recorder.prepareToRecordAsync();
        recorder.record();
      } catch (e) {
        flashToast('Could not start recording', 'error');
      }
    })();
  }, [recorder, take, flashToast]);

  const stopRecord = useCallback(async () => {
    // v1.0.1 BUG-5 — race-guard against AppState background / 5-min cap that
    // may already be closing the recording. Whichever path fires first wins.
    if (recordingClosingRef.current) return;
    recordingClosingRef.current = true;
    try {
      try {
        await recorder.stop();
      } catch {
        flashToast('Stop failed — recording may be incomplete', 'error');
      }
      const uri = recorder.uri;
      if (!uri) {
        flashToast('No audio captured', 'error');
        return;
      }
      const durSec = (recState.durationMillis ?? 0) / 1000;
      disposePlayer();
      setTake({
        uri,
        durationSec: durSec,
        capturedAtMs: Date.now(),
      });
    } finally {
      recordingClosingRef.current = false;
    }
  }, [recorder, recState.durationMillis, disposePlayer, flashToast]);

  const confirmDiscardAndRecord = useCallback(() => {
    setPendingConfirm(null);
    disposePlayer();
    setTake(null);
    (async () => {
      try {
        await recorder.prepareToRecordAsync();
        recorder.record();
      } catch {
        flashToast('Could not start recording', 'error');
      }
    })();
  }, [recorder, disposePlayer, flashToast]);

  const cancelDiscardAndRecord = useCallback(() => {
    setPendingConfirm(null);
  }, []);

  const togglePlayPause = useCallback(() => {
    if (!take) return;
    let p = playerRef.current;
    if (!p) p = ensurePlayer(take.uri);
    if (!p) {
      flashToast('Could not load take for playback', 'error');
      return;
    }
    try {
      if (playing) {
        p.pause();
        setPlaying(false);
      } else {
        // If we ran off the end last time, rewind to 0 first.
        if (playDur > 0 && p.currentTime >= playDur - 0.05) {
          p.seekTo(0).catch(() => {});
        }
        p.play();
        setPlaying(true);
      }
    } catch {
      flashToast('Playback control failed', 'error');
    }
  }, [take, ensurePlayer, playing, playDur, flashToast]);

  const scrubTo = useCallback((frac: number) => {
    if (!take) return;
    let p = playerRef.current;
    if (!p) p = ensurePlayer(take.uri);
    if (!p) return;
    const dur = playDur > 0 ? playDur : take.durationSec;
    if (dur <= 0) return;
    const sec = Math.max(0, Math.min(dur, frac * dur));
    p.seekTo(sec).catch(() => {});
    setPlayPos(sec);
  }, [take, ensurePlayer, playDur]);

  const clearTake = useCallback(() => {
    disposePlayer();
    setTake(null);
  }, [disposePlayer]);

  // v1.0 — confirm gate for CLEAR. We don't track a "saved to disk" flag on
  // the take (Save copies but the in-memory take stays), so confirm always.
  const requestClearTake = useCallback(() => {
    if (!take) return;
    setPendingConfirm('clear-take');
  }, [take]);

  const confirmClearTake = useCallback(() => {
    setPendingConfirm(null);
    disposePlayer();
    setTake(null);
  }, [disposePlayer]);

  const cancelClearTake = useCallback(() => {
    setPendingConfirm(null);
  }, []);

  const saveTake = useCallback(async () => {
    if (!take) return;
    try {
      // v1.0.1 — `Directory.create()` requires the new top-level expo-file-system
      // API (v56+); do NOT swap this import for `expo-file-system/legacy` — the
      // legacy module has no Directory class and this would silently break save.
      const dir = new Directory(Paths.document, SAVED_DIRNAME);
      if (!dir.exists) dir.create();
      const ts = take.capturedAtMs;
      const src = new File(take.uri);
      // Mirror the recorder's extension so the saved file plays back natively
      // (HIGH_QUALITY = .m4a on Android, AAC inside; .m4a covers it).
      const ext = (() => {
        const m = take.uri.match(/\.([a-z0-9]+)$/i);
        return m ? `.${m[1].toLowerCase()}` : '.m4a';
      })();
      const dest = new File(dir, `recording-${ts}${ext}`);
      if (dest.exists) dest.delete();
      // expo-file-system copy: source file → destination file. async variant
      // so errors surface cleanly.
      await src.copy(dest);
      flashToast(`Saved to BellCurve Recordings. Tap SHARE to send it elsewhere.`, 'ok');
    } catch {
      flashToast('Save failed', 'error');
    }
  }, [take, flashToast]);

  // ---------- lifecycle ----------

  // Background → stop recording. Don't auto-resume; user must hit RECORD
  // again. (Background recording would need a foreground service we don't
  // ship.) v1.0 — actually PRESERVE the take if there's one in flight:
  // await the stop, capture the URI + duration, and write it into state so
  // returning to the foreground finds the take ready for review/save.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        if (recState.isRecording) {
          (async () => {
            // v1.0.1 BUG-5 — race-guard. If a foreground stopRecord (or the
            // 5-min cap) was already mid-flight, bail; whichever finishes
            // first owns the take, no clobber.
            if (recordingClosingRef.current) return;
            recordingClosingRef.current = true;
            try {
              try {
                await recorder.stop();
              } catch {
                // If stop itself blew up there's nothing to salvage.
                return;
              }
              // v1.0.1 BUG-5 — capture URI + duration AFTER stop resolves
              // (mirrors stopRecord). Old code snapshotted durSec pre-stop
              // which could be stale by tens of ms.
              const uri = recorder.uri;
              if (!uri) return;
              const durSec = (recState.durationMillis ?? 0) / 1000;
              if (durSec < MIN_VALID_TAKE_SEC) return; // drop orphan silently
              disposePlayer();
              setTake({
                uri,
                durationSec: durSec,
                capturedAtMs: Date.now(),
              });
            } finally {
              recordingClosingRef.current = false;
            }
          })();
        }
        const p = playerRef.current;
        if (p && playing) {
          try { p.pause(); } catch { /* ignore */ }
          setPlaying(false);
        }
      }
    });
    return () => sub.remove();
  }, [recorder, recState.isRecording, recState.durationMillis, playing, disposePlayer]);

  useEffect(() => {
    return () => disposePlayer();
  }, [disposePlayer]);

  // v1.3.4 B8 — clear all pending toast timers on unmount so no setState
  // fires into a dead component.
  useEffect(() => {
    return () => {
      for (const t of toastTimersRef.current) clearTimeout(t);
      toastTimersRef.current.clear();
    };
  }, []);

  // Derive overall mode.
  let mode: DeckMode = 'idle';
  if (recState.isRecording) mode = 'recording';
  else if (take && playing) mode = 'playing';
  else if (take) mode = 'have-take';

  const recordingSeconds = mode === 'recording'
    ? Math.floor((recState.durationMillis ?? 0) / 1000)
    : 0;

  // v1.2 hotfix — memoise the returned object so App.tsx's consumers don't
  // see a fresh `deck` reference on every render. `mode` + `recordingSeconds`
  // are derived locally each render; including them in deps is sufficient
  // because they're scalars computed from the same source state.
  return useMemo<DeckState>(() => ({
    mode,
    recordingSeconds,
    take,
    playPos,
    playDur,
    pendingConfirm,
    toast,
    startRecord,
    stopRecord,
    togglePlayPause,
    scrubTo,
    clearTake,
    saveTake,
    confirmDiscardAndRecord,
    cancelDiscardAndRecord,
    requestClearTake,
    confirmClearTake,
    cancelClearTake,
  }), [
    mode,
    recordingSeconds,
    take,
    playPos,
    playDur,
    pendingConfirm,
    toast,
    startRecord,
    stopRecord,
    togglePlayPause,
    scrubTo,
    clearTake,
    saveTake,
    confirmDiscardAndRecord,
    cancelDiscardAndRecord,
    requestClearTake,
    confirmClearTake,
    cancelClearTake,
  ]);
}
