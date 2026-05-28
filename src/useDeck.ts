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
import { log } from './log';
import {
  useAudioRecorder,
  useAudioRecorderState,
  createAudioPlayer,
  RecordingPresets,
} from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import type { MidiBusState } from './useMidiBusCore';

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

export interface UseDeckArgs {
  /**
   * v1.4 wave-5 T2 — bus reference so useDeck can mute the synth master
   * BEFORE recorder.record() starts capture (eliminates the 0-200 ms drone/synth
   * bleed that the prior useEffect-based mute path allowed).
   */
  bus: MidiBusState;
}

export function useDeck({ bus }: UseDeckArgs): DeckState {
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
  // v1.4 wave-10 T1 — ref so the AppState listener always reads the freshest
  // durationMillis without being listed as a dep (which caused listener
  // re-creation on every 200 ms recorder poll and introduced ~200 ms staleness).
  const durationMillisRef = useRef<number | undefined>(undefined);
  const toastIdRef = useRef(0);
  // v1.3.4 B8 — track pending toast timers so unmount can clear them and
  // avoid setState-on-unmounted-component warnings.
  const toastTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // v1.4 wave-10 T2 — duration split: errors stay up 5000 ms so users can
  // actually read them; success toasts keep the original 2500 ms.
  const flashToast = useCallback((text: string, kind: 'ok' | 'error') => {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToast({ text, kind, id });
    const durationMs = kind === 'error' ? 5000 : 2500;
    const t = setTimeout(() => {
      toastTimersRef.current.delete(t);
      setToast((prev) => (prev && prev.id === id ? null : prev));
    }, durationMs);
    toastTimersRef.current.add(t);
  }, []);

  // v1.4 wave-10 T1 — keep the ref in sync every render so the AppState
  // background listener always reads a fresh durationMillis value at fire-time.
  useEffect(() => { durationMillisRef.current = recState.durationMillis; }, [recState.durationMillis]);

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
          // v1.4 wave-6 T3 — unmute after auto-stop so mute doesn't persist
          // for the remainder of the session (prior code left it silenced).
          try { bus.setMasterMute(false); } catch { /* ignore */ }
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
    // v1.4 closeout — bail if a prior stopRecord is still draining so we don't
    // start a new capture alongside the one that's still closing.
    if (recordingClosingRef.current) {
      flashToast('Wait — finishing previous take', 'error');
      return;
    }
    if (take !== null) {
      // Confirm before overwriting an unsaved take.
      setPendingConfirm('discard-and-record');
      return;
    }
    (async () => {
      try {
        // v1.4 wave-5 T2 — mute BEFORE capture starts. The useEffect in
        // App.tsx fires after React reconciliation (0-200 ms later); by then
        // the recorder is already capturing and synth/drone sound bleeds in.
        // Imperative call here eliminates that window entirely.
        bus.setMasterMute(true);
        await recorder.prepareToRecordAsync();
        recorder.record();
      } catch (e) {
        // v1.4 wave-6 T1 — unmute on error so mute doesn't leak when
        // prepareToRecordAsync or record() throws before recording started.
        try { bus.setMasterMute(false); } catch { /* ignore */ }
        flashToast('Could not start recording', 'error');
      }
    })();
  }, [recorder, take, flashToast, bus]);

  const stopRecord = useCallback(async () => {
    // v1.0.1 BUG-5 — race-guard against AppState background / 5-min cap that
    // may already be closing the recording. Whichever path fires first wins.
    if (recordingClosingRef.current) return;
    recordingClosingRef.current = true;
    try {
      try {
        await recorder.stop();
      } catch {
        // v1.4 wave-10 T4 — inform the user so they know the take may be
        // incomplete; suggest DECK CLEAR as a recovery path. Does NOT crash
        // or propagate — the rest of the stop path runs normally.
        flashToast('Stop failed — recording may be incomplete (try DECK CLEAR)', 'error');
      }
      // v1.4 wave-5 T2 — unmute AFTER stop resolves so no synth tail leaks
      // into the tail of the take. The useEffect in App.tsx will also fire
      // on the next reconciler pass but this imperative call is immediate.
      // v1.4 wave-7 — guarded so a bus throw can't strand both the mute AND
      // recordingClosingRef (the finally below was unreachable on a thrown
      // setMasterMute, blocking all future record starts).
      try { bus.setMasterMute(false); } catch { /* ignore */ }
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
  }, [recorder, recState.durationMillis, disposePlayer, flashToast, bus]);

  const confirmDiscardAndRecord = useCallback(() => {
    // v1.4 closeout — same in-flight-close guard as startRecord.
    if (recordingClosingRef.current) {
      flashToast('Wait — finishing previous take', 'error');
      return;
    }
    setPendingConfirm(null);
    disposePlayer();
    setTake(null);
    (async () => {
      try {
        // v1.4 wave-5 T2 — same imperative mute guard as startRecord.
        bus.setMasterMute(true);
        await recorder.prepareToRecordAsync();
        recorder.record();
      } catch {
        // v1.4 wave-6 T2 — unmute on error; mirrors T1 fix in startRecord.
        try { bus.setMasterMute(false); } catch { /* ignore */ }
        flashToast('Could not start recording', 'error');
      }
    })();
  }, [recorder, disposePlayer, flashToast, bus]);

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
      // v1.4 wave-4 — await dir.create() so the directory exists before we
      // attempt to create a File inside it (prevents save failure on first run).
      if (!dir.exists) {
        try {
          await dir.create();
        } catch (e) {
          log.e('Deck', 'saveTake: dir.create() failed', e);
          flashToast('Save failed — could not create recordings folder', 'error');
          return;
        }
      }
      const ts = take.capturedAtMs;
      const src = new File(take.uri);
      // Mirror the recorder's extension so the saved file plays back natively
      // (HIGH_QUALITY = .m4a on Android, AAC inside; .m4a covers it).
      const ext = (() => {
        const m = take.uri.match(/\.([a-z0-9]+)$/i);
        return m ? `.${m[1].toLowerCase()}` : '.m4a';
      })();
      const dest = new File(dir, `recording-${ts}${ext}`);
      // v1.4 wave-4 — await dest.delete() so the file is gone before we copy
      // into its slot (prevents copy failure or stale-file collision).
      if (dest.exists) {
        try {
          await dest.delete();
        } catch (e) {
          log.e('Deck', 'saveTake: dest.delete() failed', e);
          flashToast('Save failed — could not overwrite existing recording', 'error');
          return;
        }
      }
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
                // v1.4 wave-6 T4 — still unmute so mute doesn't leak even
                // when the stop call itself throws.
                try { bus.setMasterMute(false); } catch { /* ignore */ }
                return;
              }
              // v1.4 wave-6 T4 — unmute after background-forced stop so mute
              // doesn't persist when the user returns to the foreground.
              try { bus.setMasterMute(false); } catch { /* ignore */ }
              // v1.0.1 BUG-5 — capture URI + duration AFTER stop resolves
              // (mirrors stopRecord). Old code snapshotted durSec pre-stop
              // which could be stale by tens of ms.
              // v1.4 wave-10 T1 — read via ref so the listener is not re-created
              // on every 200 ms recorder poll (recState.durationMillis is NOT in
              // this effect's deps; the ref is always current at fire-time).
              const uri = recorder.uri;
              if (!uri) return;
              const durSec = (durationMillisRef.current ?? 0) / 1000;
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
  // v1.4 wave-10 T1 — recState.durationMillis removed from deps; the ref
  // (durationMillisRef) is always current so the listener never reads stale
  // duration and is not re-created on every 200 ms recorder poll.
  }, [recorder, recState.isRecording, playing, disposePlayer]);

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
