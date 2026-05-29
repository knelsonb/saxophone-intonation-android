import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ThemeName } from '../theme';
import { log } from '../log';
// v1.1 — droneVoice is now a stable string id (DroneVoice.id from droneVoices.ts).
// The old union type 'cello' | 'sine' | 'saw' is gone. Resolution lives at the
// consumer site via resolveDroneVoice(id).
import { DRONE_DEFAULT_VOICE } from '../droneVoices';

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
  // v0.9.1 METRO CALIBRATION — manual fine-tune for visual+audio sync.
  // Range [-50, +50] ms, step 5, default 0. Negative pulls the click earlier
  // so it arrives at the user's ear at the same wall-clock moment as the
  // visual peak. Stacks on top of the per-route latency offset selected via
  // `metroOutputRoute` below.
  metroClickOffsetMs: number;
  // v0.9.1 METRO OUTPUT ROUTE — user-declared current audio output. The
  // metronome hook uses this to look up a sensible default latency offset:
  //   'speaker'   → 25 ms (typical Pixel 9 Pro internal speaker)
  //   'wired'     → 5  ms (3.5 mm / USB-C wired headset)
  //   'bluetooth' → 200 ms (typical BT A2DP; surface a warning on the screen)
  // Manual selection rather than auto-detection: expo-audio (SDK 56) does
  // not expose a stable current-output-route API. A native helper is on the
  // backlog; for now the user picks once in SETUP and forgets.
  metroOutputRoute: 'speaker' | 'wired' | 'bluetooth';
  // v1.1 METRO CLICK VOLUME — 0..1 playback gain applied to both the accent
  // and normal click WAVs. 0 = mute, 1 = full amplitude. Default 0.8.
  metroClickVolume: number;
  // v1.2 — TimeSig kind. 'preset' = use metroTimeSigPreset; 'custom' = use
  // metroCustomNumerator / metroCustomDenominator. Default 'preset' / '4/4'.
  metroTimeSigKind: 'preset' | 'custom';
  metroTimeSigPreset: '2/4' | '3/4' | '4/4' | '6/8';
  // v1.2 — last-used custom values, persisted independently of preset selection
  // so toggling between preset and CUSTOM never loses the user's custom value.
  // Numerator clamped to [1, 32]; denominator constrained to {2,4,8,16,32}.
  metroCustomNumerator: number;
  metroCustomDenominator: 2 | 4 | 8 | 16 | 32;
  // v1.2 — per-beat pattern, JSON-stringified BeatInstrument[]. Length must
  // match the current beatsPerBar at load time; on any deserialization
  // failure or schema mismatch (length, missing fields, midi out of 35..81),
  // silently reset to the default pattern (kick on 1, click on 2..N).
  // Stored as a string because AsyncStorage is fussier about nested objects.
  metroPatternJson: string;
  // v1.2 — subdivision mode. 'off' fires one click per beat (today's
  // behaviour); the others schedule extra sub-ticks per beat.
  metroSubdivisions: 'off' | '8th' | '16th' | 'triplet';
  // v1.2 — voice fired for every sub-tick. Single global voice per §15.Q11.3.
  // Default GM 42 (Closed Hi-Hat), velocity 70.
  metroSubdivisionVoiceMidi: number;
  metroSubdivisionVoiceVelocity: number;
  // v0.9.0 DRONE — sustained reference tone that tracks the user's detected
  // pitch ± a semitone offset. Tuner-screen-only.
  // v1.1 — droneVoice is the stable DroneVoice.id string (e.g. 'organ',
  // 'sax-tenor', 'gm-19'). Default 'organ'. Unknown ids fall back to default
  // at the consumer side via resolveDroneVoice(). Legacy union values
  // ('cello'|'sine'|'saw') are remapped in loadPrefs below.
  droneVoice: string;
  // droneVolume: 0..1 playback gain for the drone audio. Default 0.5.
  droneVolume: number;
  // droneSemitones: signed semitone offset added to the detected MIDI before
  // synthesizing the drone pitch. Range [-12, +12], integer. Default 0.
  droneSemitones: number;
  // v1.3 PIPES VOICE — GM program number 0..127 for the pitch-pipes channel
  // (channel role 'pipes' on the MIDI bus). Default 80 (Synth Lead Square)
  // per council decision U25 — a reference-tone-like timbre that's clearly
  // pitched and sustained. See docs/v1.3-council-decisions.md U25.
  pipesVoice: number;
  // v1.4 (Wave 3.5) — the 4 user metro profiles, JSON-stringified MetroProfile[]
  // (see loadMetroProfiles / validateProfile below for the exact schema). Owned
  // and persisted by useMetronome; the editor (MetroScreen) reads/writes them
  // through the hook. On any deserialization failure or schema mismatch the
  // hook falls back to its built-in default profiles (silent reset — never a
  // crash, never silent data loss for a VALID stored value). Stored as a string
  // because AsyncStorage is fussier about nested objects (matches metroPatternJson).
  metroProfilesJson: string;
  // v1.4 (Wave 3.5) — slot index (0-based) of the currently-loaded user profile,
  // or -1 when no profile is loaded (a preset is active). Persisted so the grid
  // can surface the loaded profile on relaunch.
  metroActiveProfileSlot: number;
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
  droneVoice: DRONE_DEFAULT_VOICE.id, // v1.1 — 'organ' (TSF Church Organ patch 19)
  droneVolume: 0.5,
  droneSemitones: 0,
  // v1.3 — Synth Lead Square (GM 80), per council U25.
  pipesVoice: 80,
  tunerStyle: 'arc',
  metroStyle: 'pulse',
  deckStyle: 'reels',
  metroClickOffsetMs: 0,
  metroOutputRoute: 'speaker',
  metroClickVolume: 0.8,
  // v1.2 — fresh install: 4/4 preset, default kick+click pattern is built by
  // useMetronome on mount from numerator (see metroPatternJson note below).
  metroTimeSigKind: 'preset',
  metroTimeSigPreset: '4/4',
  metroCustomNumerator: 5,
  metroCustomDenominator: 8,
  // Default 4-beat bar with a DISTINCT GM percussion voice per beat — kick(36)
  // on 1, snare(38) on 2, high tom(50) on 3, cowbell(56) on 4 — so each
  // position in the measure is audibly identifiable (pairs with the per-beat
  // pendulum-bob colour + numeral). The hook re-derives length from beatsPerBar
  // when the parsed length disagrees with the numerator, so this is only the
  // "remembered" pattern, not a binding declaration of length.
  metroPatternJson: JSON.stringify([
    { midi: 36, velocity: 110 },
    { midi: 38, velocity: 95 },
    { midi: 50, velocity: 95 },
    { midi: 56, velocity: 95 },
  ]),
  metroSubdivisions: 'off',
  metroSubdivisionVoiceMidi: 42,       // Closed Hi-Hat
  metroSubdivisionVoiceVelocity: 70,   // §15.Q11.9
  // v1.4 (Wave 3.5) — fresh install: no stored profiles (empty string →
  // loadMetroProfiles returns null → useMetronome seeds its built-in defaults)
  // and no active profile slot (-1).
  metroProfilesJson: '',
  metroActiveProfileSlot: -1,
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

