/**
 * CustomTimeSigPanel — v1.2 inline panel below the METRO time-sig pill row,
 * visible only when CUSTOM is the active pill (§3, §17.R4, §16.U14).
 *
 * Layout: one horizontal row, NUM ± [TextInput] ± then DEN ± [TextInput] ± .
 * Reuses `metroBpmFlankStepper` styling for ± so the affordance matches the
 * BPM stepper above. New `customTimeSig_*` keys handle the text-entry field
 * and row spacing only.
 *
 * Guardrails (per §17.R4):
 *   - Numerator clamped to [1, MAX_NUMERATOR]. ± walks ±1, TextInput accepts
 *     1–2 digits, invalid input reverts silently on blur (no toast).
 *   - Denominator constrained to the ladder {2, 4, 8, 16, 32}. ± walks the
 *     ladder; text entry snaps to nearest on blur.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import { makeStyles } from '../uiShared';
import { MAX_NUMERATOR, MIN_NUMERATOR } from '../useMetronome';

const DENOMINATOR_LADDER: readonly (2 | 4 | 8 | 16 | 32)[] = [2, 4, 8, 16, 32];

/** Round `d` to the closest member of the denominator ladder. */
function snapDen(d: number): 2 | 4 | 8 | 16 | 32 {
  let best: 2 | 4 | 8 | 16 | 32 = 4;
  let bestDist = Infinity;
  for (const v of DENOMINATOR_LADDER) {
    const dist = Math.abs(v - d);
    if (dist < bestDist) { best = v; bestDist = dist; }
  }
  return best;
}

function clampNum(n: number): number {
  if (!Number.isFinite(n)) return MIN_NUMERATOR;
  return Math.max(MIN_NUMERATOR, Math.min(MAX_NUMERATOR, Math.trunc(n)));
}

export interface CustomTimeSigPanelProps {
  num: number;
  den: 2 | 4 | 8 | 16 | 32;
  onChangeNum: (n: number) => void;
  onChangeDen: (d: 2 | 4 | 8 | 16 | 32) => void;
}

export function CustomTimeSigPanel({ num, den, onChangeNum, onChangeDen }: CustomTimeSigPanelProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);

  // v1.2 — local TextInput buffers so the user can type "10" without the
  // intermediate "1" forcing a clamp/commit. Commit on blur or submit.
  const [numText, setNumText] = useState<string>(String(num));
  const [denText, setDenText] = useState<string>(String(den));

  // Stay in sync if the parent moves the value (e.g. ± buttons).
  useEffect(() => { setNumText(String(num)); }, [num]);
  useEffect(() => { setDenText(String(den)); }, [den]);

  const denIdx = DENOMINATOR_LADDER.indexOf(den);

  const commitNum = () => {
    const parsed = Number(numText);
    if (!Number.isFinite(parsed) || parsed < MIN_NUMERATOR || parsed > MAX_NUMERATOR) {
      // Silent revert — no toast (§17.R4).
      setNumText(String(num));
      return;
    }
    const clamped = clampNum(parsed);
    setNumText(String(clamped));
    if (clamped !== num) onChangeNum(clamped);
  };

  const commitDen = () => {
    const parsed = Number(denText);
    if (!Number.isFinite(parsed)) {
      setDenText(String(den));
      return;
    }
    // Snap to nearest ladder member on blur (§17.R4).
    const snapped = snapDen(parsed);
    setDenText(String(snapped));
    if (snapped !== den) onChangeDen(snapped);
  };

  return (
    <View style={styles.customTimeSig_row}>
      {/* NUM cluster */}
      <View style={styles.customTimeSig_cluster}>
        <Text style={styles.customTimeSig_label}>NUM</Text>
        <Pressable
          onPress={() => onChangeNum(clampNum(num - 1))}
          accessibilityRole="button"
          accessibilityLabel="Decrease numerator"
          style={({ pressed }) => [styles.metroBpmFlankStepper, pressed && styles.metroBpmFlankStepperPressed]}
        >
          <Text style={styles.metroBpmFlankStepperText}>−</Text>
        </Pressable>
        <TextInput
          value={numText}
          onChangeText={setNumText}
          onBlur={commitNum}
          onSubmitEditing={commitNum}
          keyboardType="number-pad"
          maxLength={2}
          selectTextOnFocus
          accessibilityLabel="Numerator"
          style={styles.customTimeSig_input}
          placeholderTextColor={C.inkDim}
        />
        <Pressable
          onPress={() => onChangeNum(clampNum(num + 1))}
          accessibilityRole="button"
          accessibilityLabel="Increase numerator"
          style={({ pressed }) => [styles.metroBpmFlankStepper, pressed && styles.metroBpmFlankStepperPressed]}
        >
          <Text style={styles.metroBpmFlankStepperText}>+</Text>
        </Pressable>
      </View>

      {/* DEN cluster */}
      <View style={styles.customTimeSig_cluster}>
        <Text style={styles.customTimeSig_label}>DEN</Text>
        <Pressable
          onPress={() => {
            if (denIdx > 0) onChangeDen(DENOMINATOR_LADDER[denIdx - 1]);
          }}
          accessibilityRole="button"
          accessibilityLabel="Smaller denominator"
          style={({ pressed }) => [styles.metroBpmFlankStepper, pressed && styles.metroBpmFlankStepperPressed]}
        >
          <Text style={styles.metroBpmFlankStepperText}>−</Text>
        </Pressable>
        <TextInput
          value={denText}
          onChangeText={setDenText}
          onBlur={commitDen}
          onSubmitEditing={commitDen}
          keyboardType="number-pad"
          maxLength={2}
          selectTextOnFocus
          accessibilityLabel="Denominator"
          style={styles.customTimeSig_input}
          placeholderTextColor={C.inkDim}
        />
        <Pressable
          onPress={() => {
            if (denIdx >= 0 && denIdx < DENOMINATOR_LADDER.length - 1) {
              onChangeDen(DENOMINATOR_LADDER[denIdx + 1]);
            }
          }}
          accessibilityRole="button"
          accessibilityLabel="Larger denominator"
          style={({ pressed }) => [styles.metroBpmFlankStepper, pressed && styles.metroBpmFlankStepperPressed]}
        >
          <Text style={styles.metroBpmFlankStepperText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Height of the inline panel (used by the invisible spacer on the METRO
 *  screen to reserve identical space when CUSTOM is NOT active — keeps the
 *  layout below from shifting on toggle, per §10 + §16.U6). */
export const CUSTOM_TIME_SIG_PANEL_HEIGHT = 60;
