import { EventSubscription, NativeModule, requireNativeModule } from 'expo-modules-core';

import type {
  RawAudioOutput,
  SynthAudioTimestamp,
  SynthCommandFiredEvent,
  SynthErrorEvent,
  SynthReadyEvent,
  SynthRouteChangedEvent,
  SynthShadowBeatEvent,
  SynthUnderrunEvent,
} from './RawAudioOutput.types';

// ---------------------------------------------------------------------------
// Native module declaration
// ---------------------------------------------------------------------------

type RawAudioOutputEvents = {
  ready: (payload: SynthReadyEvent) => void;
  audioOutputUnderrun: (payload: SynthUnderrunEvent) => void;
  audioOutputError: (payload: SynthErrorEvent) => void;
  commandFired: (payload: SynthCommandFiredEvent) => void;
  audioRouteChanged: (payload: SynthRouteChangedEvent) => void;
  shadowBeat: (payload: SynthShadowBeatEvent) => void; // #64 Phase-1
};

declare class NativeRawAudioOutputModule extends NativeModule<RawAudioOutputEvents> {
  prepareAsync(): Promise<boolean>;
  start(): boolean;
  stop(): boolean;
  noteOn(channel: number, midi: number, velocity: number): void;
  noteOff(channel: number, midi: number): void;
  programChange(channel: number, program: number): void;
  pitchBend(channel: number, semitones: number): void;
  allNotesOff(channel: number): void;
  setMasterGain(gain: number): void;
  isReady(): boolean;
  getSampleRate(): number; // device-native output rate (Hz) — JS pegs frame clock at this
  getOutputLatencyMs(): number; // measured write->hear latency (ms), -1 until warm
  nativeLog(level: string, tag: string, msg: string): void; // v1.4.x P1
  setHighRefreshRate(enable: boolean): void; // v1.4.x P4
  // v1.4
  noteOnAt(channel: number, midi: number, velocity: number, atFrame: number, tickKind: number): void;
  getCurrentFrame(): number;
  clearScheduled(): void; // v1.4 — renamed from clearQueue
  // #64 Phase-1 — sub-ms sync instrumentation
  getMonotonicNanos(): number;
  getAudioTimestamp(): SynthAudioTimestamp;
  setDisplayPipelineNanos(ns: number): void;
  startShadowProbe(): void;
  stopShadowProbe(): void;
  setBeatAnchor(beatFrame: number, periodNanos: number): void;
}

const NativeRawAudioOutput =
  requireNativeModule<NativeRawAudioOutputModule>('RawAudioOutput');

// ---------------------------------------------------------------------------
// Singleton wrapper. The native side is itself a single instance; the JS
// wrapper just normalises the listener API and the event names.
// ---------------------------------------------------------------------------

const synth: RawAudioOutput = {
  prepareAsync: () => NativeRawAudioOutput.prepareAsync(),

  start: () => NativeRawAudioOutput.start(),

  stop: () => NativeRawAudioOutput.stop(),

  noteOn: (channel, midi, velocity) =>
    NativeRawAudioOutput.noteOn(channel, midi, velocity),

  noteOff: (channel, midi) => NativeRawAudioOutput.noteOff(channel, midi),

  programChange: (channel, program) =>
    NativeRawAudioOutput.programChange(channel, program),

  pitchBend: (channel, semitones) =>
    NativeRawAudioOutput.pitchBend(channel, semitones),

  allNotesOff: (channel) => NativeRawAudioOutput.allNotesOff(channel),

  setMasterGain: (gain) => NativeRawAudioOutput.setMasterGain(gain),

  isReady: () => NativeRawAudioOutput.isReady(),

  getSampleRate: () => NativeRawAudioOutput.getSampleRate(),

  getOutputLatencyMs: () => NativeRawAudioOutput.getOutputLatencyMs(),

  nativeLog: (level, tag, msg) => NativeRawAudioOutput.nativeLog(level, tag, msg), // v1.4.x P1

  setHighRefreshRate: (enable) => NativeRawAudioOutput.setHighRefreshRate(enable), // v1.4.x P4

  // v1.4
  noteOnAt: (channel, midi, velocity, atFrame, tickKind) =>
    NativeRawAudioOutput.noteOnAt(channel, midi, velocity, atFrame, tickKind),

  getCurrentFrame: () => NativeRawAudioOutput.getCurrentFrame(),

  clearScheduled: () => NativeRawAudioOutput.clearScheduled(), // v1.4 — renamed from clearQueue

  // #64 Phase-1 — sub-ms sync instrumentation surface (measurement only)
  getMonotonicNanos: () => NativeRawAudioOutput.getMonotonicNanos(),

  getAudioTimestamp: () => NativeRawAudioOutput.getAudioTimestamp(),

  setDisplayPipelineNanos: (ns) => NativeRawAudioOutput.setDisplayPipelineNanos(ns),

  startShadowProbe: () => NativeRawAudioOutput.startShadowProbe(),

  stopShadowProbe: () => NativeRawAudioOutput.stopShadowProbe(),

  setBeatAnchor: (beatFrame, periodNanos) =>
    NativeRawAudioOutput.setBeatAnchor(beatFrame, periodNanos),

  addReadyListener: (cb) => {
    const sub: EventSubscription = NativeRawAudioOutput.addListener(
      'ready',
      cb,
    );
    return sub;
  },

  addUnderrunListener: (cb) => {
    const sub: EventSubscription = NativeRawAudioOutput.addListener(
      'audioOutputUnderrun',
      cb,
    );
    return sub;
  },

  addErrorListener: (cb) => {
    const sub: EventSubscription = NativeRawAudioOutput.addListener(
      'audioOutputError',
      cb,
    );
    return sub;
  },

  addCommandFiredListener: (cb) => {
    const sub: EventSubscription = NativeRawAudioOutput.addListener(
      'commandFired',
      cb,
    );
    return sub;
  },

  addRouteChangeListener: (cb) => {
    const sub: EventSubscription = NativeRawAudioOutput.addListener(
      'audioRouteChanged',
      cb,
    );
    return sub;
  },

  // #64 Phase-1 — per-downbeat shadow-measurement records (only while armed).
  addShadowBeatListener: (cb) => {
    const sub: EventSubscription = NativeRawAudioOutput.addListener(
      'shadowBeat',
      cb,
    );
    return sub;
  },
};

export default synth;

export type {
  RawAudioOutput,
  SynthAudioTimestamp,
  SynthCommandFiredEvent,
  SynthErrorEvent,
  SynthReadyEvent,
  SynthRouteChangedEvent,
  SynthShadowBeatEvent,
  SynthUnderrunEvent,
};
