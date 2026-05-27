import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ThemeName } from '../theme';
import type { DroneVoice } from '../audioGen';

const PREFS_KEY = '@intonation/prefs';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface AppPrefs {
  instrumentKey: string;
  nickname: string;
  a4Hz: number;
  lang: 'en' | 'de';
  displayMode: 'griff' | 'klingend';
  filterMode: 'fast' | 'normal' | 'slow';
  minNVisible: number;
  gainMode: 'low' | 'high';
  // refHz mirrors a4Hz for cross-sync compatibility with the desktop schema.
  // Both fields are kept in sync on every save. App.tsx owns the live refHz
  // state; the engine writes both fields when persisting so the desktop can
  // read either key without migration logic.
  refHz: number;
  allowOutOfRange: boolean;
  // v0.6.0 audio source prefs.
  // hiFiMode: true = prefer raw-audio-input module (UNPROCESSED / VOICE_RECOGNITION).
  // false = use expo-audio (safe fallback for devices where raw capture fails).
  // Default true — the engine's capability check overrides on first launch if
  // UNPROCESSED is not supported.
  hiFiMode: boolean;
  // audioSampleRate: the sample rate to request from the raw-audio-input module.
  // Stored so the user's choice survives restarts. The native side may negotiate
  // down from this value; the actual rate is available from stream.sampleRate.
  audioSampleRate: number;
  // v0.6.4 peak-lock override.
  // peakLock: when true, the pitch readout bypasses the filter's per-mode
  // confidence gate and shows the most recent YIN result directly (EMA-
  // smoothed). Useful on Android UNPROCESSED captures where the mic gain
  // is lower than the desktop's tuned-for and the filter rejects valid
  // notes as "not tonal enough."
  peakLock: boolean;
  // User-controlled noise gate in dBFS. The engine takes max(preset floor,
  // user floor) so the per-mode RMS floor stays as a sensible minimum but
  // the user can raise the gate (e.g. -30 dB for a noisy room). Range
  // [-80, -10], default -45.
  lowCutDb: number;
  // v0.7.0 onboarding — false until the first-launch sequence completes.
  // The mount path checks this AFTER prefs hydrate; if any other pref shows
  // signs of prior use (e.g. nickname non-empty, instrumentKey != default),
  // the UI may also skip onboarding via heuristics, but this is the canonical
  // signal.
  firstLaunchComplete: boolean;
  // v0.7.0 session model — target window in cents for the "in-tune" arc band.
  // Reserved for the gear-sheet ±cents stepper. Range [1, 50], default 5.
  sessionTargetCents: number;
  // v0.7.0 settings sheet — when true, the bottom diagnostic line (YIN raw
  // freq, RMS, call counter) re-appears for debugging. Default off. Persisted
  // so power users don't have to flip it every launch.
  showDebugOverlay: boolean;
  // v0.8.0 theme picker — 'dark' (high-contrast amber on near-black, the
  // workhorse), 'night' (true AMOLED black with optional darken/warmth
  // filters), or 'light' (high-contrast light theme). Default 'dark'.
  theme: ThemeName;
  // v0.8.0 Night-only screen-darken multiplier. 1.0 = full brightness, lower
  // dims uniformly. Only applied when theme === 'night'. Range [0.4, 1.0].
  nightDarken: number;
  // v0.8.0 Night-only warmth tint. 0 = neutral, +1 = warm (red boost / blue
  // cut), -1 = cool (red cut / blue boost). Only applied when theme === 'night'.
  // Stored as a tenths integer (-10..10) for stable JSON serialization;
  // divided by 10 at the read site. Default 0.
  nightWarmth: number;
  // v0.9.0 TUNER STYLE — picks the visual on the TUNER screen.
  //   'arc'    — cents arc with needle + big note letter. Default.
  //   'strobe' — Peterson StroboPlus emulation. Bars scroll left (flat) or
  //              right (sharp); stationary when in tune.
  //   'led'    — Boss TU-3 / Korg TM-60 style 11-LED row.
  // Persisted so the user's preference survives launches.
  tunerStyle: 'arc' | 'strobe' | 'led';
  // v0.9.0 METRO STYLE — picks the visual on the METRO screen.
  //   'pulse' — Boss DB-90 dot row + downbeat accent. Default.
  //   'flash' — full-screen colour flash for back-of-room visibility.
  // (Pendulum visual is deferred for this release — see release notes.)
  metroStyle: 'pulse' | 'pendulum' | 'flash';
  // v0.9.0 DECK STYLE — picks the visual on the DECK screen.
  //   'reels' — twin reel-to-reel spools. Default.
  //   'waveform' — minimalist scope with playhead.
  // (VU-meter visual is deferred for this release — see release notes.)
  deckStyle: 'reels' | 'vu' | 'waveform';
  // v0.9.0 DRONE — sustained reference tone that tracks the user's detected
  // pitch ± a semitone offset. Tuner-screen-only.
  // droneVoice: timbre of the drone. 'cello' default — fundamental + 2x/3x/4x
  //             harmonics + 5 Hz vibrato. 'sine' is the pure fundamental.
  //             'saw' is a brighter band-limited sawtooth.
  droneVoice: DroneVoice;
  // droneVolume: 0..1 playback gain for the drone audio. Default 0.5.
  droneVolume: number;
  // droneSemitones: signed semitone offset added to the detected MIDI before
  // synthesizing the drone pitch. Range [-12, +12], integer. Default 0.
  droneSemitones: number;
}

