/**
 * LedRowDisplay — Boss TU-3 / Korg TM-60 style stage-tuner LED row.
 *
 * 11 dots: index 0 is far flat, 5 is centre/in-tune, 10 is far sharp.
 *
 * v1.3.2 — the LED row is now a METER, not a single-LED indicator. Bands
 * (LED_ZONE_BANDS) map cents → which LEDs light + which color. A user
 * watching the row sees how far AND which direction they're off without
 * having to read the cents number.
 *
 *  |c| ≤ 3¢ ........... green centre only
 *  3 < |c| ≤ 5¢ ...... green centre + adjacent yellow (side of error)
 *  5 < |c| ≤ 7¢ ...... yellow adjacent only (centre OFF)
 *  7 < |c| ≤ 9¢ ...... yellow adjacent + red next-out
 *  |c| > 9¢ .......... red LED on side of error, position scales with magnitude
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTheme } from '../../theme';
import type { ThemePalette } from '../../theme';
import type { NoteDisplay } from '../../tunerWidgets';

const LED_COUNT = 11;
const LED_RANGE_CENTS = 25;
// v1.4 wave-10 — L4: base sizes for wide screens (tablet / landscape).
// Narrow phones (< 500 dp) get smaller LEDs so 11 × (LED+gap) fits in ~320 dp.
const LED_DIAMETER_WIDE = 24;
const LED_GAP_WIDE = 18;
const LED_DIAMETER_NARROW = 16;
const LED_GAP_NARROW = 8;
// Back-compat alias — makeStyles now receives dynamic sizes from the hook.
const LED_DIAMETER = LED_DIAMETER_WIDE;
const LED_GAP = LED_GAP_WIDE;
const CENTER_INDEX = Math.floor(LED_COUNT / 2); // 5

// v1.3.2 zone-map bands. Each band lists the LED-color decisions for a
// |cents| range. A future revision can tweak these without touching the
// rendering logic. `adjOffset` = how many LEDs out from centre on the
// side of error (0 = centre itself).
export const LED_ZONE_BANDS = [
  // |c| ≤ 3¢ : centre only, green.
  { maxCents: 3,  lit: [{ adjOffset: 0, color: 'green' as const }] },
  // 3 < |c| ≤ 5¢ : centre green + 1 yellow on side of error.
  { maxCents: 5,  lit: [
      { adjOffset: 0, color: 'green'  as const },
      { adjOffset: 1, color: 'yellow' as const },
  ] },
  // 5 < |c| ≤ 7¢ : 1 yellow on side of error (centre OFF).
  { maxCents: 7,  lit: [{ adjOffset: 1, color: 'yellow' as const }] },
  // 7 < |c| ≤ 9¢ : 1 yellow + 1 red on side of error.
  { maxCents: 9,  lit: [
      { adjOffset: 1, color: 'yellow' as const },
      { adjOffset: 2, color: 'red'    as const },
  ] },
  // |c| > 9¢ : red at scaled offset (handled separately — falls through).
] as const;

type LedColor = 'green' | 'yellow' | 'red' | 'off';

/**
 * Map cents → LED color per index. Returns an array of LED_COUNT colors,
 * 'off' for unlit. Direction: flat (c < 0) lights LEDs LEFT of centre,
 * sharp (c > 0) lights LEDs RIGHT.
 */
function centsToLedColors(c: number): LedColor[] {
  const out: LedColor[] = Array.from({ length: LED_COUNT }, () => 'off');
  const abs = Math.abs(c);
  const sign = c < 0 ? -1 : 1; // flat = left (-), sharp = right (+); zero falls into centre band

  for (const band of LED_ZONE_BANDS) {
    if (abs <= band.maxCents) {
      for (const { adjOffset, color } of band.lit) {
        const idx = CENTER_INDEX + sign * adjOffset;
        if (idx >= 0 && idx < LED_COUNT) out[idx] = color;
      }
      return out;
    }
  }

  // |c| > 9¢ — past the band table. Light a red LED whose offset from
  // centre scales with magnitude. 10¢ → offset 3, then each additional
  // ~5¢ pushes one LED further out, capped at the edge (offset CENTER_INDEX).
  const offset = Math.min(CENTER_INDEX, 3 + Math.floor((abs - 10) / 5));
  const idx = CENTER_INDEX + sign * offset;
  if (idx >= 0 && idx < LED_COUNT) out[idx] = 'red';
  return out;
}

