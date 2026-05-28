# BellCurve — Accuracy & Precision Test Plan (autonomous, ~2 weeks)

**Owner:** PoisonMedic (solo autopilot). **Started:** 2026-05-28.
**Operator directive:** "week-long test plan for accuracy and precision in all things; set up an AVD for testing; engage autonomously; full autopilot for the next week or two."

## 0. Principle — DEMONSTRATED, not inferred

Per [[feedback-validation-claim-honesty]]: report only what a run actually proves, tagged by tier. An emulator (AVD) has **no real DAC, mic, or LTPO vsync**, so it **cannot** certify sub-ms audio sync, audio latency, pitch-via-mic, or a 120Hz hold. Those are **real-hardware-only** (the Pixel 9 Pro). The AVD certifies everything that is logic / UI / config / JS-clock-timing — continuously and unattended. Never present an AVD number as a HW-precision result.

## 1. Two tiers

### Tier A — AVD (continuous, unattended, 24/7)
Dedicated emulator: **Android 15 / API 35, x86_64, KVM-accelerated** (APK ships x86_64 so the native audio module loads). No shared-phone conflict with the operator's Pixel. Covers:

| Dimension | Test | Proves |
|---|---|---|
| Regression | `tsc --noEmit`; `node legacy-tests.js`; `jest` (forensicRing, yin, renderCount) | no logic/type regressions |
| Pitch MATH (accuracy) | yin.ts vs synthetic tones A2..C7 — cents error vs reference, confidence thresholds, noise rejection | pitch ALGORITHM accuracy (not the mic path) |
| A4 MATH | midiToFrequency / a4BendSemitones at 415..466 Hz | calibration math exactness |
| Scheduler timing (precision) | the JS beat scheduler's inter-beat interval regularity, BPM 40..240 (scheduled fire-times, off-DAC) | scheduling-clock jitter |
| UI / layout (#67, tab-fit) | render every screen across phone/tablet/foldable × portrait/landscape × font scale; assert no overflow/clip/collision; floating-tuner + LedRow-clip; "every main tab fits, no scroll" | visual correctness across configs |
| State machine | tab nav, profile load/edit, drone on/off, A4 change, metro start/stop | no stuck/wrong states |
| Stability | monkey + `dumpsys meminfo` over a simulated long session; listener/timer/native-leak checks | no crash, no growth |
| Config matrix | re-run the functional suite across AVD profiles (phone/tablet/foldable) + API 33/34/35 | cross-device robustness |

### Tier B — Real Pixel 9 Pro (HW-gated, operator-coordinated)
Only when the device is on adb and free. The accuracy/precision that **needs real hardware**:

| Dimension | Test (script) | Proves |
|---|---|---|
| #64 sub-ms sync | `gate1_sweep.sh` (bookended 40↔240, forced 120Hz) → `gate1_analyze.py` | clock-identity; achievability floor (detrended-rawSkew IQR/MAD); residualNs ramp vs ~156 knee; 1/f fingerprint; scrub-gone head-to-head; 8.33ms@120 vsync |
| Audio latency (#167) | getTimestamp/dumpsys + armPhase | real output latency |
| A4 loopback | `a4_loopback.sh` (drone→speaker→mic→tuner) | RECORD/HEAR/BASELINE per-leg @442 |
| Pitch-via-mic | drone/external note → tuner cents | real mic-path accuracy |
| #68 120Hz hold | dev refresh HUD + shadowBeat vf/vs | real LTPO pin (Window-hint demotes at low BPM — see finding below) |

HW runs are **prompted** (I push the operator when a useful HW window exists) and **never faked on the AVD**.

## 2. Schedule (~2 weeks, autonomous)

- **On each of my commits:** regression gate (tsc + jest + legacy) before committing.
- **Daily** (cron, off-peak off-:00 minute): full Tier-A run on the AVD → `docs/test-runs/YYYY-MM-DD/` + push ONLY on a regression / new failure.
- **~Every 3 days:** config-matrix sweep (extra AVD profiles + API levels).
- **Tier B:** when the Pixel is on adb, run the stalest pending HW item; else hold + note. Prompt the operator ~daily if HW items are stale.
- **Weekly:** consolidated accuracy/precision report — trends, regressions, proven-vs-pending.

## 3. Result collection

- Per-run: `docs/test-runs/<date>/<tier>-<suite>.log` + a one-line verdict row appended to `docs/test-runs/LEDGER.md`.
- **Regression** = a previously-green check goes red → PushNotification + a RED ledger row.
- Every verdict carries: TIER (AVD/HW), DEMONSTRATED vs PENDING, baseline-or-not.

## 4. Status / setup log

- **AVD:** Android 15 x86_64 (KVM). Emulator + system image installing. **BLOCKER:** `/dev/kvm` needs group access — operator runs `sudo chmod 666 /dev/kvm` (or adds user to `kvm` group); without it the emulator runs software-slow. Permission-classifier-denied for me to do via sudo.
- **HW gate-1 sweep:** running on the Pixel now — first Tier-B data point.
- **Known HW finding (2026-05-28):** #68's `Window.preferredRefreshRate=120` hint holds 120Hz at high BPM (lots of motion) but the LTPO **demotes to 60Hz at low BPM** (vf=vs over a beat; HUD "60"). Hard pin needs `Surface.setFrameRate(120, FIXED_SOURCE, ALWAYS)` in native setHighRefreshRate. The gate sweep forces 120Hz via dev settings (`min/peak_refresh_rate=120`) for a clean floor — **revert after** (`settings delete system min_refresh_rate; … peak_refresh_rate`).
- **Scripts:** `scripts/gate1_sweep.sh` + `gate1_analyze.py` (Tier-B sync), `scripts/a4_loopback.sh` (Tier-B A4). **Tier-A runner:** `scripts/avd_test_run.sh` — TO WRITE (boots/uses the AVD, installs the APK, runs the functional + regression + layout + stability suite, writes the per-run report).
- **Coords (real Pixel, 960×2142, DIRECT-read — no scaling):** METRO tab (360,2037), TUNER tab (120,2037), DECK (600,2037), START/STOP (480,1875), BPM +5 (805,770) / −5 (150,770), DRONE (480,1694), TAP-TO-LOG (480,1352).