export const DEFAULT_PREFS: AppPrefs = {
  instrumentKey: 'bb_tenor',
  nickname: '',
  a4Hz: 440,
  lang: 'en',
  displayMode: 'griff',
  filterMode: 'normal',
  minNVisible: 5,
  gainMode: 'low',
  refHz: 440,
  allowOutOfRange: true,
  // v0.6.2: default false. First-launch users get the proven expo-audio path.
  // Hi-fi is opt-in via the BottomStrip toggle until the raw-audio-input
  // module is confirmed working on Tom's hardware — v0.6.1 froze on first
  // launch when hiFiMode defaulted true (engine stuck in 'warming-up').
  hiFiMode: false,
  audioSampleRate: 48000,
  // Default ON — Android mic gain on UNPROCESSED is well below what the
  // desktop's filter presets are tuned for. The filter's confidence gate
  // rejects valid notes; PEAK bypasses it so the tuner actually displays.
  peakLock: true,
  lowCutDb: -45,
  firstLaunchComplete: false,
  sessionTargetCents: 5,
  showDebugOverlay: false,
  theme: 'dark',
  nightDarken: 1.0,
  nightWarmth: 0,
  droneVoice: 'cello',
  droneVolume: 0.5,
  droneSemitones: 0,
  tunerStyle: 'arc',
  metroStyle: 'pulse',
  deckStyle: 'reels',
};

// ---------------------------------------------------------------------------
// Tolerant coercion — mirrors sax_config.py _as_bool / _as_int / _as_str.
// A bad persisted value silently falls back to the supplied default rather
// than crashing the UI on startup.
// ---------------------------------------------------------------------------

function asBool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === '') return false;
  }
  return def;
}