export interface LedRowDisplayProps {
  noteDisplay: NoteDisplay | null;
  freqHz: number | null;
  noteFontSize: number;
  isOutOfRange: boolean;
}

export function LedRowDisplay({ noteDisplay, freqHz, noteFontSize, isOutOfRange }: LedRowDisplayProps) {
  const C = useTheme();
  // v1.4 wave-10 — L4: responsive LED sizing. On screens narrower than 500 dp
  // (common 360 dp portrait phones) the original 24/18 constants overflow the
  // container. Below the threshold use 16/8 → 11×24 = 264 dp which fits easily.
  // Above 500 dp (tablet, landscape) the original sizes are restored.
  const { width: screenWidth } = useWindowDimensions();
  const ledDiameter = screenWidth < 500 ? LED_DIAMETER_NARROW : LED_DIAMETER_WIDE;
  const ledGap      = screenWidth < 500 ? LED_GAP_NARROW      : LED_GAP_WIDE;
  const styles = useMemo(() => makeStyles(C, ledDiameter, ledGap), [C, ledDiameter, ledGap]);

  const hasNote = noteDisplay !== null;
  const oor = isOutOfRange && hasNote;
  const cents = noteDisplay?.cents ?? 0;

  // v1.3.2 — color per LED via zone-map. When no note or OOR, everything off.
  const ledColors = useMemo<LedColor[]>(() => {
    if (!hasNote || oor) return Array.from({ length: LED_COUNT }, () => 'off');
    return centsToLedColors(cents);
  }, [hasNote, oor, cents]);

  // 50ms fade animation per LED. Each slot has its own Animated value
  // ramping 0↔1; the LED's color is the prop, opacity is animated.
  const ledAnimsRef = useRef<Animated.Value[]>(
    Array.from({ length: LED_COUNT }, () => new Animated.Value(0)),
  );
  // v1.3.4 — per-LED animation refs. Fast-pitch trills can update ledColors
  // faster than each 50ms tween completes; without stopping the previous
  // Animated.timing() before starting a new one, multiple competing tweens
  // interpolate the same Animated.Value → jitter and stale opacity values.
  // Each slot tracks its own in-flight CompositeAnimation so we can stop()
  // it before kicking off the replacement. Mirrors the pattern used in
  // PendulumDisplay (animRef.current?.stop() before creating the next tween).
  const animRefsRef = useRef<(Animated.CompositeAnimation | null)[]>(
    Array.from({ length: LED_COUNT }, () => null),
  );
  useEffect(() => {
    ledAnimsRef.current.forEach((v, i) => {
      const target = ledColors[i] !== 'off' ? 1 : 0;
      animRefsRef.current[i]?.stop();
      const anim = Animated.timing(v, { toValue: target, duration: 50, useNativeDriver: false });
      animRefsRef.current[i] = anim;
      anim.start();
    });
    // v1.4 wave-7 — T4: stop in-flight animations on unmount so they don't
    // continue ticking after the component is gone. Mirrors PendulumDisplay's
    // animRef.current?.stop() cleanup pattern.
    return () => {
      for (const a of animRefsRef.current) {
        a?.stop();
      }
      animRefsRef.current = animRefsRef.current.map(() => null);
    };
  }, [ledColors]);

  const letter = noteDisplay?.letter ?? '—';
  const accidental = noteDisplay?.accidental ?? '';
  const octave = noteDisplay?.octave;
  const hzText = freqHz !== null ? freqHz.toFixed(1) : '— — —';
  const centsText = noteDisplay
    ? `${cents >= 0 ? '+' : ''}${cents.toFixed(noteDisplay.precision === 1.0 ? 0 : 1)}`
    : '+00';

  const ledColorToHex = (lc: LedColor): string => {
    switch (lc) {
      case 'green':  return C.inTune;
      case 'yellow': return C.accent;
      case 'red':    return C.sharp;
      case 'off':    return C.inkVeryDim; // hidden via opacity anyway
    }
  };

  // Big cents readout above the LEDs.
  const centsColor =
    !hasNote || oor   ? C.inkVeryDim :
    Math.abs(cents) <= 5  ? C.inTune :
    Math.abs(cents) <= 15 ? C.accent :
                            C.sharp;

  return (
    <View
      style={styles.root}
      accessibilityRole="image"
      accessibilityLabel={
        hasNote
          ? `LED tuner: ${letter}${accidental}${octave}, ${cents >= 0 ? '+' : ''}${cents.toFixed(1)} cents${oor ? ', out of range' : ''}.`
          : 'LED tuner: waiting for a note.'
      }
    >
      <View style={styles.bigNoteRow}>
        <Text style={[styles.bigNote, { fontSize: noteFontSize }, !hasNote && styles.bigNoteDim]} numberOfLines={1}>
          {letter}
          <Text style={styles.bigAccidental}>{accidental}</Text>
          {octave !== undefined && <Text style={styles.bigOctave}>{'  '}{octave}</Text>}
        </Text>
      </View>

      <Text style={[styles.cents, { color: centsColor }]}>
        {centsText}<Text style={styles.centsUnit}> ¢</Text>
      </Text>

      {/* The LED row. v1.3.2 — each slot stacks an always-visible "well"
          outline + the lit LED (opacity-animated). The well preserves
          layout so transitions never shift positions (anti-flicker). */}
      <View style={styles.row}>
        {ledAnimsRef.current.map((v, i) => (
          <View key={i} style={styles.ledSlot}>
            <View style={styles.ledWell} />
            <Animated.View
              style={[
                styles.led,
                {
                  backgroundColor: ledColorToHex(ledColors[i]),
                  opacity: v,
                },
              ]}
            />
          </View>
        ))}
      </View>

      <View style={styles.baselineWrap}>
        <View style={styles.baseline} />
        <View style={styles.baselineCenterTick} />
      </View>

      <View style={styles.legendRow}>
        <Text style={styles.legend}>−25¢</Text>
        <Text style={styles.legend}>0¢</Text>
        <Text style={styles.legend}>+25¢</Text>
      </View>

      <Text style={styles.hz}>{hzText} Hz</Text>
    </View>
  );
}

