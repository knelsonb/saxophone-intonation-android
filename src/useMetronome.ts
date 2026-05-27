/**
 * useMetronome — state machine + tick scheduler for the METRO tab.
 *
 * Design goals:
 *   1. **Wall-clock scheduling**, not relative `setInterval` — drift compounds
 *      otherwise. The next beat's target time is computed from `startedAtMs`
 *      plus `(beatIndex * 60000 / bpm)`. setTimeout fires close to the target
 *      and we apply the click then; if the timer was late we still advance to
 *      the correct beat index.
 *   2. **Visual + audio in sync** (v0.9.1 calibration).
 *      The visible beat indicator runs on the UI thread via Animated with
 *      `useNativeDriver: true`, so the click no longer waits on a JS render
 *      to land. To compensate for downstream audio-output latency the click
 *      is fired EARLIER than the visual peak by a per-route base offset
 *      (speaker 25 ms / wired 5 ms / Bluetooth 200 ms) PLUS a user-tunable
 *      `metroClickOffsetMs` step from SETUP. Negative offset = click earlier.
 *   3. **Tap tempo**. Each tap records `Date.now()`. We take the running
 *      average of the last 4 inter-tap intervals. Resets if no tap in 2 s.
 *   4. **Lifecycle**. AppState 'background' stops the click immediately and
 *      remembers the previous run state so it can resume when the user
 *      returns.
 *
 * Audio path: two short percussive WAV blobs (one `accent`, one `normal`),
 * written once to the cache directory and replayed via `expo-audio`'s
 * `createAudioPlayer`. Each beat seeks back to 0 and calls `play()` — the
 * cost is small relative to the 500 ms gap between beats at 120 BPM.
 *
 * VERIFICATION: hand-tune `metroClickOffsetMs` by recording the device
 * speaker + screen with another phone's 240fps slow-mo camera. Step through
 * frame-by-frame, count frames between the visual flash peak and the
 * loudest sample of the click waveform. ≤2 frames at 240fps = ≤8 ms = pass.
 * On a Pixel 9 Pro, speaker default of −25 ms typically lands inside that
 * window; user can nudge ±5 ms from SETUP if the room or output route
 * changes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { createAudioPlayer } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import { buildClickWavBase64 } from './audioGen';

export type TimeSig = '2/4' | '3/4' | '4/4' | '6/8';

const TIME_SIG_BEATS: Record<TimeSig, number> = {
  '2/4': 2,
  '3/4': 3,
  '4/4': 4,
  '6/8': 6,
};

export const BPM_MIN = 30;
export const BPM_MAX = 300;
export const BPM_DEFAULT = 100;

const TAP_RESET_MS = 2000;
const TAP_WINDOW = 4;

export type MetroOutputRoute = 'speaker' | 'wired' | 'bluetooth';

// Per-route base latency offsets (ms) — subtracted from the scheduled click
// time so the audio arrives at the user's ear at the same wall-clock moment
// as the visual peak. Speaker is the workhorse default; wired is the cleanest
// path; Bluetooth A2DP buffering is generally awful and we surface a warning
// on the METRO screen.
const ROUTE_LATENCY_MS: Record<MetroOutputRoute, number> = {
  speaker:   25,
  wired:     5,
  bluetooth: 200,
};

export function routeLatencyMs(route: MetroOutputRoute): number {
  return ROUTE_LATENCY_MS[route] ?? 25;
}

export interface MetronomeState {
  bpm: number;
  setBpm: (n: number) => void;
  bumpBpm: (delta: number) => void;
  timeSig: TimeSig;
  setTimeSig: (s: TimeSig) => void;
  running: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  /** Tap-tempo. Returns the new BPM if it changed, or null on first tap. */
  registerTap: () => number | null;
  /**
   * 1-based index of the current beat within the current bar. Reset to 1 on
   * each `start()`. While running, ticks up on every beat tied to the
   * indicator pulse.
   */
  beat: number;
  /**
   * Pulse counter — increments once per beat. Lets the UI re-render on every
   * beat (different state value each time) so a flash animation can drive
   * off it without relying on object-equality checks.
   */
  pulse: number;
}

function clampBpm(n: number): number {
  if (!Number.isFinite(n)) return BPM_DEFAULT;
  return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(n)));
}

export interface UseMetronomeArgs {
  /** User-tunable click offset in ms. Stacks on route latency. */
  clickOffsetMs: number;
  /** Selected output route — drives the base latency offset. */
  outputRoute: MetroOutputRoute;
}

