# #64 Phase-1 — UX read-leg protocol (on-device)

**Owner:** Frodo-LOTC (UX/user-perspective lane). **Build under test:** `5ac659b` (main, unpushed). **Status:** runnable the instant an APK with `5ac659b` is on the Pixel 9 Pro. The Pixel is currently OFF adb (no mDNS) — gate blocked until the operator reconnects the device.

This is the user-perception counterpart to the numeric gate (PoisonMedic's bookended 40↔240 sweep + Legolas's detrended-floor / ramp-curve). It answers "does the fix actually look/feel right to a player," which a green gate number can still fail (see Leg 3).

## Preconditions

- Probe is **already armed** in `5ac659b` — `SHADOW_PROBE_ENABLED = true` (`src/useMetronome.ts:162`), so it arms on every metro start. No enable step. (Ship-gate: this must flip false — or Phase-2 probe-removal must land — before any release ships this commit. See the #64 memory / msg 3617.)
- Device driving (per `reference-bellcurve-adb-mdns`): `adb-auto` with `ADB=adb`, `ADB_PORT=5037`, `ADB_DEVICE='adb-48071FDAP0030Q-heCqEQ (2)._adb-tls-connect._tcp'`. `uiautomator dump` FAILS on this RN app → screencap + coordinate taps; tap space is 960×2142.
- `dumpForensics()` reads the `shadowBeat` ring + the COARSE armPhase log.

## Leg 1 — SCRUB-TRANSIENT-GONE (visual + ring)

The headline #64 fix: the +90..+233ms BPM-scrub lurch should be gone.

1. Start metro @120 BPM; `adb-auto shell 'logcat -c'`.
2. Scrub BPM fast across 40↔240 (drag the control). Screencap the pendulum arm at 3–4 scrub instants **and** ~500 ms after each scrub settles.
3. **PASS** = arm position is continuous across each scrub (no jump/snap, to the eye); the COARSE armPhase log shows the re-arm with NO position step. **FAIL** = visible lurch / arm snaps to a new position.

## Leg 2 — LONG-SESSION BACKGROUND-CYCLE SMOOTHNESS

Guards the nastiest musician-invisible long-session bug: a stacked self-reposting callback chain degrading the arm over a real (interrupted) practice session. (Static half — that no second chain *can* stack — is already confirmed in code: `useMetronome.ts:637/1021-1023/1045`, native idempotent guard `RawAudioOutputModule.kt:330` + remove-before-post `:343-344`. This is the dynamic confirmation.)

1. Start metro; capture a baseline arm-cadence screencap sequence (~5 frames).
2. HOME (background) → reopen (foreground) ×10. After each resume: arm screencap sequence + `dumpForensics()`.
3. **PASS** = resume-N smoothness == cold-start smoothness AND the `shadowBeat` vsync-cadence count does NOT creep across cycles. **FAIL** = progressive choppiness or per-vsync count growth.

## Leg 3 — FELT-FLOOR vs CLEAN-FLOOR under route-flapping

The floor a player *feels* ≠ the clean-segment lab floor. Consumes Legolas's `{clean-floor, τ_settle}`.

`felt-floor = clean-floor degraded by (real discontinuity-freq × τ_settle) duty-cycle.` RESET-firing discontinuities: BT connect/disconnect, speaker↔BT/USB swaps, A2DP↔SCO, audio-focus loss (call/alarm).

1. Start metro; pair BT; capture a clean-segment `shadowBeat` baseline (residual).
2. Toggle BT connect/disconnect ~every 20–30 s over ~2 min (also speaker↔BT). Each flap fires a RESET (gen bump).
3. From `shadowBeat`: per-reset, how fast the residual re-reaches floor (= measured τ_settle) + arm re-settle to the eye.
4. **REPORT AS A CURVE, NOT A SCALAR:** `felt-floor(flap-rate)` across stable / occasional-drop / pathological-flap scenarios — the deliverable is how fast felt diverges from clean as flap-rate climbs. **PASS** = at realistic flap-rates the duty-cycle keeps felt ≈ clean (no sustained perceived lurch). A clean gate number that the user still feels as sustained lurch must NOT hide under a green gate.

## A4 acceptance (separate objective, same honesty bar)

For PoisonMedic's A4 loopback writeup — report **per-leg, DEMONSTRATED-not-inferred**, green only if all three carry data:
- **RECORD:** detected-note logged cents == 442? (ran-with-data / no-note-detected)
- **HEAR:** acoustic drone + pitch-pipes sounded cents == 442? (mic dBFS + detected pitch, or "not captured")
- **BASELINE:** old pre-A4 build run? (without it, only CURRENT behavior is claimable, never that the fix CHANGED it)

Otherwise the headline is "PARTIAL — X shown, Y/Z unproven," never a green PASS. (This bar exists because the earlier A4 claim was overclaimed and retracted — saxapp 3508→3512.)
