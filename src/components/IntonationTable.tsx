/**
 * IntonationTable — full-screen modal showing aggregated intonation data.
 *
 * Refreshes every 2s while open. Columns: note name, mean cents (color-coded),
 * std dev, count. Footer: allow-out-of-range toggle + min-N stepper.
 * Overflow menu: "Clear data for this instrument" (tap-twice-to-confirm).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { aggregateNotes, clearMeasurements } from '../storage/measurements';
import type { AggregatedNote } from '../storage/measurements';
import { midiToNoteName } from '../music';
import type { DisplayMode } from '../useAudioEngine';
import { transpMap } from '../instruments';

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

const C = {
  bg: '#07080b', face: '#0e1116', edge: '#1e242e', edgeSoft: '#161b22',
  ink: '#f0f1f3', inkMid: '#a6acb6', inkDim: '#5a626d',
  accent: '#d6b86a', inTune: '#5fb87a', warn: '#d6a43a', bad: '#b8635f',
};

const MIN_N_MIN = 1;
const MIN_N_MAX = 50;
const REFRESH_MS = 2000;

function centColor(mean: number): string {
  const a = Math.abs(mean);
  if (a <= 10) return C.inTune;
  if (a <= 25) return C.warn;
  return C.bad;
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
  const [rows, setRows] = useState<AggregatedNote[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const clearArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchRows = useCallback(async () => {
    const data = await aggregateNotes({ instrument: instrumentKey, a4Hz, minN });
    setRows(data);
  }, [instrumentKey, a4Hz, minN]);

  useEffect(() => {
    if (!visible) return;
    fetchRows().catch(() => {});
    const id = setInterval(() => { fetchRows().catch(() => {}); }, REFRESH_MS);
    return () => { clearInterval(id); };
  }, [visible, fetchRows]);

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

        <View style={s.colHeader}>
          <Text style={[s.colText, s.colNote]}>NOTE</Text>
          <Text style={[s.colText, s.colMean]}>MEAN</Text>
          <Text style={[s.colText, s.colStd]}>STD</Text>
          <Text style={[s.colText, s.colN]}>N</Text>
        </View>

        <ScrollView style={s.scroll} showsVerticalScrollIndicator={false}>
          {displayRows.length === 0 ? (
            <View style={s.emptyState}>
              <Text style={s.emptyText}>No measurements yet.</Text>
              <Text style={s.emptyHint}>Play a sustained note.</Text>
            </View>
          ) : (
            displayRows.map((row) => (
              <View key={row.midiFing} style={s.row}>
                <Text style={[s.cell, s.colNote, s.noteText]}>{noteLabel(row.midiFing, displayMode, instrumentKey)}</Text>
                <Text style={[s.cell, s.colMean, { color: centColor(row.meanCents) }]}>{row.meanCents >= 0 ? '+' : ''}{row.meanCents.toFixed(1)}</Text>
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

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: 40 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, borderBottomColor: C.edge, borderBottomWidth: 1 },
  headerBtn: { paddingHorizontal: 10, paddingVertical: 6, borderColor: C.edge, borderWidth: 1, borderRadius: 2, minWidth: 60, alignItems: 'center' },
  headerBtnPressed: { backgroundColor: C.edge },
  headerBtnText: { color: C.inkMid, fontSize: 12, letterSpacing: 2 },
  headerTitle: { color: C.ink, fontSize: 12, letterSpacing: 4, fontWeight: '600' },
  overflowMenu: { backgroundColor: C.face, borderColor: C.edge, borderWidth: 1, borderRadius: 2, marginHorizontal: 16, marginTop: 4 },
  menuItem: { paddingHorizontal: 16, paddingVertical: 14 },
  menuItemPressed: { backgroundColor: C.edge },
  menuItemText: { color: C.inkMid, fontSize: 11, letterSpacing: 2 },
  menuItemTextArmed: { color: C.bad, fontWeight: '700' },
  colHeader: { flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 8, borderBottomColor: C.edgeSoft, borderBottomWidth: 1 },
  colText: { color: C.inkDim, fontSize: 9, letterSpacing: 3, fontWeight: '600' },
  scroll: { flex: 1 },
  row: { flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 12, borderBottomColor: C.edgeSoft, borderBottomWidth: 1 },
  cell: { fontSize: 13, fontVariant: ['tabular-nums'] },
  noteText: { color: C.ink, fontWeight: '500' },
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
  footerLabel: { color: C.inkDim, fontSize: 10, letterSpacing: 3 },
  toggle: { flexDirection: 'row', gap: 4 },
  togglePill: { minWidth: 44, height: 28, paddingHorizontal: 12, borderColor: C.edge, borderWidth: 1, borderRadius: 2, alignItems: 'center', justifyContent: 'center' },
  togglePillActive: { backgroundColor: C.accent, borderColor: C.accent },
  togglePillPressed: { opacity: 0.7 },
  toggleText: { color: C.inkDim, fontSize: 10, letterSpacing: 2, fontWeight: '600' },
  toggleTextActive: { color: C.bg },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepBtn: { width: 32, height: 28, borderColor: C.edge, borderWidth: 1, borderRadius: 2, alignItems: 'center', justifyContent: 'center' },
  stepBtnPressed: { backgroundColor: C.edge },
  stepBtnText: { color: C.accent, fontSize: 10, lineHeight: 12 },
  stepValue: { color: C.inkMid, fontSize: 14, fontVariant: ['tabular-nums'], minWidth: 28, textAlign: 'center' },
});
