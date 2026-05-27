/**
 * TabBar — bottom navigation. Four tabs, accent-coloured active state.
 *
 * Sits at the bottom of every screen. Active tab gets the amber accent text
 * + a 2dp underline; inactive tabs are inkMid. Tap target is ≥H.primaryNav
 * (56 dp) so it stays usable while practicing.
 *
 * Switching tabs is just a React re-render — no animation. The cost of a
 * transition crossfade on a 60 fps display would compete with the live audio
 * tick; keep this loop tight.
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, H } from '../theme';
import type { ThemePalette } from '../theme';

export type TabKey = 'tuner' | 'metro' | 'deck' | 'setup';

const TABS: { key: TabKey; label: string; a11y: string }[] = [
  { key: 'tuner', label: 'TUNER', a11y: 'Tuner tab — the main pitch readout.' },
  { key: 'metro', label: 'METRO', a11y: 'Metronome tab — tempo and beat controls.' },
  { key: 'deck',  label: 'DECK',  a11y: 'Deck tab — record and play back what comes through the mic.' },
  { key: 'setup', label: 'SETUP', a11y: 'Setup tab — settings, theme, horn name, and more.' },
];

export interface TabBarProps {
  active: TabKey;
  onChange: (next: TabKey) => void;
}

export function TabBar({ active, onChange }: TabBarProps) {
  const C = useTheme();
  const insets = useSafeAreaInsets();
  // Safe-area inset for the bottom gesture pill / nav bar, plus a small visual
  // breathing-room minimum so even on devices with zero reported inset the
  // tabs don't kiss the screen edge.
  const bottomPad = Math.max(8, insets.bottom);
  const styles = useMemo(() => makeStyles(C, bottomPad), [C, bottomPad]);
  return (
    <View style={styles.row} accessibilityRole="tablist">
      {TABS.map((t) => {
        const isActive = t.key === active;
        return (
          <Pressable
            key={t.key}
            onPress={() => onChange(t.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={t.a11y}
            style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
          >
            <Text style={[styles.label, isActive && styles.labelActive]}>{t.label}</Text>
            <View style={[styles.underline, isActive && styles.underlineActive]} />
          </Pressable>
        );
      })}
    </View>
  );
}

function makeStyles(C: ThemePalette, bottomPad: number) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      borderTopColor: C.edge,
      borderTopWidth: 1,
      backgroundColor: C.face,
      paddingBottom: bottomPad,
    },
    tab: {
      flex: 1,
      minHeight: H.primaryNav,
      paddingVertical: 8,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    tabPressed: { backgroundColor: C.edge },
    label: {
      color: C.inkMid,
      fontSize: 12,
      letterSpacing: 3,
      fontWeight: '700',
    },
    labelActive: { color: C.accent },
    underline: {
      width: '60%',
      height: 2,
      backgroundColor: 'transparent',
      borderRadius: 1,
    },
    underlineActive: { backgroundColor: C.accent },
  });
}
