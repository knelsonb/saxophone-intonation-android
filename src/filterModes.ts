/**
 * filterModes.ts — Filter-mode post-processor for pitch detection frames.
 *
 * Ported from sax_audio_engine.py (desktop v0.5.6):
 *   presets       lines 104–108
 *   state machine lines 1094–1246 (_make_callback / _on_silence)
 *
 * State machine (no NumPy, no Qt, no locks):
 *   _recent   rolling window of (roundedMidi, freqHz), capped at preset.window.
 *   confirm   count of _recent entries matching the latest roundedMidi;
 *             suppress while count < preset.confirm.
 *   relock    when confirmed MIDI changes: trim+flush _pending, reset _hopInNote.
 *   edgeHops  suppress the first preset.edgeHops frames after a relock.
 *   median    median Hz over matching _recent entries → _pending → emit front
 *             once depth > edgeHops.
 *   silence   rawHz null → flush _pending, clear all state.
 */

export type FilterMode = 'fast' | 'normal' | 'slow';

export interface FilterPreset {
  window: number;
  confirm: number;
  yinThreshold: number;
  /** Linear RMS gate — sqrt(mean(x²)). 8e-5≈-82dBFS, 1.5e-4≈-76dBFS, 3e-4≈-70dBFS. */
  rmsFloorLinear: number;
  edgeHops: number;
  /**
   * EMA weight for the PEAK-override readout path (engine bypasses the filter
   * vote/median state machine and shows YIN's raw freq directly). Higher =
   * snappier display, lower = smoother. Mode-coupled so the RESPONSE selector
   * affects the readout cadence even when PEAK is on — without this the PEAK
   * path was strobing at the full 40 Hz audio rate regardless of mode.
   */
  peakEmaAlpha: number;
}

/** Internal mutable state. Exported so the engine can allocate one per
 *  stream start with newFilterState(). Treat as opaque outside this module. */
export interface FilterState {
  _recent: Array<[number, number]>; // [roundedMidi, freqHz], oldest first
  _lockedMidi: number | null;
  _hopInNote: number;
  _pending: Array<number>;          // freqHz values buffered before emit
}

// Presets must match sax_audio_engine.py FILTER_PRESETS exactly (lines 105–107).
export const FILTER_PRESETS: Record<FilterMode, FilterPreset> = {
  fast:   { window: 3,  confirm: 2, yinThreshold: 0.15, rmsFloorLinear: 8e-5,   edgeHops: 1, peakEmaAlpha: 0.55 },
  normal: { window: 5,  confirm: 3, yinThreshold: 0.10, rmsFloorLinear: 1.5e-4, edgeHops: 2, peakEmaAlpha: 0.25 },
  slow:   { window: 10, confirm: 6, yinThreshold: 0.07, rmsFloorLinear: 3e-4,   edgeHops: 4, peakEmaAlpha: 0.10 },
};

export function newFilterState(): FilterState {
  return { _recent: [], _lockedMidi: null, _hopInNote: 0, _pending: [] };
}

export function resetFilterState(s: FilterState): void {
  s._recent.length = 0;
  s._lockedMidi = null;
  s._hopInNote = 0;
  s._pending.length = 0;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const A4_HZ = 440.0;

function freqToMidi(hz: number): number {
  if (hz <= 0) return NaN;
  return 69.0 + 12.0 * Math.log2(hz / A4_HZ);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Mirrors desktop _drop_pending_for_edge (sax_audio_engine.py:1216).
function dropPendingForEdge(s: FilterState, edgeHops: number): void {
  const keep = Math.max(0, s._pending.length - edgeHops);
  s._pending = s._pending.slice(0, keep);
}

// Mirrors desktop _on_silence (sax_audio_engine.py:1237–1246).
// Returns flushed freqHz values so the caller can emit the final note.
function onSilence(s: FilterState, edgeHops: number): number[] {
  const flushed: number[] = [];
  if (s._lockedMidi !== null || s._pending.length > 0 || s._recent.length > 0) {
    dropPendingForEdge(s, edgeHops);
    while (s._pending.length > 0) flushed.push(s._pending.shift()!);
  }
  s._recent.length = 0;
  s._lockedMidi = null;
  s._hopInNote = 0;
  return flushed;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Post-process one audio frame through the filter state machine.
 *
 * @param state       Mutable session state — allocate with newFilterState().
 * @param rawHz       YIN output in Hz, or null for a silent/invalid frame.
 * @param preset      Active FilterPreset from FILTER_PRESETS.
 * @param _sampleRate Reserved for future per-rate edge timing (unused — hop
 *                    counts are pre-calibrated in the presets).
 * @returns           Smoothed, confirmed, edge-suppressed Hz, or null.
 *
 * Silence flushing: the desktop emits all pending frames as Qt signals; here
 * we return only the last flushed value — _pending holds at most one entry on
 * a clean release, so information loss is negligible in practice.
 */
export function processFrame(
  state: FilterState,
  rawHz: number | null,
  preset: FilterPreset,
  _sampleRate: number,
): number | null {
  if (rawHz === null || rawHz <= 0) {
    const flushed = onSilence(state, preset.edgeHops);
    return flushed.length > 0 ? flushed[flushed.length - 1] : null;
  }

  const midi = freqToMidi(rawHz);
  if (!isFinite(midi)) {
    onSilence(state, preset.edgeHops);
    return null;
  }
  const roundedMidi = Math.round(midi);

  // Rolling window append — mirrors sax_audio_engine.py:1175–1177.
  state._recent.push([roundedMidi, rawHz]);
  if (state._recent.length > preset.window) state._recent.shift();

  // Vote count for the most-recent MIDI across the window.
  const latestMidi = state._recent[state._recent.length - 1][0];
  let matches = 0;
  for (const [m] of state._recent) { if (m === latestMidi) matches++; }

  if (matches < preset.confirm) return null;

  // Relock on MIDI change — mirrors sax_audio_engine.py:1185–1192.
  if (state._lockedMidi !== latestMidi) {
    dropPendingForEdge(state, preset.edgeHops);
    state._pending.length = 0; // discard old-note survivors
    state._lockedMidi = latestMidi;
    state._hopInNote = 0;
  }

  state._hopInNote += 1;

  // Edge suppression — mirrors sax_audio_engine.py:1193–1195.
  if (state._hopInNote <= preset.edgeHops) return null;

  // Median over matching _recent freqHz — mirrors sax_audio_engine.py:1196–1205.
  const matchingFreqs: number[] = [];
  for (const [m, f] of state._recent) { if (m === latestMidi) matchingFreqs.push(f); }
  if (matchingFreqs.length === 0) return null;

  state._pending.push(median(matchingFreqs));
  if (state._pending.length > preset.edgeHops) return state._pending.shift()!;

  return null;
}
