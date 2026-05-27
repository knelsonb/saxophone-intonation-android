/**
 * TopPillNav — v1.3 sub-page nav primitive (§2 of v1.3-metro-redesign).
 *
 * Two pills, equal-flex, fixed minHeight 48dp (HIG touch target). Lives below
 * the persistent TopBar and above the tab body. Used by MetroScreen (METRONOME
 * vs CUSTOMIZATION) and TunerScreen (TUNER vs CUSTOMIZATION).
 *
 * - Active pill = `gainPillActive` (filled accent). Inactive = outlined.
 * - Locked height across sub-page swaps so the row never moves (anti-flicker).
 * - Sub-page state is local to the parent screen, not persisted.
 *
 * Generic over the option-key type so each screen can name its pills with the
 * keys it cares about ("metronome"/"customization", etc).
 */
import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { makeStyles } from '../uiShared';

export interface TopPillNavOption<K extends string> {
  key: K;
  label: string;
}

export interface TopPillNavProps<K extends string> {
  options: ReadonlyArray<TopPillNavOption<K>>;
  active: K;
  onChange: (key: K) => void;
}

export function TopPillNav<K extends string>({ options, active, onChange }: TopPillNavProps<K>) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  return (
    <View style={styles.topPillNav_row} accessibilityRole="tablist">
      {options.map((opt) => {
        const selected = opt.key === active;
        return (
          <Pressable
            key={opt.key}
            onPress={() => {
              if (selected) return; // tapping active pill is a no-op
              onChange(opt.key);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={opt.label}
            style={({ pressed }) => [
              styles.topPillNav_pill,
              selected && styles.topPillNav_pillActive,
              pressed && styles.topPillNav_pillPressed,
            ]}
          >
            <Text style={[styles.topPillNav_pillText, selected && styles.topPillNav_pillTextActive]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
