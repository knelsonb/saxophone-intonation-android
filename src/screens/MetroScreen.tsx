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
import { BPM_MIN, BPM_MAX } from '../useMetronome';
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
      <View style={styles.screenHeader}>
        <Text style={styles.screenTitle}>METRO</Text>
        <Text style={styles.screenSubtitle}>Tempo, tap, time signature, start</Text>
      </View>

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

      {/* BPM display */}
      <View style={styles.metroBpmRow}>
        <Text
          style={styles.metroBpmDisplay}
          numberOfLines={1}
          accessibilityRole="text"
          accessibilityLabel={bpmAccessible}
        >
          {metro.bpm}
        </Text>
      </View>
      <Text style={[styles.metroBpmUnit, { textAlign: 'center' }]}>BEATS / MIN</Text>

      {/* BPM ± steppers */}
      <View style={styles.metroBpmStepRow}>
        <Pressable
          onPress={() => metro.bumpBpm(-5)}
          accessibilityRole="button"
          accessibilityLabel="Decrease tempo by 5 BPM"
          style={({ pressed }) => [styles.metroStepBtn, pressed && styles.metroStepBtnPressed]}
        >
          <Text style={styles.metroStepBtnText}>−5</Text>
        </Pressable>
        <Pressable
          onPress={() => metro.bumpBpm(-1)}
          accessibilityRole="button"
          accessibilityLabel="Decrease tempo by 1 BPM"
          style={({ pressed }) => [styles.metroStepBtn, styles.metroStepBtnAccent, pressed && styles.metroStepBtnPressed]}
        >
          <Text style={[styles.metroStepBtnText, styles.metroStepBtnTextAccent]}>−1</Text>
        </Pressable>
        <Pressable
          onPress={() => metro.bumpBpm(1)}
          accessibilityRole="button"
          accessibilityLabel="Increase tempo by 1 BPM"
          style={({ pressed }) => [styles.metroStepBtn, styles.metroStepBtnAccent, pressed && styles.metroStepBtnPressed]}
        >
          <Text style={[styles.metroStepBtnText, styles.metroStepBtnTextAccent]}>+1</Text>
        </Pressable>
        <Pressable
          onPress={() => metro.bumpBpm(5)}
          accessibilityRole="button"
          accessibilityLabel="Increase tempo by 5 BPM"
          style={({ pressed }) => [styles.metroStepBtn, pressed && styles.metroStepBtnPressed]}
        >
          <Text style={styles.metroStepBtnText}>+5</Text>
        </Pressable>
      </View>
      <Text style={[styles.metroBpmUnit, { textAlign: 'center', marginTop: 6 }]}>
        Range {BPM_MIN}–{BPM_MAX}
      </Text>

      {/* The chosen visualisation. PULSE = dots+throb, FLASH = full-area
          colour flash, PENDULUM = deferred to a follow-up release. */}
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

      {/* Time signature pills */}
      <Text style={styles.metroLabel}>TIME SIGNATURE</Text>
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

      {/* Tap tempo */}
      <Pressable
        onPress={() => metro.registerTap()}
        accessibilityRole="button"
        accessibilityLabel="Tap tempo. Tap on each beat, the metronome sets BPM from the average."
        style={({ pressed }) => [styles.metroTap, pressed && styles.metroTapPressed]}
      >
        <Text style={styles.metroTapText}>TAP</Text>
        <Text style={styles.metroTapHint}>Tap with the beat — average of last 4 taps</Text>
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
