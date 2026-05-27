/**
 * usePitchPipes — bus-mediated, infinite-sustain pitch pipes.
 *
 * v1.3 Wave 2C — see docs/v1.3-state-machine-scrub.md §6.5.10 and
 * docs/v1.3-council-decisions.md (U17, U25 = GM 80 Synth Lead Square).
 *
 * Replaces the pre-v1.3 expo-audio WAV-loop path in PitchPipes.tsx /
 * pitchTones.ts. Tap a pipe → noteOn on channel-role 'pipes' (GM ch 1).
 * The note sustains indefinitely (no scheduled noteOff). Tap the same
 * pipe → noteOff. Tap a different pipe → noteOff previous + noteOn next.
 *
 * Architectural invariants:
 *  - Single owner of the 'pipes' channel handle. Acquired on mount via
 *    bus.reserve('pipes'); if the reserve is denied (U23), the hook
 *    becomes a no-op and logs a forensic warning. No user-visible toast.
 *  - A4 compensation: TSF voices are intrinsically tuned to A4=440. We
 *    apply a baseline pitch-bend of `1200 * log2(a4Hz / 440)` cents
 *    (semitone-equivalent) on every noteOn AND whenever a4Hz changes
 *    while a pipe is sounding. Same formula as useDrone (see
 *    src/useDrone.ts:51-54).
 *  - Voice change: noteOff → programChange → noteOn (re-attack pattern,
 *    mirrors useDrone:336-359). Rationale: mid-note program change
 *    leaves the previous SoundFont sample playing through release, so the
 *    user wouldn't hear the new timbre until the next note-on.
 *  - Cleanup: release current note + release channel handle on unmount.
 *
 * Off-bus during early bring-up: this hook calls useMidiBus() directly
 * (rather than receiving a `bus` arg) so that PitchPipes.tsx can pick it
 * up without App.tsx wiring. When App.tsx later threads a shared bus via
 * the v1.3 coordinator, the call signature stays compatible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { log } from './log';
import type { ChannelHandle, MidiBusState } from './useMidiBus';
import { useUiPrefsStore } from './useUiPrefsStore';

// Velocity for pipe notes (MIDI 0..127). Matches the Wave 2C contract.
const PIPES_VELOCITY = 110;

// GM patch 80 = Synth Lead Square (per council U25). Used only when the
// pref store hasn't hydrated yet — once useUiPrefsStore.prefsLoaded flips,
// we adopt the persisted value.
const DEFAULT_PIPES_VOICE = 80;

/** A4 compensation in semitones. Mirrors useDrone.a4BendSemitones. */
function a4BendSemitones(a4Hz: number): number {
  if (!Number.isFinite(a4Hz) || a4Hz <= 0) return 0;
  return (1200 * Math.log2(a4Hz / 440)) / 100;
}

export interface PipesState {
  /** True once the bus is ready AND the channel reservation succeeded. */
  ready: boolean;
  /** Currently sustaining note, or null. */
  currentMidi: number | null;
  /** Tap a pipe: toggle on if different midi (or null), tap same midi to release. */
  toggle: (midi: number) => void;
  /** Hard stop — noteOff if a pipe is sustaining; no-op otherwise. */
  release: () => void;
  /** GM program 0-127. Defaults to 80 (Synth Lead Square) per U25. */
  voice: number;
  /** Change voice. Re-attacks if a pipe is sustaining. Persists via prefs. */
  setVoice: (program: number) => void;
}

export interface UsePitchPipesOptions {
  /**
   * v1.3 — the bus is owned by App.tsx and passed down. usePitchPipes accepts
   * it as a prop (consistent with useDrone + useMetronome) instead of
   * resolving via useMidiBus() internally, because useMidiBus is per-instance
   * stateful — multiple internal calls would create parallel bus instances
   * with independent synth attachments + channel-reservation tables.
   */
  bus: MidiBusState;
  a4Hz: number;
}

