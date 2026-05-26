# Intonation Analyzer — Android

React Native (Expo SDK 56) port of the
[saxophone-intonation-table](https://github.com/knelsonb/saxophone-intonation-table)
desktop app. Built for landscape Android tablets.

## Sprint plan

Tracks the desktop app (currently v0.5.8). Parity target = chunk 5.

| Chunk | Version | Scope |
|------|---------|-------|
| **1** | 0.1.0 | Scaffold: mic permission + live RMS meter (no pitch detection yet) |
| 2     | 0.2.0 | YIN pitch detection + tuner readout. Default instrument **Bb tenor** (matches desktop v0.5.7.1). Frequency-adaptive cent precision (0.1¢ / 0.5¢ / 1.0¢ tiers). A4 reference 430–450 Hz. |
| 3     | 0.3.0 | Filter modes (Fast / Normal / Slow) re-tuned per desktop v0.5.8 research baseline — `_FILTER_PRESETS` from `sax_audio_engine.py` ported verbatim. Min-N filter. Instrument catalog incl. bass clarinet (C–G), contras, full sax range. Sounding / fingered display toggle. |
| 4     | 0.4.0 | Intonation table + SQLite persistence. Per-instrument range editor (gear button) with overrides DB. Allow-out-of-range toggle. Prefs save-on-exit (instrument, nickname, A4, lang, display mode, filter mode, min-N). |
| 5     | 1.0.0 | Matrix view with bar+whisker cell graphics, CSV/PNG export, autotune, custom instruments, i18n (en/de), spectrum-analyzer + diagnostics toggle, response-modes inline help. |

Out-of-scope (desktop-only, irrelevant on Android):
- Audio device picker / host-API fallback / hot-plug recovery — Android's `expo-audio` owns the input route.
- Sample-rate negotiation / native-rate-first — Android picks one rate and we live with it.

Current commit ships **chunk 1**.

## Running locally

```sh
npm install
npx expo prebuild --platform android --non-interactive
npm run android      # or: cd android && ./gradlew installDebug
```

Requires a connected Android device or emulator, JDK 17, and the Android SDK.

## Permissions

`RECORD_AUDIO` only. Audio is processed on-device; nothing leaves the
tablet. The first launch shows an explicit permission gate explaining
this in plain language.

## Release builds

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which runs
`expo prebuild` and Gradle's `assembleRelease`, then attaches the APK
to a GitHub Release matching the tag.