export function useMetronome(args: UseMetronomeArgs = { clickOffsetMs: 0, outputRoute: 'speaker' }): MetronomeState {
  const { clickOffsetMs, outputRoute } = args;
  const [bpm, setBpmState] = useState<number>(BPM_DEFAULT);
  const [timeSig, setTimeSigState] = useState<TimeSig>('4/4');
  const [running, setRunning] = useState<boolean>(false);
  const [beat, setBeat] = useState<number>(1);
  const [pulse, setPulse] = useState<number>(0);

  // Refs that the scheduler reads without rebinding the callback.
  const bpmRef = useRef(BPM_DEFAULT);
  bpmRef.current = bpm;
  const sigRef = useRef<TimeSig>('4/4');
  sigRef.current = timeSig;
  const runningRef = useRef(false);
  runningRef.current = running;
  // Calibration refs — refreshed every render so live changes from SETUP
  // take effect on the next beat without a restart.
  const clickOffsetRef = useRef(clickOffsetMs);
  clickOffsetRef.current = clickOffsetMs;
  const outputRouteRef = useRef<MetroOutputRoute>(outputRoute);
  outputRouteRef.current = outputRoute;

  // Players (one per click kind), populated on first start.
  const accentPlayerRef = useRef<AudioPlayer | null>(null);
  const normalPlayerRef = useRef<AudioPlayer | null>(null);
  // Index of the next beat we will fire (0-based within an "ever-running"
  // counter; modulo time-sig beats gives the bar position). Reset to 0 on
  // each start().
  const nextBeatIndexRef = useRef(0);
  const startedAtMsRef = useRef(0);
  // Visual timer fires at the wall-clock target; click timer fires earlier
  // by (routeLatency - clickOffsetMs) so the audio output lands on the
  // visual peak. Both are tracked so stop()/restart can clear cleanly.
  const visualTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Back-compat alias — older code paths may reference timeoutRef. */
  const timeoutRef = visualTimeoutRef;

  // ---------- click player provisioning ----------

  const ensurePlayers = useCallback(() => {
    try {
      if (!accentPlayerRef.current) {
        const b64 = buildClickWavBase64('accent');
        const f = new File(Paths.cache, 'metro_accent.wav');
        if (f.exists) f.delete();
        f.create();
        f.write(b64, { encoding: 'base64' });
        accentPlayerRef.current = createAudioPlayer({ uri: f.uri });
        accentPlayerRef.current.loop = false;
      }
      if (!normalPlayerRef.current) {
        const b64 = buildClickWavBase64('normal');
        const f = new File(Paths.cache, 'metro_normal.wav');
        if (f.exists) f.delete();
        f.create();
        f.write(b64, { encoding: 'base64' });
        normalPlayerRef.current = createAudioPlayer({ uri: f.uri });
        normalPlayerRef.current.loop = false;
      }
    } catch {
      // Provisioning audio failed — the metronome still works visually. The
      // user gets the pulse + beat counter without sound.
    }
  }, []);

  // ---------- scheduling ----------

  const schedule = useCallback(() => {
    if (!runningRef.current) return;
    const bpmNow = bpmRef.current;
    const beatsPerBar = TIME_SIG_BEATS[sigRef.current];
    const intervalMs = 60000 / bpmNow;
    const i = nextBeatIndexRef.current;
    const targetMs = startedAtMsRef.current + i * intervalMs;
    const now = Date.now();

    // Click lead time. routeLatency is positive — the click must precede the
    // visual by that many ms so audio output lands on time. The user-tunable
    // clickOffsetMs is SIGNED-ADDED to the click target: negative = even
    // earlier. So clickFireAt = targetMs - routeLatency + clickOffsetMs.
    //
    // Edge case: at very fast BPM with Bluetooth + large negative offset, the
    // click for beat N could need to fire BEFORE beat N-1's visual. The
    // skip-if-too-late guard below drops the click silently rather than
    // playing it overlapped. Band-directors at 300 BPM should pick wired or
    // speaker output anyway.
    const routeLat = routeLatencyMs(outputRouteRef.current);
    const clickFireAt = targetMs - routeLat + clickOffsetRef.current;

    const visualDelay = Math.max(0, targetMs - now);
    const clickDelay = Math.max(0, clickFireAt - now);

    const beatInBar = (i % beatsPerBar) + 1;
    const isAccent = beatInBar === 1;

    // Audio click — fire at clickFireAt. If clickFireAt has already passed
    // (e.g. user just bumped offset huge negative, or BPM raced past) we
    // fire immediately. Skip entirely if it sits in the past by more than
    // half a beat, which means we're already in the next beat's window.
    if (now - clickFireAt < intervalMs * 0.5) {
      clickTimeoutRef.current = setTimeout(() => {
        if (!runningRef.current) return;
        const player = isAccent ? accentPlayerRef.current : normalPlayerRef.current;
        if (player) {
          try {
            player.seekTo(0).catch(() => {});
            player.play();
          } catch {
            // Best-effort. Skipped clicks shouldn't crash the loop.
          }
        }
      }, clickDelay);
    }

    // Visual peak — fires at targetMs. Bumps `beat` + `pulse` together so
    // the UI's Animated value (driven by `pulse`) flashes in lockstep with
    // the beat number change. Both setStates land in the same React batch.
    visualTimeoutRef.current = setTimeout(() => {
      if (!runningRef.current) return;
      setBeat(beatInBar);
      setPulse((p) => p + 1);
      nextBeatIndexRef.current = i + 1;
      // Schedule the next beat. Recursion via setTimeout keeps wall-clock
      // alignment — drift accumulates only from setTimeout's own latency,
      // not from compounding interval errors.
      schedule();
    }, visualDelay);
  }, []);

  // Helper used by start/stop/setBpm/setTimeSig to clear both timers.
  const clearScheduleTimers = useCallback(() => {
    if (visualTimeoutRef.current !== null) {
      clearTimeout(visualTimeoutRef.current);
      visualTimeoutRef.current = null;
    }
    if (clickTimeoutRef.current !== null) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (runningRef.current) return;
    ensurePlayers();
    runningRef.current = true;
    startedAtMsRef.current = Date.now();
    nextBeatIndexRef.current = 0;
    setRunning(true);
    setBeat(1);
    schedule();
  }, [ensurePlayers, schedule]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    clearScheduleTimers();
  }, [clearScheduleTimers]);

  const toggle = useCallback(() => {
    if (runningRef.current) stop(); else start();
  }, [start, stop]);

  // BPM setter — clamp + re-anchor wall-clock so the new tempo takes effect
  // on the NEXT beat rather than the current scheduled one. Done by resetting
  // startedAtMs to "now - (i * old interval was fired)". Easier: just reset
  // startedAtMs to now and beat-index to 0. The audible result: the next
  // beat lands one beat into the new tempo, which is what the player expects.
  const setBpm = useCallback((n: number) => {
    const next = clampBpm(n);
    setBpmState(next);
    if (runningRef.current) {
      // Re-anchor.
      startedAtMsRef.current = Date.now();
      nextBeatIndexRef.current = 0;
      clearScheduleTimers();
      schedule();
    }
  }, [schedule, clearScheduleTimers]);

  const bumpBpm = useCallback((delta: number) => {
    setBpm(bpmRef.current + delta);
  }, [setBpm]);

  const setTimeSig = useCallback((s: TimeSig) => {
    setTimeSigState(s);
    // Resetting the in-bar beat counter immediately gives the visual feedback
    // a clean state — the next downbeat will land on the new "1".
    if (runningRef.current) {
      // Re-anchor so the new bar starts on the next click.
      startedAtMsRef.current = Date.now();
      nextBeatIndexRef.current = 0;
      clearScheduleTimers();
      schedule();
    }
    setBeat(1);
  }, [schedule, clearScheduleTimers]);

  // ---------- tap tempo ----------

  const tapHistoryRef = useRef<number[]>([]);

  const registerTap = useCallback((): number | null => {
    const now = Date.now();
    const hist = tapHistoryRef.current;
    if (hist.length > 0 && now - hist[hist.length - 1] > TAP_RESET_MS) {
      // Stale window — start over from this tap.
      tapHistoryRef.current = [now];
      return null;
    }
    hist.push(now);
    while (hist.length > TAP_WINDOW + 1) hist.shift();
    if (hist.length < 2) return null;
    // Average of inter-tap intervals across the kept window.
    let totalMs = 0;
    for (let i = 1; i < hist.length; i++) totalMs += hist[i] - hist[i - 1];
    const avg = totalMs / (hist.length - 1);
    if (avg <= 0) return null;
    const bpmNew = clampBpm(60000 / avg);
    setBpm(bpmNew);
    return bpmNew;
  }, [setBpm]);

  // ---------- lifecycle ----------

  // Pause when the app goes to background, resume on return.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        wasRunningRef.current = runningRef.current;
        if (runningRef.current) stop();
      } else if (nextState === 'active') {
        if (wasRunningRef.current) {
          wasRunningRef.current = false;
          start();
        }
      }
    });
    return () => sub.remove();
  }, [start, stop]);

  // Final teardown on unmount.
  useEffect(() => {
    return () => {
      runningRef.current = false;
      clearScheduleTimers();
      try { accentPlayerRef.current?.remove(); } catch { /* ignore */ }
      try { normalPlayerRef.current?.remove(); } catch { /* ignore */ }
      accentPlayerRef.current = null;
      normalPlayerRef.current = null;
    };
  // clearScheduleTimers is stable (useCallback []).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    bpm,
    setBpm,
    bumpBpm,
    timeSig,
    setTimeSig,
    running,
    start,
    stop,
    toggle,
    registerTap,
    beat,
    pulse,
  };
}
