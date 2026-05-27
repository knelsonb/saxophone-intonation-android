/**
 * jest.setup.js — native-module mocks for the Bellcurve Jest harness.
 *
 * Every module that the component tree imports but that has no JS-only
 * implementation is mocked here with a minimal stub.  The goal is:
 *   1. The test process does not crash due to missing native bindings.
 *   2. The stubs expose enough surface for render-count assertions to work
 *      (components can call the mocked functions without throwing).
 *
 * Run after the Jest framework is initialised (setupFilesAfterFramework).
 */

// ---------------------------------------------------------------------------
// @local/raw-audio-output — TSF synth / MIDI output native module
// ---------------------------------------------------------------------------
jest.mock('@local/raw-audio-output', () => ({
  playNote: jest.fn(),
  stopNote: jest.fn(),
  programChange: jest.fn(),
  setMasterVolume: jest.fn(),
  RawAudioOutputModule: {
    playNote: jest.fn(),
    stopNote: jest.fn(),
    programChange: jest.fn(),
    setMasterVolume: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// @local/raw-audio-input — AudioRecord UNPROCESSED mic input native module
// ---------------------------------------------------------------------------
jest.mock('@local/raw-audio-input', () => ({
  useRawAudioInput: () => ({
    start: jest.fn(),
    stop: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  }),
  RawAudioInputModule: {
    start: jest.fn(),
    stop: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// @local/auto-mic-claim — Android Auto mic claim native module
// ---------------------------------------------------------------------------
jest.mock('@local/auto-mic-claim', () => ({
  claimMic: jest.fn(() => Promise.resolve()),
  releaseMic: jest.fn(() => Promise.resolve()),
  AutoMicClaimModule: {
    claimMic: jest.fn(() => Promise.resolve()),
    releaseMic: jest.fn(() => Promise.resolve()),
  },
}));

// ---------------------------------------------------------------------------
// expo-audio — Expo managed audio recording / streaming
// ---------------------------------------------------------------------------
jest.mock('expo-audio', () => ({
  AudioModule: {
    setAudioModeAsync: jest.fn(() => Promise.resolve()),
    requestPermissionsAsync: jest.fn(() =>
      Promise.resolve({ status: 'granted', granted: true }),
    ),
  },
  useAudioStream: jest.fn(() => ({
    status: 'idle',
    start: jest.fn(),
    stop: jest.fn(),
  })),
  useAudioRecorder: jest.fn(() => ({
    record: jest.fn(),
    stop: jest.fn(() => Promise.resolve({ uri: 'mock://audio.m4a' })),
  })),
}));

// ---------------------------------------------------------------------------
// expo-file-system — file read/write used by prefs persistence
// ---------------------------------------------------------------------------
jest.mock('expo-file-system', () => ({
  documentDirectory: 'file:///mock/documents/',
  readAsStringAsync: jest.fn(() => Promise.resolve('')),
  writeAsStringAsync: jest.fn(() => Promise.resolve()),
  deleteAsync: jest.fn(() => Promise.resolve()),
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: false })),
  makeDirectoryAsync: jest.fn(() => Promise.resolve()),
  EncodingType: { UTF8: 'utf8', Base64: 'base64' },
}));

// ---------------------------------------------------------------------------
// expo-sqlite — measurements database
// ---------------------------------------------------------------------------
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(() =>
    Promise.resolve({
      execAsync: jest.fn(() => Promise.resolve()),
      runAsync: jest.fn(() => Promise.resolve({ lastInsertRowId: 1, changes: 1 })),
      getFirstAsync: jest.fn(() => Promise.resolve(null)),
      getAllAsync: jest.fn(() => Promise.resolve([])),
      closeAsync: jest.fn(() => Promise.resolve()),
    }),
  ),
  SQLiteDatabase: jest.fn(),
}));

// ---------------------------------------------------------------------------
// @react-native-async-storage/async-storage — prefs key-value store
// ---------------------------------------------------------------------------
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
  multiGet: jest.fn(() => Promise.resolve([])),
  multiSet: jest.fn(() => Promise.resolve()),
  getAllKeys: jest.fn(() => Promise.resolve([])),
  clear: jest.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// react-native-reanimated — animated values used in metroStyles
// ---------------------------------------------------------------------------
// jest-expo preset includes its own Reanimated mock, but make it explicit.
jest.mock('react-native-reanimated', () =>
  require('react-native-reanimated/mock'),
);

// ---------------------------------------------------------------------------
// @gorhom/bottom-sheet — DrumPicker host
// ---------------------------------------------------------------------------
jest.mock('@gorhom/bottom-sheet', () => {
  const React = require('react');
  const { View } = require('react-native');

  const BottomSheetModal = React.forwardRef((_props, _ref) =>
    React.createElement(View, null),
  );
  BottomSheetModal.displayName = 'BottomSheetModal';

  return {
    __esModule: true,
    default: BottomSheetModal,
    BottomSheetModal,
    BottomSheetView: View,
    BottomSheetScrollView: View,
    BottomSheetModalProvider: ({ children }) => children,
  };
});