function asInt(v: unknown, def: number): number {
  // Number(null) === 0 and Number(undefined) === NaN — neither should clamp
  // to A4_MIN. Guard before coercion so a corrupted/empty field falls back
  // to the supplied default.
  if (v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function asFloat(v: unknown, def: number, lo: number, hi: number): number {
  if (v == null) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

function asStr(v: unknown, def: string): string {
  if (v == null) return def;
  try {
    return String(v);
  } catch {
    return def;
  }
}

function asOneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  const s = asStr(v, def);
  return (allowed as readonly string[]).includes(s) ? (s as T) : def;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

export async function loadPrefs(): Promise<AppPrefs> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    if (raw == null) return { ...DEFAULT_PREFS };
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_PREFS };
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { ...DEFAULT_PREFS };
    }
    const d = data as Record<string, unknown>;
    const a4Hz = Math.max(430, Math.min(450, asInt(d.a4Hz, DEFAULT_PREFS.a4Hz)));
    const refHz = Math.max(430, Math.min(450, asInt(d.refHz ?? d.a4Hz, DEFAULT_PREFS.refHz)));
    return {
      instrumentKey: asStr(d.instrumentKey, DEFAULT_PREFS.instrumentKey),
      nickname:      asStr(d.nickname,      DEFAULT_PREFS.nickname),
      a4Hz,
      lang:          asOneOf(d.lang,        ['en', 'de'] as const,                DEFAULT_PREFS.lang),
      displayMode:   asOneOf(d.displayMode, ['griff', 'klingend'] as const,       DEFAULT_PREFS.displayMode),
      filterMode:    asOneOf(d.filterMode,  ['fast', 'normal', 'slow'] as const,  DEFAULT_PREFS.filterMode),
      minNVisible:   Math.max(0, Math.min(100, asInt(d.minNVisible, DEFAULT_PREFS.minNVisible))),
      gainMode:      asOneOf(d.gainMode,    ['low', 'high'] as const,             DEFAULT_PREFS.gainMode),
      refHz,
      allowOutOfRange: asBool(d.allowOutOfRange, DEFAULT_PREFS.allowOutOfRange),
      hiFiMode:        asBool(d.hiFiMode, DEFAULT_PREFS.hiFiMode),
      audioSampleRate: Math.max(8000, Math.min(96000, asInt(d.audioSampleRate, DEFAULT_PREFS.audioSampleRate))),
      peakLock:        asBool(d.peakLock, DEFAULT_PREFS.peakLock),
      lowCutDb:        Math.max(-80, Math.min(-10, asInt(d.lowCutDb, DEFAULT_PREFS.lowCutDb))),
      firstLaunchComplete: asBool(d.firstLaunchComplete, DEFAULT_PREFS.firstLaunchComplete),
      sessionTargetCents:  Math.max(1, Math.min(50, asInt(d.sessionTargetCents, DEFAULT_PREFS.sessionTargetCents))),
      showDebugOverlay:    asBool(d.showDebugOverlay, DEFAULT_PREFS.showDebugOverlay),
      theme:               asOneOf(d.theme, ['dark', 'night', 'light'] as const, DEFAULT_PREFS.theme),
      nightDarken:         asFloat(d.nightDarken, DEFAULT_PREFS.nightDarken, 0.4, 1.0),
      nightWarmth:         asFloat(d.nightWarmth, DEFAULT_PREFS.nightWarmth, -1.0, 1.0),
      droneVoice:          asOneOf(d.droneVoice, ['cello', 'sine', 'saw'] as const, DEFAULT_PREFS.droneVoice),
      droneVolume:         asFloat(d.droneVolume, DEFAULT_PREFS.droneVolume, 0.0, 1.0),
      droneSemitones:      Math.max(-12, Math.min(12, asInt(d.droneSemitones, DEFAULT_PREFS.droneSemitones))),
      tunerStyle:          asOneOf(d.tunerStyle, ['arc', 'strobe', 'led'] as const, DEFAULT_PREFS.tunerStyle),
      metroStyle:          asOneOf(d.metroStyle, ['pulse', 'pendulum', 'flash'] as const, DEFAULT_PREFS.metroStyle),
      deckStyle:           asOneOf(d.deckStyle, ['reels', 'vu', 'waveform'] as const, DEFAULT_PREFS.deckStyle),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function savePrefs(p: AppPrefs): Promise<void> {
  try {
    // Keep a4Hz and refHz in sync so the desktop can read either field.
    const blob: AppPrefs = { ...p, refHz: p.a4Hz };
    await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(blob));
  } catch {
    // Best-effort. AsyncStorage errors must never reach the UI.
  }
}
