/**
 * MetroScreen — the METRO tab. Tempo control + tap tempo + time signature +
 * START/STOP. Big BPM readout at the top, a visualisation strip below it
 * (selected via `metroStyle`), pills for time signature, ± steppers (±1 and
 * ±5), TAP tempo, and a primary START/STOP button at the bottom.
 *
 * **Layout rule (hard):** fits on one screen — no ScrollView. If a new
 * control needs space, the visualisation height has to compress or the
 * control belongs in SETUP. Don't make the user scroll a tempo control.
 *
 * Audio + visual are dispatched together by `useMetronome` so what you see
 * matches what you hear within a single render tick.
 */
import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { makeStyles } from '../uiShared';
import type { MetronomeState, TimeSig } from '../useMetronome';
import { PulseDisplay } from '../components/metroStyles/PulseDisplay';
import { FlashDisplay } from '../components/metroStyles/FlashDisplay';
import { PendulumDisplay } from '../components/metroStyles/PendulumDisplay';

const TIME_SIGS: TimeSig[] = ['2/4', '3/4', '4/4', '6/8'];

export interface MetroScreenProps {
  metro: MetronomeState;
  metroStyle: 'pulse' | 'pendulum' | 'flash';
  /** Selected output route — drives the BT-latency warning banner. */
  outputRoute: 'speaker' | 'wired' | 'bluetooth';
}