// v1.2 — patternJson silent-reset guard (§15.Q3 acceptance criterion).
// AsyncStorage may have stale or corrupt JSON. We parse defensively and
// validate every element. On ANY failure path (bad JSON, non-array,
// missing fields, midi out of GM-drum range 35..81, velocity out of
// 1..127), return null so the caller falls back to the default pattern.
// The hook re-derives default pattern length on mount from beatsPerBar,
// so an empty-but-valid array also returns null (length mismatch is
// re-checked at the hook level after coercion of customNum / preset).
function coercePatternJson(v: unknown): { midi: number; velocity: number }[] | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const out: { midi: number; velocity: number }[] = [];
  for (const elem of parsed) {
    if (typeof elem !== 'object' || elem === null) return null;
    const rec = elem as Record<string, unknown>;
    const midi = Number(rec.midi);
    const velocity = Number(rec.velocity);
    if (!Number.isFinite(midi) || midi < 35 || midi > 81) return null;
    if (!Number.isFinite(velocity) || velocity < 1 || velocity > 127) return null;
    out.push({ midi: Math.trunc(midi), velocity: Math.trunc(velocity) });
  }
  return out;
}

// v1.1 — drone voice id migration. Pre-v1.1 prefs stored a closed union
// ('cello' | 'sine' | 'saw') for the WAV-synth drone. v1.1's TSF-backed drone
// keys voices by stable DroneVoice.id (open-ended string). Map legacy values
// to the closest TSF preset; pass through everything else (the consumer's
// resolveDroneVoice falls back to default for unknown ids).
function migrateDroneVoiceId(v: unknown, def: string): string {
  const s = asStr(v, def);
  if (s === 'sine' || s === 'saw') return 'organ'; // closest sustained tone
  return s; // 'cello' is a v1.1 preset id; gm-N + new preset ids pass through
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
      // v1.1 — droneVoice migration. Accept any persisted string id; resolution
      // (id → DroneVoice record) happens at the consumer via resolveDroneVoice.
      // Legacy union values ('cello'|'sine'|'saw') get a one-shot remap:
      //   cello → 'cello' (preset, same display label)
      //   sine  → 'organ' (closest available — clean sustained tone)
      //   saw   → 'organ' (clean fallback — old saw was a band-limited synth)
      droneVoice:          migrateDroneVoiceId(d.droneVoice, DEFAULT_PREFS.droneVoice),
      droneVolume:         asFloat(d.droneVolume, DEFAULT_PREFS.droneVolume, 0.0, 1.0),
      droneSemitones:      Math.max(-12, Math.min(12, asInt(d.droneSemitones, DEFAULT_PREFS.droneSemitones))),
      // v1.3 — GM patch 0..127. asInt clamps to integer; on any invalid value
      // (NaN, string non-numeric, missing) fall back to DEFAULT_PREFS.pipesVoice
      // (80 = Synth Lead Square per U25). Clamp to the valid GM patch range.
      pipesVoice:          Math.max(0, Math.min(127, asInt(d.pipesVoice, DEFAULT_PREFS.pipesVoice))),
      tunerStyle:          asOneOf(d.tunerStyle, ['arc', 'strobe', 'led'] as const, DEFAULT_PREFS.tunerStyle),
      metroStyle:          asOneOf(d.metroStyle, ['pulse', 'pendulum', 'flash'] as const, DEFAULT_PREFS.metroStyle),
      deckStyle:           asOneOf(d.deckStyle, ['reels', 'vu', 'waveform'] as const, DEFAULT_PREFS.deckStyle),
      metroClickOffsetMs:  Math.max(-50, Math.min(50, asInt(d.metroClickOffsetMs, DEFAULT_PREFS.metroClickOffsetMs))),
      metroOutputRoute:    asOneOf(d.metroOutputRoute, ['speaker', 'wired', 'bluetooth'] as const, DEFAULT_PREFS.metroOutputRoute),
      metroClickVolume:    asFloat(d.metroClickVolume, DEFAULT_PREFS.metroClickVolume, 0.0, 1.0),
      // v1.2 — time signature migration.
      //   Legacy: top-level `timeSig: '2/4'|'3/4'|'4/4'|'6/8'` string.
      //   New: split into `metroTimeSigKind` + `metroTimeSigPreset`
      //   (+ customNum/Den for kind === 'custom').
      // If the new kind field is missing but the legacy `timeSig` exists,
      // adopt it as the preset; otherwise default to '4/4' preset.
      metroTimeSigKind: asOneOf(
        d.metroTimeSigKind,
        ['preset', 'custom'] as const,
        DEFAULT_PREFS.metroTimeSigKind,
      ),
      metroTimeSigPreset: asOneOf(
        d.metroTimeSigPreset ?? d.timeSig,
        ['2/4', '3/4', '4/4', '6/8'] as const,
        DEFAULT_PREFS.metroTimeSigPreset,
      ),
      // Numerator [1, 32], denominator constrained to {2,4,8,16,32}.
      metroCustomNumerator: Math.max(1, Math.min(32, asInt(d.metroCustomNumerator, DEFAULT_PREFS.metroCustomNumerator))),
      metroCustomDenominator: ((): 2 | 4 | 8 | 16 | 32 => {
        const n = asInt(d.metroCustomDenominator, DEFAULT_PREFS.metroCustomDenominator);
        return (n === 2 || n === 4 || n === 8 || n === 16 || n === 32)
          ? (n as 2 | 4 | 8 | 16 | 32)
          : DEFAULT_PREFS.metroCustomDenominator;
      })(),
      // patternJson: silent reset on bad JSON / schema mismatch. We keep
      // the raw string in prefs (re-serializing it normalises shape but
      // also strips unknown keys, which is what we want).
      //
      // One-time upgrade: the legacy default was kick(36) + three identical
      // wood blocks(76). The new default gives each beat a distinct voice. If
      // a stored pattern is EXACTLY that old default we replace it with the new
      // one; any other (i.e. user-customised) pattern is left untouched.
      metroPatternJson: (() => {
        const coerced = coercePatternJson(d.metroPatternJson);
        if (!coerced) return DEFAULT_PREFS.metroPatternJson;
        const isLegacyDefault =
          coerced.length === 4 &&
          coerced[0].midi === 36 &&
          coerced[1].midi === 76 && coerced[2].midi === 76 && coerced[3].midi === 76;
        return isLegacyDefault ? DEFAULT_PREFS.metroPatternJson : JSON.stringify(coerced);
      })(),
      metroSubdivisions: asOneOf(
        d.metroSubdivisions,
        ['off', '8th', '16th', 'triplet'] as const,
        DEFAULT_PREFS.metroSubdivisions,
      ),
      metroSubdivisionVoiceMidi: Math.max(35, Math.min(81, asInt(d.metroSubdivisionVoiceMidi, DEFAULT_PREFS.metroSubdivisionVoiceMidi))),
      metroSubdivisionVoiceVelocity: Math.max(1, Math.min(127, asInt(d.metroSubdivisionVoiceVelocity, DEFAULT_PREFS.metroSubdivisionVoiceVelocity))),
      // v1.4 (Wave 3.5) — metro profiles. Round-trip through loadMetroProfiles
      // so a corrupt / legacy / wrong-shape value normalises to the default
      // empty string (useMetronome then seeds its built-in defaults) rather
      // than being passed through verbatim. A VALID stored value is re-
      // serialized in canonical form (strips unknown keys; same approach as
      // metroPatternJson above). This also keeps the field ALIVE across every
      // unrelated prefsUpdate()/savePrefs() cycle — loadPrefs rebuilds the
      // object field-by-field, so an unlisted key would be dropped on the next
      // write and the user's profiles would silently vanish.
      metroProfilesJson: (() => {
        const validated = loadMetroProfiles(d.metroProfilesJson);
        return validated ? JSON.stringify(validated) : DEFAULT_PREFS.metroProfilesJson;
      })(),
      // Active slot index (0-based) or -1 when no profile is loaded. asInt
      // tolerates a missing/corrupt value → default -1.
      metroActiveProfileSlot: asInt(d.metroActiveProfileSlot, DEFAULT_PREFS.metroActiveProfileSlot),
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

// ---------------------------------------------------------------------------
// prefs.update() — single debounced writer (G3, v1.3 council decision).
//
// Replaces the inline IIFE pattern (loadPrefs → savePrefs) that previously
// lived inside each setter in useAudioEngine. All per-field setters in the
// new hooks (useUiPrefsStore, useDronePrefs) call update() instead, which:
//
//   1. Merges `patch` into pendingSave in memory.
//   2. Resets a 250 ms debounce timer.
//   3. On fire: reads the current stored prefs once, merges pending, writes.
//   4. Returns void — callers do NOT await.
//
// This eliminates the read-modify-write race where two near-simultaneous
// setters each do a separate loadPrefs() and the second save clobbers
// fields from the first (see §4.3 of v1.3-state-machine-scrub.md).
//
// Module-level state: intentional — the debounce timer and pending patch
// outlive any single hook mount/unmount cycle. Only one timer is ever
// live at a time.
// ---------------------------------------------------------------------------

let _pendingPatch: Partial<AppPrefs> | null = null;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
// v1.4 — L2: serialise writes — at most one AsyncStorage RMW in flight.
// Debounce fire AND retry fire both check this before starting an async write.
// If true, the caller re-arms with a short delay (50 ms) and bails so the
// in-flight write completes first. Cleared in the finally block.
let _writeInFlight: boolean = false;
const DEBOUNCE_MS = 250;

/**
 * Write a partial update to AsyncStorage with 250 ms debounce.
 * Multiple calls within the window are coalesced (last value wins per field).
 * Returns void; never rejects (all errors are swallowed as best-effort).
 */
// v1.3.4 B10 — backoff delay for retry on write failure.
const DEBOUNCE_RETRY_MS = 500;

export function prefsUpdate(patch: Partial<AppPrefs>): void {
  // Accumulate patch.
  _pendingPatch = { ...(_pendingPatch ?? {}), ...patch };

  // Reset debounce timer.
  if (_debounceTimer !== null) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    // v1.4 — L2: if a write is already in flight, back off 50 ms so we don't
    // race two concurrent AsyncStorage RMW operations.
    if (_writeInFlight) {
      _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        const deferred = _pendingPatch;
        if (deferred === null) return;
        _pendingPatch = null;
        void _doWrite(deferred);
      }, 50);
      return;
    }
    const toBeSaved = _pendingPatch;
    if (toBeSaved === null) return;
    _pendingPatch = null;
    void _doWrite(toBeSaved);
  }, DEBOUNCE_MS);
}

