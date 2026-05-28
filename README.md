# BellCurve — Android Saxophone Tuner

BellCurve is a landscape Android tablet app for saxophone players. It combines
real-time pitch detection, a sample-accurate metronome, a drone/pitch-pipe
synth, and a recording deck in one instrument-focused tool.

**Current version:** v1.4 (versionCode 14) — Expo SDK 56 / React Native 0.85

---

## Four pillars

### TUNER
YIN pitch detection on a dedicated `UNPROCESSED` audio capture, 25 ms latency.
Transposition-aware: pick your instrument (Bb/Eb/F/C, full sax + clarinet +
bass clarinet range) and BellCurve shows sounding pitch alongside fingered
pitch. A4 reference 430–450 Hz. Three response modes (Fast / Normal / Slow).
Intonation history table with per-note statistics.

### METRONOME
Sample-accurate real-time MIDI engine. Beats are scheduled as `noteOnAt`
commands tied to the native frame clock, with a 500 ms past-atFrame grace
window (silence over wrong). Supports custom time signatures (any numerator
1–32, denominators 2/4/8/16/32), per-beat drum voice, and subdivisions.
Four saveable profile slots. Pendulum, flash, and pulse visual modes all
driven by the same fire callback as audio — no reconciler lag.

### DRONE + PITCH PIPES
TSF + GeneralUser GS SF2 soundfont renders drone notes through the same
real-time synth. Every pitch change does a full noteOff + noteOn + A4 pitch-
bend re-anchor — no frequency chase, no audible glide. Pitch pipes use the
same synth channel on a separate role.

### DECK
Five-minute recording takes via `expo-audio`. Mute/unmute is coordinated
through the MIDI bus master-mute so drone and metronome go silent together.
Takes are stored on-device and shareable via the system share sheet.

---

## Requirements

- Android 8.0+ (minSdk 26), landscape tablet recommended (Pixel 9 Pro tested)
- JDK 17
- Android SDK with NDK (for the native audio module)
- Node 20+

---

## How to build

```sh
npm install
npm run prebuild          # expo prebuild --platform android --non-interactive
npm run build:android     # cd android && ./gradlew assembleRelease
```

For a debug build on a connected device:

```sh
npm run android           # expo run:android
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which runs
`expo prebuild` + `assembleRelease` and attaches the APK to a GitHub Release.

---

## Permissions

`RECORD_AUDIO` only. Audio is processed entirely on-device. Nothing is
uploaded, transmitted, or stored outside the device filesystem.

---

## License

MIT — see `LICENSE`.

Assets: GeneralUser GS soundfont is licensed separately by S. Christian Collins
(free for non-commercial and commercial use; see the SF2 bundle for full terms).