// v1.4 wave-10 — L4: accepts dynamic ledDiameter/ledGap computed from screen width.
function makeStyles(C: ThemePalette, ledDiameter: number, ledGap: number) {
  return StyleSheet.create({
    // Own our width — parent `centerPortrait` no longer cross-axis-centers,
    // so the root must stretch and self-center to match the legend's max.
    root: {
      width: '100%',
      alignSelf: 'center',
      maxWidth: ledDiameter * LED_COUNT + ledGap * (LED_COUNT - 1),
      alignItems: 'center',
      paddingHorizontal: 8,
    },
    bigNoteRow: { flexDirection: 'row', justifyContent: 'center' },
    bigNote: {
      color: C.ink,
      fontWeight: '300',
      letterSpacing: -2,
      fontVariant: ['tabular-nums'],
      textAlign: 'center',
    },
    bigNoteDim: { color: C.inkDim },
    bigAccidental: { color: C.inkMid, fontSize: 56 },
    bigOctave: { color: C.inkDim, fontSize: 24 },
    cents: { fontSize: 28, fontWeight: '700', letterSpacing: 1, fontVariant: ['tabular-nums'], marginTop: 4, marginBottom: 12 },
    centsUnit: { fontSize: 16, fontWeight: '400', color: C.inkDim },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: ledGap,
      marginTop: 4,
    },
    ledSlot: {
      width: ledDiameter,
      height: ledDiameter,
      position: 'relative',
    },
    ledWell: {
      position: 'absolute',
      width: ledDiameter,
      height: ledDiameter,
      borderRadius: ledDiameter / 2,
      borderColor: C.edge,
      borderWidth: 1,
      backgroundColor: C.bg,
    },
    led: {
      position: 'absolute',
      width: ledDiameter,
      height: ledDiameter,
      borderRadius: ledDiameter / 2,
    },
    baselineWrap: {
      width: '100%',
      maxWidth: ledDiameter * LED_COUNT + ledGap * (LED_COUNT - 1),
      marginTop: 8,
      height: 6,
      position: 'relative',
    },
    baseline: {
      position: 'absolute',
      left: '5%', right: '5%',
      top: 2,
      height: 1,
      backgroundColor: C.edge,
    },
    baselineCenterTick: {
      position: 'absolute',
      left: '50%',
      top: 0,
      width: 2,
      height: 6,
      marginLeft: -1,
      backgroundColor: C.inkMid,
    },
    legendRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: '100%',
      maxWidth: ledDiameter * LED_COUNT + ledGap * (LED_COUNT - 1),
      marginTop: 6,
      paddingHorizontal: 4,
    },
    legend: { color: C.inkDim, fontSize: 10, letterSpacing: 2, fontWeight: '600' },
    hz: { color: C.inkMid, fontSize: 14, letterSpacing: 2, marginTop: 8, fontVariant: ['tabular-nums'] },
  });
}