// v1.4 — L2: single shared async write helper. Sets _writeInFlight before
// the await and clears it when done. On failure, re-merges the patch and
// re-arms a ONE-SHOT retry (B10 backoff). Second failure gives up to avoid
// a retry storm on a full-disk or revoked-storage condition.
async function _doWrite(toBeSaved: Partial<AppPrefs>): Promise<void> {
  _writeInFlight = true;
  let scheduleRetry = false;
  try {
    const current = await loadPrefs();
    await savePrefs({ ...current, ...toBeSaved });
  } catch (err) {
    log.e('prefsUpdate', `AsyncStorage write failed — will retry in ${DEBOUNCE_RETRY_MS} ms: ${String(err)}`);
    // Re-merge: newer patch wins over the failed one so no data is lost.
    _pendingPatch = { ...toBeSaved, ...(_pendingPatch ?? {}) };
    // Arm a one-shot retry timer. _writeInFlight stays true until the retry
    // either succeeds or fails — so any concurrent prefsUpdate() debounce fire
    // backs off via the 50 ms guard in prefsUpdate rather than racing us.
    if (_debounceTimer !== null) { clearTimeout(_debounceTimer); _debounceTimer = null; }
    scheduleRetry = true;
    // v1.4 wave-8 — T2 INVESTIGATED-NO-RACE: _writeInFlight is NOT cleared
    // here (scheduleRetry=true causes the outer finally to leave it true).
    // The setTimeout callback runs ~500 ms later with _writeInFlight=true.
    // prefsFlush polls until _writeInFlight=false; during the retry IIFE the
    // flag remains true (cleared only in the IIFE's own finally). So no
    // concurrent write window exists. The retryPatch===null early-exit is the
    // only path that clears the flag inside the callback, and that exit fires
    // only when _pendingPatch was already null — no data to write at all.
    _debounceTimer = setTimeout(() => {
      _debounceTimer = null;
      const retryPatch = _pendingPatch;
      if (retryPatch === null) { _writeInFlight = false; return; }
      _pendingPatch = null;
      (async () => {
        try {
          const current = await loadPrefs();
          await savePrefs({ ...current, ...retryPatch });
        } catch (retryErr) {
          // Second failure — log and give up to avoid an infinite retry storm.
          log.e('prefsUpdate', `AsyncStorage retry also failed — data lost: ${String(retryErr)}`);
        } finally {
          _writeInFlight = false;
        }
      })();
    }, DEBOUNCE_RETRY_MS);
  } finally {
    // Clear the in-flight guard ONLY if we did NOT schedule a retry.
    // When scheduleRetry is true the guard must stay set until the retry
    // completes; the retry's own finally block clears it.
    if (!scheduleRetry) _writeInFlight = false;
  }
}

