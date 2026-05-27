/**
 * PerBeatRow — v1.2 horizontal row of N per-beat cells (§4 + §15.Q11.12).
 *
 * Each cell shows the beat number on top and the assigned drum's short label
 * on the bottom. Tap opens the DrumPicker (parent owns the sheet — this
 * component only fires `onCellTap(idx)`). Beat 1 carries a permanent left
 * accent stripe to mark the downbeat in any numerator.
 *
 * Live flash (per F18-15 council ruling + §18.4):
 *   - Subscribes to `bus.on('noteOn', ...)` and filters channel === 'drums'.
 *   - Per U21 the listener fires synchronously inside the noteOn call stack,
 *     so the visual lands on the same frame the audio dispatched.
 *   - NO Animated, NO auto-scroll. Border-colour swap only.
 *   - When `bus` is undefined (e.g. editor preview), no subscription is taken
 *     and the row never flashes — that surface isn't supposed to flash anyway.
 *
 * Layout: ScrollView horizontal when beatsPerBar > 8 so 9..32 beats remain
 * usable on phone widths (§4 final rule). Cell width fixed at 56dp (Aragorn
 * §15.Q11.5 mitigation), touch target ≥48dp.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { makeStyles } from '../uiShared';
import { resolveDrumByMidi } from '../drumVoices';
import type { BeatInstrument } from '../useMetronome';
import type { MidiBusState } from '../useMidiBusCore';

const HORIZONTAL_SCROLL_THRESHOLD = 8;

export interface PerBeatRowProps {
  pattern: BeatInstrument[];
  beatsPerBar: number;
  /**
   * v1.3 — kept as informational only; the live flash is now driven by a
   * `bus.on('noteOn')` subscription per F18-15. Some callers (the editor
   * accordion) pass 0 and it's ignored.
   *
   * @deprecated since v1.3 — no longer used for flash. Will be removed in
   * v1.4 once no caller threads it through.
   */
  runningPulse?: number;
  /**
   * v1.3 — informational. The flash logic respects bus events, not this prop.
   * Kept on the type so existing call sites keep compiling; if the bus is
   * undefined the row never flashes regardless of `running`.
   */
  running?: boolean;
  /** Caller opens the drum picker with the right slot context for this beat. */
  onCellTap: (beatIdx: number) => void;
  /**
   * v1.3 — bus reference for live flash subscription. When omitted, the row
   * still renders correctly but never flashes (the editor preview case).
   */
  bus?: MidiBusState;
}

export function PerBeatRow({ pattern, beatsPerBar, onCellTap, bus }: PerBeatRowProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  // v1.3 — beat-index flash driven by a synchronous bus subscription. Per U21
  // the listener fires in the same JS call stack as the noteOn that triggered
  // it, so this setState lands on the same frame as the audio dispatch.
  //
  // We track an internal bar position (modulo beatsPerBar) because the bus
  // event itself doesn't carry a beat index — useMetronome fires noteOn per
  // beat in order, so a running counter is enough. v1.3.2 — sub-tick noteOns
  // are filtered out via `evt.tick === 'sub'` so the counter ticks once per
  // downbeat regardless of subdivision setting.
  const [liveBeatIdx, setLiveBeatIdx] = useState<number>(-1);

  // v1.3.4 B3 — beatsPerBarRef lets the listener read a fresh beatsPerBar
  // on every noteOn without appearing in the effect deps. Without this,
  // every time-sig change caused listener teardown + remount, creating a
  // window where the beat firing during the gap was silently dropped.
  const beatsPerBarRef = useRef(beatsPerBar);
  useEffect(() => { beatsPerBarRef.current = beatsPerBar; }, [beatsPerBar]);

  useEffect(() => {
    if (!bus) {
      setLiveBeatIdx(-1);
      return;
    }
    // Per-subscription local counter. Resets to 0 whenever this effect
    // rebinds — on bus identity change only (B3 fix). A mid-bar time-sig
    // flip in useMetronome already resets its scheduler's nextBeatIndex to
    // 0 and setBeat(1); beatsPerBarRef.current is updated synchronously
    // before the next noteOn arrives, so the modulo stays correct.
    let next = 0;
    const off = bus.on('noteOn', (evt) => {
      if (evt.channel !== 'drums') return;
      // Velocity 0 won't ever fire (useMetronome guards) but defensive.
      if ((evt.velocity ?? 0) <= 0) return;
      // v1.3.2 — sub-tick guard (council §18 / G14). Sub-ticks ride the
      // same 'drums' channel as beats; without this filter the counter
      // double-steps at 8th-note subs (2× beat rate) and visually walks
      // ahead of the audible downbeat. Bus emits `tick: 'beat' | 'sub' |
      // undefined`; we advance only on explicit 'beat' OR undefined
      // (defensive: a non-metronome consumer that omits the tick field
      // is treated as a beat-equivalent, matching pre-v1.3.2 behaviour).
      if (evt.tick === 'sub') return;
      // v1.3.4 B3 — read beatsPerBar from ref; dep change no longer
      // forces a listener rebind.
      const beatsNow = beatsPerBarRef.current > 0 ? beatsPerBarRef.current : 1;
      const idx = next % beatsNow;
      setLiveBeatIdx(idx);
      // v1.3.4 B4 — `next = idx + 1` is arithmetically identical to
      // `next += 1` here because idx = next % beatsNow, so
      // idx + 1 = (prev_next % beatsNow) + 1. On the subsequent fire,
      // next % beatsNow = (idx + 1) % beatsNow — the modulo absorbs the
      // difference. No off-by-one. The Uruks flag is a false positive.
      next = idx + 1;
    });
    return () => {
      off();
    };
  }, [bus]);

  const cells: React.ReactElement[] = [];
  for (let i = 0; i < beatsPerBar; i++) {
    const cell = pattern[i];
    const drum = cell ? resolveDrumByMidi(cell.midi) : undefined;
    const shortLabel = drum?.shortLabel ?? (cell ? `GM${cell.midi}` : '—');
    const isDownbeat = i === 0;
    const isLive = i === liveBeatIdx;

    cells.push(
      <Pressable
        key={`beat-${i}`}
        onPress={() => onCellTap(i)}
        accessibilityRole="button"
        accessibilityLabel={`Beat ${i + 1}, ${drum?.label ?? 'unassigned'}. Tap to change.`}
        style={({ pressed }) => [
          styles.perBeat_cell,
          isDownbeat && styles.perBeat_cellDownbeat,
          isLive && styles.perBeat_cellLive,
          pressed && styles.perBeat_cellPressed,
        ]}
      >
        <Text style={styles.perBeat_beatNumber}>{i + 1}</Text>
        <Text
          style={styles.perBeat_drumLabel}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {shortLabel}
        </Text>
      </Pressable>,
    );
  }

  // N>8 → horizontal scroll so the row stays inside the SETUP width without
  // wrapping (§4: one bar = one row, never wrap).
  if (beatsPerBar > HORIZONTAL_SCROLL_THRESHOLD) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        nestedScrollEnabled
        contentContainerStyle={styles.perBeat_scrollContent}
        style={styles.perBeat_scrollOuter}
      >
        {cells}
      </ScrollView>
    );
  }

  return <View style={styles.perBeat_row}>{cells}</View>;
}
