/**
 * IntonationTable — full-screen modal showing aggregated intonation data.
 *
 * Refreshes every 2s while open. Columns: note name, mean cents (color-coded),
 * std dev, count. Footer: allow-out-of-range toggle + min-N stepper.
 * Overflow menu: "Clear data for this instrument" (tap-twice-to-confirm).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { aggregateNotes, clearMeasurements } from '../storage/measurements';
import type { AggregatedNote } from '../storage/measurements';
import { midiToNoteName } from '../music';
import type { DisplayMode } from '../useAudioEngine';
import { transpMap } from '../instruments';
import { useTheme, H } from '../theme';
import type { ThemePalette } from '../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  instrumentKey: string;
  displayMode: DisplayMode;
  a4Hz: number;
  minN: number;
  onMinNChange: (n: number) => void;
  allowOutOfRange: boolean;
  onAllowOutOfRangeChange: (v: boolean) => void;
  activeRange: [number, number] | null;
}

const MIN_N_MIN = 1;
const MIN_N_MAX = 50;
const REFRESH_MS = 2000;
// "Last 2s" view rolls a 2-second window of measurements. Refresh at 250ms
// so the tech sees their tweaks reflected within a quarter-second.
const LAST_WINDOW_MS = 2000;
const LAST_REFRESH_MS = 250;

type ViewMode = 'session' | 'last2s';

function centColor(mean: number, C: ThemePalette): string {
  const a = Math.abs(mean);
  // Three-band signal: green (≤10¢, in-tune), amber accent (≤25¢, watch),
  // red sharp (>25¢, fix). `warn`/`bad` from the legacy palette mapped to
  // accent/sharp on the central theme so colour semantics are stable.
  if (a <= 10) return C.inTune;
  if (a <= 25) return C.accent;
  return C.sharp;
}

function noteLabel(midiFing: number, displayMode: DisplayMode, instrumentKey: string): string {
  const transp = transpMap[instrumentKey] ?? 0;
  const midi = displayMode === 'klingend' ? midiFing + transp : midiFing;
  const { letter, accidental, octave } = midiToNoteName(midi);
  return `${letter}${accidental}${octave}`;
}

export function IntonationTable({
  visible, onClose, instrumentKey, displayMode, a4Hz, minN,
  onMinNChange, allowOutOfRange, onAllowOutOfRangeChange, activeRange,
}: Props) {
  const C = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);
  const [rows, setRows] = useState<AggregatedNote[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('session');
  const clearArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchRows = useCallback(async (mode: ViewMode) => {
    // In Last-2s mode lower minN to 1 — the window is small enough that
    // requiring "≥ minN" would routinely return zero rows for a tech who
    // just blew once. The user's chosen minN still controls the SESSION
    // view.
    const effectiveMinN = mode === 'last2s' ? 1 : minN;
    const sinceTs = mode === 'last2s'
      ? new Date(Date.now() - LAST_WINDOW_MS).toISOString()
      : null;
    const data = await aggregateNotes({
      instrument: instrumentKey,
      a4Hz,
      minN: effectiveMinN,
      sinceTs,
    });
    setRows(data);
  }, [instrumentKey, a4Hz, minN]);

  useEffect(() => {
    if (!visible) return;
    fetchRows(viewMode).catch(() => {});
    const refreshMs = viewMode === 'last2s' ? LAST_REFRESH_MS : REFRESH_MS;
    const id = setInterval(() => { fetchRows(viewMode).catch(() => {}); }, refreshMs);
    return () => { clearInterval(id); };
  }, [visible, fetchRows, viewMode]);

  useEffect(() => {
    if (!visible) {
      setMenuOpen(false);
      setClearArmed(false);
      if (clearArmTimer.current !== null) { clearTimeout(clearArmTimer.current); clearArmTimer.current = null; }
    }
  }, [visible]);

  const handleClearPress = useCallback(() => {
    if (!clearArmed) {
      setClearArmed(true);
      clearArmTimer.current = setTimeout(() => setClearArmed(false), 4000);
      return;
    }
    if (clearArmTimer.current !== null) { clearTimeout(clearArmTimer.current); clearArmTimer.current = null; }
    setClearArmed(false);
    setMenuOpen(false);
    clearMeasurements(instrumentKey).catch(() => {});
    setRows([]);
  }, [clearArmed, instrumentKey]);

  const displayRows = allowOutOfRange
    ? rows
    : rows.filter((r) => activeRange === null || (r.midiFing >= activeRange[0] && r.midiFing <= activeRange[1]));

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.root}>
        <View style={s.header}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close intonation table"
            style={({ pressed }) => [s.headerBtn, pressed && s.headerBtnPressed]}>
            <Text style={s.headerBtnText}>{'‹ BACK'}</Text>
          </Pressable>
          <Text style={s.headerTitle}>INTONATION TABLE</Text>
          <Pressable onPress={() => { setMenuOpen((v) => !v); setClearArmed(false); }}
            accessibilityRole="button" accessibilityLabel="Table options menu"
            style={({ pressed }) => [s.headerBtn, pressed && s.headerBtnPressed]}>
            <Text style={s.headerBtnText}>{'⋮'}</Text>
          </Pressable>
        </View>

        {menuOpen && (
          <View style={s.overflowMenu}>
            <Pressable onPress={handleClearPress}
              accessibilityRole="button" accessibilityLabel={clearArmed ? 'Tap again to confirm' : 'Clear data for this instrument'}
              style={({ pressed }) => [s.menuItem, pressed && s.menuItemPressed]}>
              <Text style={[s.menuItemText, clearArmed && s.menuItemTextArmed]}>
                {clearArmed ? 'TAP AGAIN TO CONFIRM' : 'CLEAR DATA FOR THIS INSTRUMENT'}
              </Text>
            </Pressable>
          </View>
        )}

        {/* View-mode pills: SESSION (cumulative) vs LAST 2s (rolling window). */}
        <View style={s.viewModeRow}>
          <Pressable
            onPress={() => setViewMode('session')}
            accessibilityRole="button"
            accessibilityLabel="Show all measurements for the current session"
            accessibilityState={{ selected: viewMode === 'session' }}
            style={({ pressed }) => [
              s.viewModePill,
              viewMode === 'session' && s.viewModePillActive,
              pressed && s.viewModePillPressed,
            ]}
          >
            <Text style={[s.viewModeText, viewMode === 'session' && s.viewModeTextActive]}>SESSION</Text>
          </Pressable>
          <Pressable
            onPress={() => setViewMode('last2s')}
            accessibilityRole="button"
            accessibilityLabel="Show measurements from the last 2 seconds only — for tweak-and-test workflow"
            accessibilityState={{ selected: viewMode === 'last2s' }}
            style={({ pressed }) => [
              s.viewModePill,
              viewMode === 'last2s' && s.viewModePillActive,
              pressed && s.viewModePillPressed,
            ]}
          >
            <Text style={[s.viewModeText, viewMode === 'last2s' && s.viewModeTextActive]}>LAST 2s</Text>
          </Pressable>
          {viewMode === 'last2s' && (
            <Text style={s.viewModeHint}>refreshing 4×/sec</Text>
          )}
        </View>

        <View style={s.colHeader}>
          <Text style={[s.colText, s.colNote]}>NOTE</Text>
          <Text style={[s.colText, s.colMean]}>MEAN</Text>
          <Text style={[s.colText, s.colStd]}>STD</Text>
          <Text style={[s.colText, s.colN]}>N</Text>
        </View>

        <ScrollView style={s.scroll} showsVerticalScrollIndicator={false}>
          {displayRows.length === 0 ? (
            <View style={s.emptyState}>
              <Text style={s.emptyText}>
                {viewMode === 'last2s' ? 'No samples in the last 2 seconds.' : 'No measurements yet.'}
              </Text>
              <Text style={s.emptyHint}>
                {viewMode === 'last2s'
                  ? 'Blow into the mic — last 2 seconds of samples will appear here.'
                  : 'Play a sustained note.'}
              </Text>
            </View>
          ) : (
            displayRows.map((row) => (
              <View key={row.midiFing} style={s.row}>
                <Text style={[s.cell, s.colNote, s.noteText]}>{noteLabel(row.midiFing, displayMode, instrumentKey)}</Text>
                <Text style={[s.cell, s.colMean, { color: centColor(row.meanCents, C) }]}>{row.meanCents >= 0 ? '+' : ''}{row.meanCents.toFixed(1)}</Text>
                <Text style={[s.cell, s.colStd, s.stdText]}>{row.stdCents.toFixed(1)}</Text>
                <Text style={[s.cell, s.colN, s.nText]}>{row.n}</Text>
              </View>
            ))
          )}
          <View style={{ height: 24 }} />
        </ScrollView>

        <View style={s.footer}>
          <View style={s.footerRow}>
            <Text style={s.footerLabel}>SHOW OUT OF RANGE</Text>
            <View style={s.toggle}>
              {([true, false] as const).map((v) => (
                <Pressable key={String(v)} onPress={() => onAllowOutOfRangeChange(v)}
                  accessibilityRole="button" accessibilityLabel={v ? 'Show out-of-range' : 'Hide out-of-range'}
                  style={({ pressed }) => [s.togglePill, allowOutOfRange === v && s.togglePillActive, pressed && s.togglePillPressed]}>
                  <Text style={[s.toggleText, allowOutOfRange === v && s.toggleTextActive]}>{v ? 'ON' : 'OFF'}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={s.footerRow}>
            <Text style={s.footerLabel}>MIN MEASUREMENTS</Text>
            <View style={s.stepper}>
              <Pressable onPress={() => onMinNChange(Math.max(MIN_N_MIN, minN - 1))}
                accessibilityRole="button" accessibilityLabel="Decrease min count"
                style={({ pressed }) => [s.stepBtn, pressed && s.stepBtnPressed]}>
                <Text style={s.stepBtnText}>▼</Text>
              </Pressable>
              <Text style={s.stepValue}>{minN}</Text>
              <Pressable onPress={() => onMinNChange(Math.min(MIN_N_MAX, minN + 1))}
                accessibilityRole="button" accessibilityLabel="Increase min count"
                style={({ pressed }) => [s.stepBtn, pressed && s.stepBtnPressed]}>
                <Text style={s.stepBtnText}>▲</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const COL_NOTE = 72; const COL_MEAN = 80; const COL_STD = 68; const COL_N = 44;

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg, paddingTop: 40 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, borderBottomColor: C.edge, borderBottomWidth: 1 },
    headerBtn: { paddingHorizontal: 14, paddingVertical: 10, borderColor: C.edge, borderWidth: 1, borderRadius: 4, minWidth: 72, minHeight: H.touchTarget, alignItems: 'center', justifyContent: 'center' },
    headerBtnPressed: { backgroundColor: C.edge },
    headerBtnText: { color: C.inkMid, fontSize: 13, letterSpacing: 2, fontWeight: '700' },
    headerTitle: { color: C.ink, fontSize: 13, letterSpacing: 4, fontWeight: '700' },
    overflowMenu: { backgroundColor: C.face, borderColor: C.edge, borderWidth: 1, borderRadius: 4, marginHorizontal: 16, marginTop: 4 },
    menuItem: { paddingHorizontal: 16, paddingVertical: 14, minHeight: H.touchTarget, justifyContent: 'center' },
    menuItemPressed: { backgroundColor: C.edge },
    menuItemText: { color: C.inkMid, fontSize: 12, letterSpacing: 2 },
    menuItemTextArmed: { color: C.sharp, fontWeight: '700' },
    viewModeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
    viewModePill: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22, borderColor: C.edge, borderWidth: 1, minHeight: H.pillHeight, alignItems: 'center', justifyContent: 'center' },
    viewModePillActive: { backgroundColor: C.accent, borderColor: C.accent },
    viewModePillPressed: { opacity: 0.7 },
    viewModeText: { color: C.inkMid, fontSize: 12, letterSpacing: 2, fontWeight: '700' },
    viewModeTextActive: { color: C.onAccent },
    viewModeHint: { color: C.inkDim, fontSize: 10, letterSpacing: 1, marginLeft: 4 },

    colHeader: { flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 8, borderBottomColor: C.edgeSoft, borderBottomWidth: 1 },
    colText: { color: C.inkDim, fontSize: 10, letterSpacing: 3, fontWeight: '700' },
    scroll: { flex: 1 },
    row: { flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 12, borderBottomColor: C.edgeSoft, borderBottomWidth: 1 },
    cell: { fontSize: 14, fontVariant: ['tabular-nums'] },
    noteText: { color: C.ink, fontWeight: '600' },
    stdText: { color: C.inkMid },
    nText: { color: C.inkDim },
    colNote: { width: COL_NOTE },
    colMean: { width: COL_MEAN, textAlign: 'right' },
    colStd:  { width: COL_STD, textAlign: 'right' },
    colN:    { width: COL_N, textAlign: 'right' },
    emptyState: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 32 },
    emptyText:  { color: C.inkMid, fontSize: 14, letterSpacing: 1, marginBottom: 8 },
    emptyHint:  { color: C.inkDim, fontSize: 12, letterSpacing: 1, textAlign: 'center' },
    footer: { borderTopColor: C.edge, borderTopWidth: 1, paddingHorizontal: 20, paddingVertical: 14, gap: 14 },
    footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    footerLabel: { color: C.inkDim, fontSize: 11, letterSpacing: 3 },
    toggle: { flexDirection: 'row', gap: 4 },
    togglePill: { minWidth: 64, height: H.pillHeight, paddingHorizontal: 14, borderColor: C.edge, borderWidth: 1, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
    togglePillActive: { backgroundColor: C.accent, borderColor: C.accent },
    togglePillPressed: { opacity: 0.7 },
    toggleText: { color: C.inkMid, fontSize: 12, letterSpacing: 2, fontWeight: '700' },
    toggleTextActive: { color: C.onAccent },
    stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    stepBtn: { width: H.stepper, height: H.stepper, borderColor: C.edge, borderWidth: 1, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
    stepBtnPressed: { backgroundColor: C.edge },
    stepBtnText: { color: C.accent, fontSize: 14, lineHeight: 16, fontWeight: '700' },
    stepValue: { color: C.ink, fontSize: 16, fontVariant: ['tabular-nums'], minWidth: 36, textAlign: 'center', fontWeight: '700' },
  });
}