/**
 * Flush any pending debounced write immediately.
 * Useful in AppState 'background' handlers and tests.
 * Returns a promise that resolves once the write is complete (or there was
 * nothing pending).
 */
export async function prefsFlush(): Promise<void> {
  if (_debounceTimer !== null) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  // v1.4 wave-5 — L2: poll BEFORE touching _pendingPatch (silence-over-wrong
  // for storage).  The wave-4 code cleared _pendingPatch before the polling
  // loop ran, so a timeout meant the data was gone. Fix: poll first, then
  // take ownership of the patch only once we know _writeInFlight is clear.
  // If we time out, _pendingPatch is left intact so a future prefsUpdate call
  // or App relaunch will pick it up — we lose nothing.
  const FLUSH_POLL_MAX_MS = 2000;
  const FLUSH_POLL_INTERVAL_MS = 50;
  const maxIterations = Math.ceil(FLUSH_POLL_MAX_MS / FLUSH_POLL_INTERVAL_MS);
  for (let i = 0; i < maxIterations && _writeInFlight; i++) {
    await new Promise<void>((resolve) => { setTimeout(resolve, FLUSH_POLL_INTERVAL_MS); });
  }
  if (_writeInFlight) {
    log.w('Prefs', 'flushAsync-timeout', { maxMs: FLUSH_POLL_MAX_MS });
    // _pendingPatch is intentionally NOT cleared — the data survives for the
    // next flush attempt. Silence-over-wrong: lose no data on timeout.
    return;
  }
  // Take ownership now that the write slot is clear.
  const patch = _pendingPatch;
  if (patch === null) return;
  _pendingPatch = null;
  _writeInFlight = true;
  try {
    const current = await loadPrefs();
    await savePrefs({ ...current, ...patch });
  } catch {
    // Best-effort.
  } finally {
    _writeInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// U22 — MetroProfile JSON validation guard (council-decisions.md U22 / F7).
//
// metroProfilesJson is a v1.3 field that holds 4 user-defined metro profiles
// as a JSON string. On cold launch, this function validates the string before
// any field is applied to live state. A single bad profile → entire load
// returns null so the caller falls back silently to legacy v1.2 fields.
//
// Schema (per §11 F7 council decision):
//   Array of exactly 4 MetroProfile objects. Each must have:
//     name:     string (non-empty)
//     bpm:      integer 20..300
//     timeSig:  '2/4' | '3/4' | '4/4' | '6/8' | 'custom'
//     pattern:  { midi: number (35..81), velocity: number (1..127) }[]
//               length must match the time-sig numerator (or any length for
//               'custom', validated non-empty).
//     subdivisions: 'off' | '8th' | '16th' | 'triplet'
//     subMidi:  integer 35..81
//     subVel:   integer 1..127
//
// The check is strict — every field type-validated. On any mismatch the
// entire load returns null so the caller falls back without overwriting
// the user's working legacy settings.
// ---------------------------------------------------------------------------

export interface MetroProfile {
  name:          string;
  bpm:           number;
  timeSig:       '2/4' | '3/4' | '4/4' | '6/8' | 'custom';
  pattern:       { midi: number; velocity: number }[];
  subdivisions:  'off' | '8th' | '16th' | 'triplet';
  subMidi:       number;
  subVel:        number;
}

// Expected count of profiles in the array.
const METRO_PROFILE_COUNT = 4;

// BPM range.
const BPM_MIN  = 20;
const BPM_MAX  = 300;

// GM-drum MIDI range (same as coercePatternJson above).
const MIDI_MIN = 35;
const MIDI_MAX = 81;

// Numerator per time-sig preset (used for pattern-length validation).
const TIME_SIG_NUMERATOR: Record<string, number> = {
  '2/4': 2,
  '3/4': 3,
  '4/4': 4,
  '6/8': 6,
};

const VALID_TIME_SIGS = new Set(['2/4', '3/4', '4/4', '6/8', 'custom']);
const VALID_SUBDIVS   = new Set(['off', '8th', '16th', 'triplet']);

function validateProfile(elem: unknown, index: number): elem is MetroProfile {
  if (typeof elem !== 'object' || elem === null || Array.isArray(elem)) return false;
  const p = elem as Record<string, unknown>;

  // name — non-empty string.
  if (typeof p.name !== 'string' || p.name.length === 0) return false;

  // bpm — integer 20..300.
  const bpm = Number(p.bpm);
  if (!Number.isFinite(bpm) || !Number.isInteger(bpm) || bpm < BPM_MIN || bpm > BPM_MAX) return false;

  // timeSig — one of the allowed values.
  if (typeof p.timeSig !== 'string' || !VALID_TIME_SIGS.has(p.timeSig)) return false;
  const timeSig = p.timeSig as MetroProfile['timeSig'];

  // pattern — array, validated per-element.
  if (!Array.isArray(p.pattern) || p.pattern.length === 0) return false;
  // Length must match time-sig numerator for presets; any non-zero length for 'custom'.
  if (timeSig !== 'custom') {
    const expectedLen = TIME_SIG_NUMERATOR[timeSig];
    if (p.pattern.length !== expectedLen) return false;
  }
  for (const cell of p.pattern) {
    if (typeof cell !== 'object' || cell === null || Array.isArray(cell)) return false;
    const c = cell as Record<string, unknown>;
    const midi = Number(c.midi);
    const vel  = Number(c.velocity);
    if (!Number.isFinite(midi) || !Number.isInteger(midi) || midi < MIDI_MIN || midi > MIDI_MAX) return false;
    if (!Number.isFinite(vel)  || !Number.isInteger(vel)  || vel  < 1        || vel  > 127     ) return false;
  }

  // subdivisions — one of the allowed values.
  if (typeof p.subdivisions !== 'string' || !VALID_SUBDIVS.has(p.subdivisions)) return false;

  // subMidi — integer 35..81.
  const subMidi = Number(p.subMidi);
  if (!Number.isFinite(subMidi) || !Number.isInteger(subMidi) || subMidi < MIDI_MIN || subMidi > MIDI_MAX) return false;

  // subVel — integer 1..127.
  const subVel = Number(p.subVel);
  if (!Number.isFinite(subVel) || !Number.isInteger(subVel) || subVel < 1 || subVel > 127) return false;

  void index; // index kept for future diagnostic logging.
  return true;
}

/**
 * Parse and strictly validate a `metroProfilesJson` string.
 *
 * Returns the validated array on success, or null on any failure (bad JSON,
 * wrong array length, schema mismatch in any single profile, or midi / BPM
 * values out of range). The caller MUST fall back to legacy v1.2 fields when
 * this returns null — it must NOT overwrite working settings with defaults
 * (U22 / F7 invariant).
 */
export function loadMetroProfiles(json: unknown): MetroProfile[] | null {
  // Accept either a raw string (as stored in AsyncStorage) or already-parsed value.
  let parsed: unknown;
  if (typeof json === 'string') {
    if (json.length === 0) return null;
    try {
      parsed = JSON.parse(json);
    } catch {
      return null;
    }
  } else {
    parsed = json;
  }

  // Must be a non-null, non-array object... wait — we want an ARRAY here.
  if (!Array.isArray(parsed)) return null;

  // Strict length check: must have exactly METRO_PROFILE_COUNT profiles.
  if (parsed.length !== METRO_PROFILE_COUNT) return null;

  // Validate every profile — a single bad one aborts the entire load.
  for (let i = 0; i < parsed.length; i++) {
    if (!validateProfile(parsed[i], i)) return null;
  }

  // All profiles valid — return the typed array.
  return parsed as MetroProfile[];
}

/**
 * v1.4 (Wave 3.5) — serialize an array of MetroProfile records back to the
 * canonical `metroProfilesJson` string. The INVERSE of loadMetroProfiles:
 * what this writes, that reads back validated. Used by useMetronome's profile
 * persistence path. Clamps every field into the validateProfile-accepted range
 * (defensive — the caller should already pass clean values) so a round-trip is
 * always lossless w.r.t. validity. Length is NOT forced to match the numerator
 * here; the caller (which owns beatsPerBar) is responsible for keeping a
 * preset profile's pattern length === its numerator, exactly as the live
 * pattern-resize path already does.
 */
export function serializeMetroProfiles(profiles: MetroProfile[]): string {
  const clampInt = (v: number, lo: number, hi: number, def: number): number => {
    if (!Number.isFinite(v)) return def;
    return Math.max(lo, Math.min(hi, Math.trunc(v)));
  };
  const out: MetroProfile[] = profiles.map((p) => ({
    name: typeof p.name === 'string' && p.name.length > 0 ? p.name : 'User',
    bpm: clampInt(p.bpm, BPM_MIN, BPM_MAX, 100),
    timeSig: VALID_TIME_SIGS.has(p.timeSig) ? p.timeSig : '4/4',
    pattern: p.pattern.map((c) => ({
      midi: clampInt(c.midi, MIDI_MIN, MIDI_MAX, 76),
      velocity: clampInt(c.velocity, 1, 127, 90),
    })),
    subdivisions: VALID_SUBDIVS.has(p.subdivisions) ? p.subdivisions : 'off',
    subMidi: clampInt(p.subMidi, MIDI_MIN, MIDI_MAX, 42),
    subVel: clampInt(p.subVel, 1, 127, 70),
  }));
  return JSON.stringify(out);
}
