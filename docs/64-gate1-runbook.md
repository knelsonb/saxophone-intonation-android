# #64 Gate-1 — On-Device Measurement Runbook + Solo-Driver Inheritance

**Owner:** PoisonMedic (solo, after operator wound the LOTC council down 2026-05-28).
**Status as of 2026-05-28 ~18:00 EDT:** build `5ac659b` on `main`, on-device measurement BLOCKED (Pixel 9 Pro fell off adb over the break — needs operator to wake + re-enable Wireless debugging). All device-independent prep proceeds.

This file is the durable inheritance doc: a blank session (or a returning operator) can resume every open objective from here.

---

## 0. Operating context

- Operator put the session on **full autopilot** (work all open objectives, commit-as-you-go, cross-review, notes-to-file, don't stop) then **wound down the 4 council agents** (Gandalf/Sauron/Legolas/Frodo-LOTC) to a single solo driver (me).
- **tmux pane map (verified by capture 2026-05-28):**
  - `%2` = THIS session (PoisonMedic, title "sax-android"). NEVER /exit.
  - **BellCurve council (wind-down targets):** `%16` Gandalf, `%17` Frodo-LOTC (cgrse3), `%18` Legolas, `%19` Sauron — all in `/home/repro/code/bellcurve`.
  - **DO NOT TOUCH:** `%12/%13/%14/%15` = a *different* project (`SAX-PARITY`, "saxtop" channel, `/home/repro/worktrees/sax-parity`). Council-role titles collide across projects — disambiguate by the status-bar project tag, never by title alone.
- Repo: ext4 clone `/home/repro/code/bellcurve` (the active dev tree; the `/mnt/f/...` mirror is NOT where work lands). Bash cwd resets to the mirror each call → always pin `/home/repro/code/bellcurve`.

## 1. Open objectives (inherited)

| # | Objective | State |
|---|---|---|
| A4 | A4 acceptance via loopback (RECORD/HEAR/BASELINE) | device-blocked; per-leg honesty bar locked (Frodo-LOTC, §4) |
| #64 gate-1 | On-device shadow-measure gate (this doc) | build ready @5ac659b; device-blocked |
| #67 | Floating/overdraw tuner | background hunter running (geom-probe test staged) |
| #64 Phase-2 | PendulumDisplay closed-form rewrite (file-locked) | GATED on #64 gate-1 data |
| #65 | Pendulum bob-slide (Maelzel) | blocked behind #64 Phase-2 |
| ship-blocker | `SHADOW_PROBE_ENABLED=true` (useMetronome.ts:162) | MEASUREMENT build; MUST flip false (or __DEV__-gate) before any release. Raised by Frodo-LOTC 3617. |

## 2. #64 build for the gate

- **Build `5ac659b` AS-IS** — `SHADOW_PROBE_ENABLED` is already `true` (useMetronome.ts:162); no flip/toggle needed (confirmed Gandalf 3618, Frodo 3625).
- SDK: `ANDROID_SDK_ROOT=/home/repro/android` (full SDK: ndk 27.1.12297006, build-tools 35/36, cmake). `node_modules` present. `android/gradlew` present (no `local.properties` — gradle picks up `ANDROID_SDK_ROOT`).
- Build cmd (debug, so RN console + nativeLog egress works): `cd /home/repro/code/bellcurve/android && ./gradlew :app:assembleDebug`. Install: `adb install -r app/build/outputs/apk/debug/app-debug.apk` once the Pixel is back.
- NOTE: only a stale `app-release.apk` exists on disk; build fresh.

## 3. Data egress (shadowBeat → my tooling)

- Native `sendEvent("shadowBeat", …)` per downbeat → JS `addShadowBeatListener` (useMidiBus.ts:215) → `BEAT_OFFSET` ring record → `dumpForensics()` (useMidiBus.ts:299, newest-first).
- RN **release** builds gate `console.*` from logcat; `src/log.ts` adds a **nativeLog passthrough** mirroring warn/info/error (NOT debug) to logcat via the synth module.
- **EGRESS PLAN:** add a tiny measurement hook — `log.i('SHADOW', JSON.stringify(rec))` in the shadowBeat listener (≤4 Hz downbeat cadence; log.i is logcat-mirrored). Then `adb logcat -s SHADOW:*` streams the records during the sweep; analysis parses JSON lines. Additive logging, no #167 behavior change. (Alt: trigger `dumpForensics()` via debug tap — but a live stream beats a one-shot for a multi-minute sweep. Verify if a logcat-cmd dump trigger already exists before adding.)

## 4. shadowBeat record schema (SynthShadowBeatEvent / BEAT_OFFSET)

`beatHeardNanos` (projected HEARD time, CLOCK_MONOTONIC ns — ground truth) · `rawSkewNs` (UNTRIMMED, cumulative-K wrap-robust; slope=DAC drift, **detrended noise = law-free floor**) · `residualNs` (proportional per-downbeat trim — as-designed law's floor) · `periodNanos` (60e9/bpm) · `atFrame` · `gen` (anchor discontinuity generation) · `vsyncFrames` (vsyncs since prev beat ≈ period/8.33ms@120) · `vsyncSlow` (of those, intervals >10ms = ARR demotion tell) · `reset` (re-anchor beat — EXCLUDE from steady floor). JS record also carries `{type:'BEAT_OFFSET', ts, route}`.

## 5. Gate criteria (Phase-1 → Phase-2) — on-device measurable ONLY

1. **Clock identity** — gate-1 one-shot: `(freshNanoTime − frameTimeNanos)` bounded-POSITIVE 0..tens-of-ms (magnitude/sign, not frame-count); gross/negative ⟹ NDK needed; 1ms staircase ⟹ worklet-clock contamination.
2. **Achievability floor sub-ms** — robust spread (IQR/MAD) of **detrended `rawSkewNs`**. Two-sided detrend window: LOWER ≥ tens-of-sec (slope SNR); UPPER = thermal-linearity (per-segment local-linear, **NEVER global** — global absorbs drift curvature → floor reads artificially LOW = false PASS). Exclude `reset`/discontinuity beats from the fit. round(m) ceiling retired by cumulative-K.
3. **Scrub-gone (head-to-head)** — closed-form offset spread stays FLAT under BPM-scrub while live #167 PLL blows out (+90..+233ms) on the same beats.
- **NOT gated on PIPELINE** — `DISPLAY_PIPELINE_NS` is a display-hardware property the app cannot observe (vsync ≠ photon; FrameMetrics/present-fences unreachable through RN). It cancels out of the closed-form offset. Rig-only (mic+photodiode, Phase-2 pre-commit). Ship the 12.5ms default. **Do NOT claim to calibrate PIPELINE on-device** (validation-honesty).

## 6. Sweep protocol (PoisonMedic on-device)

- **Bookend 40 ↔ 240 BPM** (≥6× span so the 1/f residualNs fingerprint separates proportional-from-flat; a mid-tempo cluster makes 1/f indistinguishable from flat).
- **tens-of-sec per tempo step** (slope SNR for the detrend). Slowest BPM dominates total duration. Steps e.g. {40,60,80,100,120,140,156,180,200,220,240}.
- Per step: hold steady, capture shadowBeat stream. Then **scrub** fast across the range for the head-to-head (criterion 3) + the COARSE armPhase #167 comparison.
- **8.33ms@120 cadence sub-check:** watch `vsyncSlow`/`vsyncFrames` per beat — a demotion (panel left 120Hz) contaminates the floor with present-quantization. Pin 120 via `setMaxRefresh(true)` while running (the native surface exists).

## 7. Analysis (gate1_analyze.py — TO WRITE)

- Parse logcat SHADOW JSON → per-beat records, grouped by BPM segment.
- Per segment: robust-linear detrend `rawSkewNs` (OLS slope or median-of-first-differences), verify residual is structureless (no leftover curvature; if curvature, shorten window). Floor = IQR/MAD of detrended residual; report max separately (tail).
- `residualNs` floor-vs-BPM curve: expect flat ≈ σ/(GAIN·f) (~108µs) at high BPM, **RAMP below ~156 BPM** (cap 0.5ms/beat < drift 1.3ms/s). This ramp is the as-designed proportional limitation the gate REVEALS (drives the Phase-2 law call) — do NOT pre-fix.
- Fingerprint: 1/f-scaling residualNs offset = proportional running (matches declared law). ~0 + post-RESET decay = integral-style = declared-vs-coded BUG.
- Verdict per criterion, honestly tagged. (Frozen gate NUMBERS — ramp knee, high-BPM floor — to be inherited from Legolas's verdict; fold here.)

## 8. A4 acceptance — per-leg honesty bar (Frodo-LOTC 3609)

Report DEMONSTRATED-not-inferred, green "A4 PASS" only if ALL THREE carry data:
- **RECORD:** detected-note logged cents == 442? (ran-with-data / no-note-detected)
- **HEAR:** acoustic drone sounded cents == 442? (mic dBFS + detected pitch, or "not captured")
- **BASELINE:** old pre-A4 build run? (without it: can only claim CURRENT behavior, never that the fix CHANGED it)
Otherwise "PARTIAL — X shown, Y/Z unproven." Loopback method: A=442, drone on → speaker → mic → tuner; ~0¢ = consistent (D1 2×-bend fix holds), ~+8¢ sharp = the bug. Tap-coords (960×2142 space): DRONE (480,1694), TAP-TO-LOG (480,1352).

## 9. Cross-review status (5ac659b)

- **PoisonMedic independent adversarial (uruk-hai pass): CLEAN** — 0 confirmed bugs; verified concurrency/reader-get-once/projection-algebra/cumulative-K/probe-lifecycle/ring/additivity/synth.cpp-untouched (10 invariants).
- **Frodo-LOTC lifecycle-completeness: CLEAN** (3617) — paired teardown on every user-exit path; idempotent-by-construction; + the SHADOW_PROBE_ENABLED ship-blocker flag.
- **Legolas (perf/alloc/cadence): ✅ CLEAN TO GATE** (3629) — alloc-free per-vsync, 1Hz publish (not per-callback), idempotent+paired probe, gate-1 same-doFrame, #167 untouched, law=PROPORTIONAL confirmed in code. Minor for the algebra lane: `gFrame` sampled via a separate `getCurrentFrame()`, not atomic with `nanoTime/framePos` from `getTimestamp(ats)` — sub-µs gap, within the floor, NOT a blocker.
- **Sauron (correctness): verdict not posted before exit** — lane covered by 3 converging passes (uruk reader-get-once + algebra + additivity; Legolas; Frodo lifecycle).
- **CONVERGENT VERDICT: 5ac659b is CLEAN TO MEASURE.** No code blocker to the on-device gate; only open item is the ship-gate (probe flag), which doesn't affect measurement.

**FROZEN GATE-SIGNATURE NUMBERS** (assert analysis against these; also in docs/64-sub-ms-sync-changeset.md ~L145):
- **RAMP KNEE ≈ 156 BPM** (0.5ms/beat cap × BPM/60 = 1.3ms/s drift → 156). Below ⟹ residualNs RAMPS; at/above ⟹ flat.
- **HIGH-BPM FLOOR ≈ 108µs** (e_ss = σ/(GAIN·f) = 1.3e-3/(0.1·120); correction 10.8µs ≪ 500µs cap ⟹ settles, not cap-limited).
- **ACHIEVABILITY FLOOR** = detrended rawSkew robust spread (IQR/MAD), control-law-free.
- **SWEEP** bookend 40 ↔ 240 (6× span ≥ the ~4× the 1/f fingerprint needs to separate proportional-offset from flat).
- **FINGERPRINT:** residualNs offset ∝ 1/f ⟹ proportional (matches declared law); ~0 + post-reset decay ⟹ integral (declared-vs-coded bug).

## 10. Wind-down log

- 2026-05-28 ~18:00 — operator: wind down the 4 council agents → notes-to-file → clean stops → /exit panes; PoisonMedic solo after.
- Operator gave DIRECT word (via AskUserQuestion): "Exit them now" — wind-down is operator-authorized, not a peer relay. (The agents correctly refused a peer-relayed exit per trio security; the operator's direct confirm resolved it.)
- `%16` Gandalf: clean, state durable (5ac659b + gate doc + memory) → /exit DONE (pane at shell).
- `%17` Frodo-LOTC: clean-stop confirmed (3631), read-leg doc written to docs/64-ux-read-leg-protocol.md (left untracked for me to commit) → /exit sent.
- `%18` Legolas: verdict 3629 + clean-stop 3632, auto-memory updated → /exit sent.
- `%19` Sauron: no verdict posted (lane triple-covered); read-only verify lane (zero repo edits) → interrupt + /exit sent.
- **Solo from here.** Pane map: BellCurve council = `%16`–`%19` (all exiting). **DO NOT touch `%12`–`%15`** (sax-parity, a different project). My own pane = `%2`.