export function usePitchPipes(opts: UsePitchPipesOptions): PipesState {
  const { bus, a4Hz } = opts;

  const prefs = useUiPrefsStore();

  // Mirror the prefs.pipesVoice into local state so the returned `voice`
  // field is always synchronously consistent with the last setVoice() call.
  // Until prefs hydrate, fall back to the council default.
  const [voice, setVoiceState] = useState<number>(DEFAULT_PIPES_VOICE);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const [currentMidi, setCurrentMidi] = useState<number | null>(null);
  const currentMidiRef = useRef<number | null>(null);
  currentMidiRef.current = currentMidi;

  // Channel handle — null until the bus successfully reserves 'pipes'.
  const handleRef = useRef<ChannelHandle | null>(null);
  const [reserved, setReserved] = useState<boolean>(false);

  // Live A4 ref so the voice-change effect can read the freshest value
  // without re-binding the callback. The a4 effect below handles the
  // mid-sustain bend update.
  const a4Ref = useRef(a4Hz);
  a4Ref.current = a4Hz;

  // ---- Voice hydration from prefs ----
  // When prefs first load, adopt the persisted pipesVoice. Subsequent prefs
  // changes propagate into local state too (in case another caller writes
  // pipesVoice directly via prefs.update). We deliberately treat the persisted
  // value as the authoritative source post-hydration.
  useEffect(() => {
    if (!prefs.prefsLoaded) return;
    if (voiceRef.current !== prefs.pipesVoice) {
      setVoiceState(prefs.pipesVoice);
    }
  }, [prefs.prefsLoaded, prefs.pipesVoice]);

  // ---- Reserve 'pipes' channel on mount ----
  useEffect(() => {
    const handle = bus.reserve('pipes');
    if (handle === null) {
      // U23: silent to user, forensic log only.
      log.w('PitchPipes', 'reserve-denied — channel already in use; pipes are a no-op');
      handleRef.current = null;
      setReserved(false);
      return;
    }
    handleRef.current = handle;
    setReserved(true);
    return () => {
      // Best-effort cleanup. release() inside the handle calls allNotesOff
      // on the underlying channel, so any sustaining pipe goes silent here.
      try {
        handle.release();
      } catch {
        /* ignore — bus logs internally */
      }
      handleRef.current = null;
      setReserved(false);
    };
    // v1.3.1 HOTFIX — deps `[]` not `[bus]`. bus identity rebinds when its
    // `ready` flag flips, but the underlying core is stable; reserving once
    // via the initially-captured bus stays valid for the hook's lifetime.
    // Avoids the release+re-reserve churn that broke useMetronome's
    // drums channel (one-beat-then-silence bug). Matches useDrone pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Toggle ----
  const toggle = useCallback((midi: number): void => {
    const handle = handleRef.current;
    if (handle === null) return; // not reserved — silent no-op
    const cur = currentMidiRef.current;

    if (cur === midi) {
      // Same pipe tapped twice → release.
      try { handle.noteOff(midi); } catch { /* bus logs */ }
      setCurrentMidi(null);
      currentMidiRef.current = null;
      return;
    }

    // Either no pipe sustaining, or a different one is — release current
    // (if any), then attack the new one.
    if (cur !== null) {
      try { handle.noteOff(cur); } catch { /* bus logs */ }
    }
    try { handle.setProgram(voiceRef.current); } catch { /* bus logs */ }
    try { handle.noteOn(midi, PIPES_VELOCITY); } catch { /* bus logs */ }
    // Apply A4 baseline bend. The bus clamps to ±12; a 430..450 Hz range
    // resolves to roughly ±0.4 semitones — well inside the clamp window.
    try { handle.pitchBend(a4BendSemitones(a4Ref.current)); } catch { /* bus logs */ }
    setCurrentMidi(midi);
    currentMidiRef.current = midi;
  }, []);

  // ---- Hard release ----
  const release = useCallback((): void => {
    const handle = handleRef.current;
    const cur = currentMidiRef.current;
    if (handle === null || cur === null) {
      // Nothing sustaining — just normalise the state.
      if (cur !== null) {
        setCurrentMidi(null);
        currentMidiRef.current = null;
      }
      return;
    }
    try { handle.noteOff(cur); } catch { /* bus logs */ }
    setCurrentMidi(null);
    currentMidiRef.current = null;
  }, []);

  // ---- Voice change ----
  // noteOff → programChange → noteOn re-attack while sustaining. The voice
  // change also persists via prefs.update() so a future cold-start adopts it.
  const setVoice = useCallback((program: number): void => {
    if (!Number.isFinite(program)) return;
    const clamped = Math.max(0, Math.min(127, Math.round(program)));
    if (voiceRef.current === clamped) return;
    voiceRef.current = clamped;
    setVoiceState(clamped);
    // Persist (debounced by the prefs store).
    prefs.update({ pipesVoice: clamped });

    // Re-attack if a pipe is currently sustaining.
    const handle = handleRef.current;
    const cur = currentMidiRef.current;
    if (handle === null || cur === null) return;
    try { handle.noteOff(cur); } catch { /* bus logs */ }
    try { handle.setProgram(clamped); } catch { /* bus logs */ }
    try { handle.noteOn(cur, PIPES_VELOCITY); } catch { /* bus logs */ }
    try { handle.pitchBend(a4BendSemitones(a4Ref.current)); } catch { /* bus logs */ }
  }, [prefs]);

  // ---- A4 baseline bend on a4Hz change while sustaining ----
  useEffect(() => {
    const handle = handleRef.current;
    if (handle === null) return;
    if (currentMidiRef.current === null) return;
    try { handle.pitchBend(a4BendSemitones(a4Hz)); } catch { /* bus logs */ }
  }, [a4Hz]);

  // ---- Memoized return — stable identity across renders that don't flip
  // currentMidi / voice / reserved+ready. Both `toggle` and `release` are
  // stable useCallback's; only `setVoice` re-binds when prefs identity
  // changes (rare — user-rate).
  return useMemo<PipesState>(() => ({
    ready: reserved && bus.ready,
    currentMidi,
    toggle,
    release,
    voice,
    setVoice,
  }), [reserved, bus.ready, currentMidi, toggle, release, voice, setVoice]);
}
