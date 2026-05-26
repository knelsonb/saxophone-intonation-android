import AsyncStorage from '@react-native-async-storage/async-storage';

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
  hiFiMode: true,
  audioSampleRate: 48000,
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
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
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
