/**
 * ProfileSlotGrid — v1.3 METRONOME sub-page bottom row (§3).
 *
 * 2 rows × 4 columns:
 *   - Row 1: preset time-sig pills (2/4 3/4 4/4 6/8).
 *   - Row 2: user profile slot pills (User 1..User 4).
 *
 * Replaces the v1.2 5-pill row including the CUSTOM pill — a custom time-sig
 * is now reached by tapping a User slot whose profile uses a custom signature.
 *
 * Highlight rules (per §3 + §11.Q11 + F1 ruling):
 *   - When `activeKind === 'profile'`, only the matching User pill lights up;
 *     preset pills stay outlined even if the slot's resolved time-sig matches.
 *   - When `activeKind === 'preset'`, only the matching preset pill lights up.
 *
 * Touch targets ≥48dp via metroSigPill height. Names truncate single-line so
 * a long "Brubeck 5/4 etude" doesn't blow up the row.
 */
import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { makeStyles } from '../uiShared';
import type { TimeSigPreset } from '../useMetronome';

export interface ProfileSlotMeta {
  slot: 1 | 2 | 3 | 4;
  /** User-editable display name (falls back to default "User N" upstream). */
  name: string;
}

export interface ProfileSlotGridProps {
  presets: ReadonlyArray<TimeSigPreset>;
  profiles: ReadonlyArray<ProfileSlotMeta>;
  /** Which kind of pill is the current selection source. */
  activeKind: 'preset' | 'profile';
  /**
   * Active key — string for preset, number 1..4 for profile slot, or null
   * when nothing should be lit (e.g. legacy custom time-sig with no profile
   * loaded). v1.3.2 Sauron W3 — replaces the prior "fall back to 4/4"
   * false-positive that lit the 4/4 pill for custom sigs.
   */
  activeKey: TimeSigPreset | 1 | 2 | 3 | 4 | null;
  onTapPreset: (p: TimeSigPreset) => void;
  onTapProfile: (slot: 1 | 2 | 3 | 4) => void;
}

export function ProfileSlotGrid({
  presets,
  profiles,
  activeKind,
  activeKey,
  onTapPreset,
  onTapProfile,
}: ProfileSlotGridProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  void C;

  return (
    <View style={styles.profileSlot_grid}>
      {/* Row 1 — presets */}
      <View style={styles.profileSlot_row}>
        {presets.map((p) => {
          const selected = activeKind === 'preset' && activeKey === p;
          return (
            <Pressable
              key={`preset-${p}`}
              onPress={() => onTapPreset(p)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`Time signature ${p}`}
              style={({ pressed }) => [
                styles.profileSlot_pill,
                styles.metroSigPill,
                selected && styles.metroSigPillActive,
                pressed && styles.gainPillPressed,
              ]}
            >
              <Text
                style={[styles.metroSigPillText, selected && styles.metroSigPillTextActive]}
                numberOfLines={1}
              >
                {p}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Row 2 — user profile slots */}
      <View style={styles.profileSlot_row}>
        {profiles.map((meta) => {
          const selected = activeKind === 'profile' && activeKey === meta.slot;
          const label = meta.name.length > 0 ? meta.name : `User ${meta.slot}`;
          return (
            <Pressable
              key={`profile-${meta.slot}`}
              onPress={() => onTapProfile(meta.slot)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`User slot ${meta.slot}, ${label}`}
              style={({ pressed }) => [
                styles.profileSlot_pill,
                styles.metroSigPill,
                styles.profileSlot_pillUser,
                selected && styles.metroSigPillActive,
                pressed && styles.gainPillPressed,
              ]}
            >
              <Text
                style={[styles.metroSigPillText, selected && styles.metroSigPillTextActive]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
