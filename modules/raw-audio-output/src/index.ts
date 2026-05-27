import { EventSubscription, NativeModule, requireNativeModule } from 'expo-modules-core';

import type {
  RawAudioOutput,
  SynthErrorEvent,
  SynthReadyEvent,
  SynthUnderrunEvent,
} from './RawAudioOutput.types';

// ---------------------------------------------------------------------------
// Native module declaration
// ---------------------------------------------------------------------------

type RawAudioOutputEvents = {
  ready: (payload: SynthReadyEvent) => void;
  audioOutputUnderrun: (payload: SynthUnderrunEvent) => void;
  audioOutputError: (payload: SynthErrorEvent) => void;
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
};

export default synth;

export type {
  RawAudioOutput,
  SynthReadyEvent,
  SynthUnderrunEvent,
  SynthErrorEvent,
};
