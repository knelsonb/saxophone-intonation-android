/**
 * jest.config.js — Jest configuration for Expo SDK 56 / RN 0.85.
 *
 * Preset: jest-expo@56 (wraps @react-native/jest-preset under the hood).
 *
 * Pattern coverage:
 *   - src/__tests__/**\/*.test.tsx  — React component tests (RNTL)
 *   - (*.test.ts files are intentionally EXCLUDED here — they run via the
 *     legacy node --experimental-strip-types runner in scripts/legacy-tests.js
 *     because they use bare .ts import paths that Metro/Babel cannot resolve.)
 *
 * setupFilesAfterFramework: jest.setup.js mocks every native module that the
 * component tree imports so tests run in a pure-JS environment.
 */

/** @type {import('jest-expo/jest-preset').JestPreset} */
export default {
  preset: 'jest-expo',
  // Only pick up .tsx test files — .ts files are handled by the legacy runner.
  testMatch: ['<rootDir>/src/__tests__/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // Prevent Jest from treating the node_modules @local symlinks as source.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|@gorhom/.*)',
  ],
};