export function MetroScreen({ metro, metroStyle, outputRoute }: MetroScreenProps) {
  const C = useTheme();
  const styles = useMemo(() => makeStyles(C), [C]);
  void C;

  const bpmAccessible = `Tempo ${metro.bpm} beats per minute, ${metro.timeSig}`;

  return (
    <View style={{ flex: 1 }}>
      {/* v0.9.8 — `screenHeader` ("METRO" + subtitle) removed. The bottom tab
          bar already labels this screen; the duplicate title stole ~48dp
          for zero information. */}

      {/* Bluetooth A2DP buffering is fundamentally late (~200 ms). The hook
          compensates by pre-rolling the click, but a 200 ms lead is enough
          that the visual still feels behind the audio if BPM is fast. Warn
          the user once so they're not surprised — they can switch to wired
          or speaker if they need tight sync. */}
      {outputRoute === 'bluetooth' && (
        <View style={styles.silenceBanner} accessibilityRole="alert" accessibilityLabel="Bluetooth output is latent. Click may feel slightly behind the visual.">
          <Text style={styles.silenceBannerText}>
            <Text style={styles.silenceBannerBold}>Bluetooth output is latent.</Text>
            {'  '}Wired or speaker keeps the click tight with the visual.
          </Text>
        </View>
      )}

      {/* BPM numeral FLANKED by stepper buttons. v0.9.8 — previously the
          steppers sat on a separate row underneath the BPM, intercepting
          the eye path between BPM and the beat visualization. */}
      <View style={styles.metroBpmRow}>
        <Pressable
          onPress={() => metro.bumpBpm(-5)}
          accessibilityRole="button"
          accessibilityLabel="Decrease tempo by 5 BPM"
          style={({ pressed }) => [styles.metroBpmFlankStepper, pressed && styles.metroBpmFlankStepperPressed]}
        >
          <Text style={styles.metroBpmFlankStepperText}>−5</Text>
        </Pressable>
        <Pressable
          onPress={() => metro.bumpBpm(-1)}
          accessibilityRole="button"
          accessibilityLabel="Decrease tempo by 1 BPM"
          style={({ pressed }) => [styles.metroBpmFlankStepper, styles.metroBpmFlankStepperAccent, pressed && styles.metroBpmFlankStepperPressed]}
        >
          <Text style={[styles.metroBpmFlankStepperText, styles.metroBpmFlankStepperTextAccent]}>−1</Text>
        </Pressable>
        <Text
          style={styles.metroBpmDisplay}
          numberOfLines={1}
          accessibilityRole="text"
          accessibilityLabel={bpmAccessible}
        >
          {metro.bpm}
        </Text>
        <Pressable
          onPress={() => metro.bumpBpm(1)}
          accessibilityRole="button"
          accessibilityLabel="Increase tempo by 1 BPM"
          style={({ pressed }) => [styles.metroBpmFlankStepper, styles.metroBpmFlankStepperAccent, pressed && styles.metroBpmFlankStepperPressed]}
        >
          <Text style={[styles.metroBpmFlankStepperText, styles.metroBpmFlankStepperTextAccent]}>+1</Text>
        </Pressable>
        <Pressable
          onPress={() => metro.bumpBpm(5)}
          accessibilityRole="button"
          accessibilityLabel="Increase tempo by 5 BPM"
          style={({ pressed }) => [styles.metroBpmFlankStepper, pressed && styles.metroBpmFlankStepperPressed]}
        >
          <Text style={styles.metroBpmFlankStepperText}>+5</Text>
        </Pressable>
      </View>
      {/* Visualisation wrapped in flex:1 so any future content variance is
          absorbed by whitespace rather than clipping the START button below.
          PULSE = dots+throb, FLASH = full-area colour flash,
          PENDULUM = vintage mechanical swing. */}
      <View style={{ flex: 1, justifyContent: 'center' }}>
        {metroStyle === 'flash' ? (
          <FlashDisplay
            running={metro.running}
            beat={metro.beat}
            pulse={metro.pulse}
            bpm={metro.bpm}
            timeSig={metro.timeSig}
          />
        ) : metroStyle === 'pendulum' ? (
          <PendulumDisplay
            running={metro.running}
            beat={metro.beat}
            pulse={metro.pulse}
            bpm={metro.bpm}
          />
        ) : (
          <PulseDisplay
            running={metro.running}
            beat={metro.beat}
            pulse={metro.pulse}
            timeSig={metro.timeSig}
          />
        )}
      </View>

      {/* Time signature pills. The "TIME SIGNATURE" label above the row was
          removed in v0.9.6 — "2/4 3/4 4/4 6/8" speaks for itself. */}
      <View style={styles.metroTimeSigRow}>
        {TIME_SIGS.map((s) => {
          const sel = metro.timeSig === s;
          return (
            <Pressable
              key={s}
              onPress={() => metro.setTimeSig(s)}
              accessibilityRole="button"
              accessibilityState={{ selected: sel }}
              accessibilityLabel={`Time signature ${s}`}
              style={({ pressed }) => [styles.metroSigPill, sel && styles.metroSigPillActive, pressed && styles.gainPillPressed]}
            >
              <Text style={[styles.metroSigPillText, sel && styles.metroSigPillTextActive]}>{s}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Tap tempo. The hint line ("Tap with the beat — average of last 4
          taps") was killed in v0.9.6 — accessibilityLabel still carries the
          info, but the visible hint stole ~14dp from a tight budget. */}
      <Pressable
        onPress={() => metro.registerTap()}
        accessibilityRole="button"
        accessibilityLabel="Tap tempo. Tap on each beat, the metronome sets BPM from the average."
        style={({ pressed }) => [styles.metroTap, pressed && styles.metroTapPressed]}
      >
        <Text style={styles.metroTapText}>TAP</Text>
      </Pressable>

      {/* Primary START / STOP */}
      <Pressable
        onPress={metro.toggle}
        accessibilityRole="button"
        accessibilityLabel={metro.running ? 'Stop metronome' : 'Start metronome'}
        style={({ pressed }) => [
          styles.metroPrimary,
          metro.running ? styles.metroPrimaryActive : styles.metroPrimaryIdle,
          pressed && styles.metroPrimaryPressed,
        ]}
      >
        <Text style={[styles.metroPrimaryText, metro.running ? styles.metroPrimaryTextActive : styles.metroPrimaryTextIdle]}>
          {metro.running ? 'STOP' : 'START'}
        </Text>
      </Pressable>
    </View>
  );
}
