/**
 * RangeEditor — bottom-sheet for editing per-instrument fingered MIDI range.
 *
 * v0.9.4: migrated from react-native's <Modal> + hand-rolled Pressable
 * backdrop to @gorhom/bottom-sheet. The drag-handle, backdrop and dismiss
 * gestures now come from the lib — no more touch-responder fights.
 *
 * Public interface is unchanged (visible / onClose / instrumentKey / etc.).
 * Internally we keep a ref to the sheet and use a `visible` → present/dismiss
 * effect so callers don't have to switch to imperative refs.
 *
 * Shows baked default from rangeMap. Saves override via saveRangeOverride.
 * Resets via clearRangeOverride. Validates lo < hi, both in [0,127].
 * Display uses displayMode for note labels but stores fingered MIDI
 * internally.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { rangeMap, transpMap } from '../instruments';
import { saveRangeOverride, clearRangeOverride } from '../storage/rangeOverrides';
import { midiToNoteName } from '../music';
import type { DisplayMode } from '../useAudioEngine';
import { useTheme, H } from '../theme';
import type { ThemePalette } from '../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  instrumentKey: string;
  displayMode: DisplayMode;
  currentRange: [number, number];
  onSaved: (lo: number, hi: number) => void;
  onReset: () => void;
}

function midiLabel(midiFing: number, displayMode: DisplayMode, instrumentKey: string): string {
  const transp = transpMap[instrumentKey] ?? 0;
  const midi = displayMode === 'klingend' ? midiFing + transp : midiFing;
  const { letter, accidental, octave } = midiToNoteName(midi);
  return `${letter}${accidental}${octave}`;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(127, Math.round(v)));
}

function MidiStepper({ label, midiFing, onChange, displayMode, instrumentKey }: {
  label: string; midiFing: number; onChange: (v: number) => void;
  displayMode: DisplayMode; instrumentKey: string;
}) {
  const C = useTheme();
  const sp = useMemo(() => makeStepperStyles(C), [C]);
  return (
    <View style={sp.container}>
      <Text style={sp.label}>{label}</Text>
      <View style={sp.row}>
        <Pressable onPress={() => onChange(clamp(midiFing - 1))} accessibilityRole="button"
          accessibilityLabel={`Decrease ${label}`} style={({ pressed }) => [sp.btn, pressed && sp.btnPressed]}>
          <Text style={sp.btnText}>▼</Text>
        </Pressable>
        <View style={sp.valueBox}>
          <Text style={sp.noteLabel}>{midiLabel(midiFing, displayMode, instrumentKey)}</Text>
          <Text style={sp.midiLabel}>MIDI {midiFing}</Text>
        </View>
        <Pressable onPress={() => onChange(clamp(midiFing + 1))} accessibilityRole="button"
          accessibilityLabel={`Increase ${label}`} style={({ pressed }) => [sp.btn, pressed && sp.btnPressed]}>
          <Text style={sp.btnText}>▲</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStepperStyles(C: ThemePalette) {
  return StyleSheet.create({
    container: { alignItems: 'center', gap: 8 },
    label: { color: C.inkDim, fontSize: 11, letterSpacing: 3, fontWeight: '700' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    btn: { width: H.touchTarget, height: H.touchTarget, borderColor: C.edge, borderWidth: 1, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
    btnPressed: { backgroundColor: C.edge },
    btnText: { color: C.accent, fontSize: 16, fontWeight: '700' },
    valueBox: { alignItems: 'center', minWidth: 84 },
    noteLabel: { color: C.ink, fontSize: 24, letterSpacing: 1, fontVariant: ['tabular-nums'], fontWeight: '600' },
    midiLabel: { color: C.inkDim, fontSize: 11, letterSpacing: 2, fontVariant: ['tabular-nums'], marginTop: 2 },
  });
}

export function RangeEditor({
  visible, onClose, instrumentKey, displayMode, currentRange, onSaved, onReset,
}: Props) {
  const C = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);
  const baked: [number, number] = rangeMap[instrumentKey] ?? [0, 127];
  const [lo, setLo] = useState<number>(currentRange[0]);
  const [hi, setHi] = useState<number>(currentRange[1]);

  // Sheet wiring — preserves the public `visible` prop while the sheet uses
  // imperative present/dismiss.
  const sheetRef = useRef<BottomSheetModal>(null);
  useEffect(() => {
    if (visible) {
      setLo(currentRange[0]);
      setHi(currentRange[1]);
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [visible, currentRange]);

  const renderBackdrop = useCallback((props: BottomSheetBackdropProps) => (
    <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.72} pressBehavior="close" />
  ), []);

  const isValid = lo < hi;
  const isDefault = lo === baked[0] && hi === baked[1];

  const handleSave = useCallback(async () => {
    if (!isValid) return;
    await saveRangeOverride(instrumentKey, lo, hi);
    onSaved(lo, hi);
    onClose();
  }, [instrumentKey, lo, hi, isValid, onSaved, onClose]);

  const handleReset = useCallback(async () => {
    await clearRangeOverride(instrumentKey);
    onReset();
    onClose();
  }, [instrumentKey, onReset, onClose]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      onDismiss={onClose}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: C.inkDim }}
      backgroundStyle={{ backgroundColor: C.face, borderTopLeftRadius: 6, borderTopRightRadius: 6 }}
    >
      <BottomSheetView style={s.sheet}>
        <View style={s.header}>
          <Text style={s.headerTitle}>EDIT RANGE</Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close"
            style={({ pressed }) => [s.closeBtn, pressed && s.closeBtnPressed]}>
            <Text style={s.closeBtnText}>✕</Text>
          </Pressable>
        </View>

        <View style={s.defaultRow}>
          <Text style={s.defaultLabel} numberOfLines={1}>DEFAULT</Text>
          <Text style={s.defaultValue}>
            {midiLabel(baked[0], displayMode, instrumentKey)}
            {'  —  '}
            {midiLabel(baked[1], displayMode, instrumentKey)}
            {'  '}
            <Text style={s.defaultMidi}>({baked[0]}–{baked[1]})</Text>
          </Text>
        </View>

        <View style={s.steppers}>
          <MidiStepper label="LOW" midiFing={lo} onChange={setLo} displayMode={displayMode} instrumentKey={instrumentKey} />
          <MidiStepper label="HIGH" midiFing={hi} onChange={setHi} displayMode={displayMode} instrumentKey={instrumentKey} />
        </View>

        {!isValid && <Text style={s.validationError}>Low must be below high.</Text>}

        <View style={s.actions}>
          <Pressable onPress={handleReset} accessibilityRole="button" accessibilityLabel="Reset to default"
            disabled={isDefault} style={({ pressed }) => [s.resetBtn, pressed && s.resetBtnPressed, isDefault && s.btnDisabled]}>
            <Text style={s.resetBtnText}>RESET TO DEFAULT</Text>
          </Pressable>
          <Pressable onPress={handleSave} accessibilityRole="button" accessibilityLabel="Save range"
            disabled={!isValid} style={({ pressed }) => [s.saveBtn, pressed && s.saveBtnPressed, !isValid && s.btnDisabled]}>
            <Text style={s.saveBtnText}>SAVE</Text>
          </Pressable>
        </View>
      </BottomSheetView>
    </BottomSheetModal>
  );
}

function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
    sheet: { paddingBottom: 32 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomColor: C.edgeSoft, borderBottomWidth: 1 },
    headerTitle: { color: C.ink, fontSize: 13, letterSpacing: 4, fontWeight: '700' },
    closeBtn: { width: H.touchTarget, height: H.touchTarget, alignItems: 'center', justifyContent: 'center', borderColor: C.edge, borderWidth: 1, borderRadius: 4 },
    closeBtnPressed: { backgroundColor: C.edge },
    closeBtnText: { color: C.inkMid, fontSize: 16, fontWeight: '700' },
    defaultRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12, borderBottomColor: C.edgeSoft, borderBottomWidth: 1 },
    // v1.4 wave-11 — L3: flex:0 + numberOfLines instead of fixed width:60.
    // Fixed width clipped on narrow phones; label is always short ("DEFAULT").
    defaultLabel: { color: C.inkDim, fontSize: 10, letterSpacing: 3, fontWeight: '700', flexShrink: 0 },
    defaultValue: { color: C.inkMid, fontSize: 13, letterSpacing: 1, flex: 1 },
    defaultMidi: { color: C.inkDim, fontSize: 11 },
    steppers: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 28, paddingHorizontal: 20 },
    validationError: { color: C.sharp, fontSize: 12, letterSpacing: 1, textAlign: 'center', marginBottom: 8, paddingHorizontal: 20, fontWeight: '700' },
    actions: { flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingTop: 8 },
    resetBtn: { flex: 1, minHeight: H.primaryNav, alignItems: 'center', justifyContent: 'center', borderColor: C.edge, borderWidth: 1, borderRadius: 4 },
    resetBtnPressed: { backgroundColor: C.edge },
    resetBtnText: { color: C.inkMid, fontSize: 12, letterSpacing: 2, fontWeight: '700' },
    saveBtn: { flex: 1, minHeight: H.primaryNav, alignItems: 'center', justifyContent: 'center', backgroundColor: C.accent, borderRadius: 4 },
    saveBtnPressed: { opacity: 0.8 },
    saveBtnText: { color: C.onAccent, fontSize: 13, letterSpacing: 3, fontWeight: '700' },
    btnDisabled: { opacity: 0.35 },
  });
}
