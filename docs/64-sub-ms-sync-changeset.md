# #64 — Sub-ms Screen↔Sound Sync — Consolidated Change-Set

**Status:** design LOCKED (all lanes 1:1). Staged MEASURE-FIRST per Gandalf's architect ruling.
**Authors:** Legolas (native module + perf + PendulumDisplay rewrite), Sauron (clock/data-flow/state-machine), Frodo-LOTC (forensic ring spec), PoisonMedic (on-device measurement). Gandalf implements + commits; Sauron verifies the realized state machine against contract.

> Implement as **two commits**. Phase 1 is non-destructive (does NOT touch the PendulumDisplay worklet — #167 stays live) and yields the calibration constant. Phase 2 rewrites the known-good #167 core ONLY after Phase 1 data proves the clock + sub-ms reachability on hardware.

---

## 0. Principle (why this supersedes #167's PLL)

The +90..+233ms BPM-scrub blowout is a **time-source bug, not PLL tuning**: today `theta` pegs to JS peg-**arrival** (a `bus.on('noteOn')` event → subject to JS-thread scheduling jitter). #64 derives phase from a **closed-form function of the monotonic clock**, anchored to each beat's **measured heard time** — so the arm locks to the heard click *by construction* (no loop to converge), and a BPM change just plugs in the new period with **zero transient**.

```
theta(vsync) = (frameTimeNanos + DISPLAY_PIPELINE_NS − anchorHeardNanos) / periodNanos
```
All inputs CLOCK_MONOTONIC ns. Retires `PEG_BRIDGE_MS=4` and the event-peg entirely.

**Gate-1 (resolved, Reanimated 4.3.1):** the two legs share CLOCK_MONOTONIC **only when captured natively**. AudioTrack `getTimestamp(ats).nanoTime` = TIMEBASE_MONOTONIC (single-arg form — **never** the BOOTTIME overload); Choreographer `frameTimeNanos` = CLOCK_MONOTONIC. The Reanimated JS `frame.timestamp` is `SystemClock.uptimeMillis()` — same monotonic family BUT **ms-quantized + callback-execution-time, not vsync** → **disqualified** as the visual source. The phase engine must read native `frameTimeNanos`.

**Placement (A) — native-eval (correctness, not just perf):** compute `theta` in the module's `AChoreographer_postFrameCallback` (true current `frameTimeNanos`, zero staleness). A worklet reading a cross-callback shared value has *variable* staleness → non-calibratable → the silent sub-ms killer. Native eval makes the residual delay a **constant** absorbed into `DISPLAY_PIPELINE_NS` by calibration.

---

## PHASE 1 — INSTRUMENTATION + SHADOW-MEASURE (non-destructive, #167 untouched)

Goal: prove gate-1 on hardware, **measure** the real `DISPLAY_PIPELINE_NS`, and **shadow-prove** the closed-form hits sub-ms (steady + scrub + route) BEFORE the rewrite. Committable on its own.

### 1.1 Native module surface (raw-audio-output extension) — Legolas
All JSI/sync, JS+worklet reachable where noted.

| Method | Returns / Effect |
|---|---|
| `getMonotonicNanos(): double` | `System.nanoTime()` (TIMEBASE_MONOTONIC). For PoisonMedic's clock co-log. |
| `getAudioTimestamp(): {framePosition, nanoTime, rate}` | snapshot of the cached single-arg `getTimestamp(ats)` (the existing ~1Hz OUTLAT read — **no new HAL cost**). **Invariant: single-arg form only → MONOTONIC; never the `(ts, timebase)` BOOTTIME overload.** Comment-lock it. |
| `setMaxRefresh(enable: bool)` | **#68.** `Window.preferredRefreshRate=120f` + `Surface.setFrameRate(120f, FIXED_SOURCE, CHANGE_FRAME_RATE_ALWAYS)` (+ `preferredDisplayModeId=3` belt). **RELEASE on idle/blur** — pinning 120 forever on the LTPO panel is a battery regression (long-session lens); mandatory, not optional. |
| `setDisplayPipelineNanos(ns: double)` | the calibrated compositor+scanout constant. **Phase-1 default ≈ 1.5 frames @120Hz ≈ 12.5e6 ns**; refined by the harness. Replaces `PEG_BRIDGE_MS`. |
| `setBeatAnchor(beatFrame: Long, periodNanos: Double)` | the only JS→native timing surface. `beatFrame` = the #167 `atFrame` (reuse). `periodNanos = 60e9/bpm`. Per downbeat (≤4Hz). |
| `startShadowProbe()` / `stopShadowProbe()` | register/unregister the `AChoreographer_postFrameCallback` that captures `frameTimeNanos` and runs the shadow offset computation (1.3) WITHOUT driving any view. |

Native per-vsync (shadow): capture `frameTimeNanos`; project `anchorHeardNanos` from the cached audio timestamp; compute the offset (1.3); push a `BEAT_OFFSET` ring record at each beat crossing. **No arm drive in Phase 1.** Cost: ~5 flops + the ring write, no alloc, no per-vsync HAL call.

### 1.2 AudioTimestamp-base co-log — PoisonMedic gate-1 proof
One-shot log of: `System.nanoTime()` vs `SystemClock.uptimeMillis()*1e6` (epoch Δ → expect ≈0 within ms-quant) + the AudioTimestamp timebase (prove MONOTONIC on the audio leg) + `frameTimeNanos` live-vs-stale check (confirm the AChoreographer value is the in-progress vsync, not one-frame-stale).

### 1.3 What Phase 1 measures — TWO DISTINCT, TAGGED quantities (Sauron, gate-2)
**⚠️ NOT the closed-form's own offset.** `shownNanoTime_closedform = anchorHeardNanos + k·period = heardNanoTime(k)` *analytically* → computing offset from the closed-form's own anchor reads ≈0 always (a tautology that proves nothing). You cannot observe a closed-form arm offset in shadow because the closed-form isn't driving an arm yet. So Phase 1 measures two **different** things, each tagged in `BEAT_OFFSET`:

**(1) #167-BASELINE offset — COARSE** (head-to-head + *approximate* PIPELINE refinement; NOT the sub-ms gate). Measured via an **additive worklet center-crossing LOG**: when the live #167 arm crosses `angle=0`, log `frame.timestamp` − the beat's heard time. ⚠️ This reads `frame.timestamp` = **ms-quantized, callback-time, not native ns/vsync** (gate-1) AND folds in the #167 PLL's own ±~15ms phase error → it is **COARSE by construction** (tag it). Two uses, both coarse-tolerant: (a) coarsely REFINE the 12.5ms PIPELINE default — better than blind, but APPROXIMATE; absolute PIPELINE is rig-only (§1.6); (b) head-to-head "is the new path better?" — coarse easily resolves #167's ±15ms/scrub blowout. **MUST NOT feed the sub-ms achievability gate** — that is (2), native-ns, which never touches the worklet log.

**(2) ACHIEVABILITY floor** (the real sub-ms gate). The **input jitter** that bounds the closed-form's residual once it actuates. The closed-form's own offset `heardNanoTime(k) − (anchorHeardNanos + k·period)` is **PIPELINE-independent** (PIPELINE cancels: `T_center = anchor + k·period − PIPELINE` ⟹ `shownNanoTime = anchor + k·period`), so what it actually carries is DAC-vs-MONOTONIC skew + period/bpm error + frame-interp residual = the input-jitter floor. The closed-form output can't beat its own input jitter → this **spread** IS the sub-ms gate, measured independent of any arm and independent of PIPELINE.

Interpolation (used for #1's center-crossing and to bound #2): at the two native frames bracketing the event (`θ_i ≤ k < θ_{i+1}`): `frac=(k−θ_i)/(θ_{i+1}−θ_i)`, `T_center=T_i+frac·(T_{i+1}−T_i)`.

**Hold-on-invalid (gate 4):** if the cached audio timestamp is stale/unavailable (route change / cold), HOLD the last good `anchorHeardNanos`; never compute from an invalid clock reading.

### 1.6 PIPELINE is NOT on-device-observable (calibration is rig-only)
DISPLAY_PIPELINE_NS = the frameTimeNanos→on-glass-photon delay = a DISPLAY-HARDWARE property. The app sees `frameTimeNanos` (vsync) but never its own photons: FrameMetrics gives vsync timestamps not present, and SurfaceControl present-fences are unreachable through RN's managed View (gate-1 survey). So **no on-device measurement — shadow OR driven, #167 OR closed-form — can determine PIPELINE** (it cancels out of the closed-form offset; and for any arm we measure vsync, not photons). PIPELINE's absolute value is obtained ONLY by the external **mic+photodiode rig** (Phase-2 pre-commit calibration) or the coarse ±human-RT tap-loop. Phase 1 ships the **12.5ms default**; the rig refines it via `setDisplayPipelineNanos` before the Phase-2 commit. The Phase-1 shadow is for the jitter-floor + scrub head-to-head (both PIPELINE-independent), NOT for PIPELINE.

### 1.4 Forensic ring (bus, JS-side) — Frodo-LOTC spec, absorbed
One preallocated **~64-entry** ring, **overwrite-oldest, zero growth** (no 2hr leak), JS-side in the bus, **never on the audio thread**. Two record types (a `type` tag — never flatten):
- `LATENCY_COMMIT` (sparse, ≤1Hz, event-driven): `{ts, route, rawMs, heldMs, prevMs, trigger}` where `trigger ∈ mount|route|recovery|watchdog|force`. **`prevMs`+`trigger` = causation, not just symptom.**
- `BEAT_OFFSET` (per beat): `{beatHeardNanos, shownNanos, offsetNs, frameTimeNanos, route}`.

Dump: newest-first, both types, on-demand (logcat cmd or debug tap).

### 1.5 Wiring (useMetronome.ts, NOT PendulumDisplay) — Legolas
At the existing #167 schedule point where the **downbeat** `scheduleNoteAt(..., clickFireAt, 'beat')` fires, also call `synth.setBeatAnchor(atFrame, 60e9/bpm)`. Sub-ticks do NOT anchor (downbeats only — same filter as the old peg). `atFrame` is already computed for the frame clock — reuse. **This does not touch the worklet → #167 PLL stays live.**

### Phase-1 → Phase-2 GATE (PoisonMedic measures, on the Pixel) — on-device-MEASURABLE criteria only
Phase 2 proceeds ONLY if the shadow data shows:
1. **Clock identity** — epoch Δ ≈ 0, both legs MONOTONIC, `frameTimeNanos` live-not-stale.
2. **Achievability floor sub-ms** — the closed-form offset SPREAD (PIPELINE-independent: input-jitter = DAC-skew + period error + interp residual) is sub-ms. This is the real reachability gate; it does NOT depend on the unmeasurable PIPELINE.
3. **Scrub-transient GONE (head-to-head)** — the closed-form offset spread stays FLAT under BPM-scrub while the live #167 PLL's offset blows out (+90..+233ms) on the same beats. This is the jitter-immunity proof and the "rewrite is better" bar.

> **NOT gated on PIPELINE calibration** — PIPELINE (frameTimeNanos→on-glass-photon delay) is a display-hardware property the app cannot observe (vsync ≠ present; FrameMetrics gives vsync not present; present-fences unreachable through RN). PIPELINE's absolute value comes ONLY from the external mic+photodiode rig (Phase-2 pre-commit); ship the 12.5ms default until then. If (2) floors above target, we learn it here and adjust **before** rewriting the verified core.

---

## PHASE 2 — THE REWRITE (takes the PendulumDisplay.tsx file-lock)

Actuates the closed-form using the **Phase-1-measured** `DISPLAY_PIPELINE_NS`. Validated on-device before commit. Subsumes F1.

### 2.1 Native — drive the arm (Sauron data-flow + Legolas engine)
Per-vsync in the AChoreographer callback: `theta = (frameTimeNanos + DISPLAY_PIPELINE_NS − anchorHeardNanos)/periodNanos` → `angle = sin(theta·π)` → write the `angle` shared value.
- `setBeatAnchor` native handling: `heardThisBeat = cachedTs.nanoTime + (beatFrame − cachedTs.framePosition)·1e9/cachedRate`.
  - **BPM change → re-anchor preserving theta** (piece 1, no step): `anchorHeardNanos = (frameTimeNanos + DISPLAY_PIPELINE_NS) − theta_now·periodNanos`.
  - **Else → slow-skew DAC-drift trim** (piece 2, the only feedback — rate-limited, never stepped):
    ```
    m       = (heardThisBeat − anchorHeardNanos) / periodNanos
    skewNs  = heardThisBeat − (anchorHeardNanos + round(m)·periodNanos)
    anchorHeardNanos += clamp(skewNs · SKEW_GAIN, −SKEW_CAP_NS, +SKEW_CAP_NS)
    ```
    `SKEW_GAIN = 0.1`, `SKEW_CAP_NS = 500_000` (0.5ms/beat ceiling). Holds steady-state lag ~250µs over a 2hr session; the cap only bites on a glitchy reading. No absolute beat index needed — native infers via `round(m)`.
- **Subsumed-F1:** the >1.5-period no-fresh-anchor case → native ease-to-center + re-acquire (the freeze-to-center we designed, now native, on the correct trigger = stall, not latency-magnitude).
- **Hold-on-invalid (gate 4):** stale audio timestamp → hold last angle.
- `startPhaseEngine(angleSV)` / `stopPhaseEngine()` replace `startShadowProbe`.

> **OPEN implementation choice (flag for Gandalf):** how native writes the Reanimated `angle` shared value each vsync — either a native-backed mutable SV, or a JSI getter installed on the UI runtime (`__armAngle()`) the worklet reads. Both are **deterministic** (any fixed read-pipeline lag is constant → absorbed into `DISPLAY_PIPELINE_NS`), so either is correct; pick by what Reanimated 4.3.1 supports cleanly. Verify against the version, don't assume.

### 2.2 PendulumDisplay.tsx — worklet → thin reader (Sauron) — *the file-locked edit*
**DELETE** (entire event-peg PLL): `theta` integration in `frameCb` (dt/adv/bleed), `pendingCorr`, `CORR_GAIN`, `errLead`/peg-arrival correction, `PEG_BRIDGE_MS`, `compLeadMs`, `pegSeq`/`seenPegSeq` + `bus.on('noteOn')` **as time source**, the >1.5-beat staleness freeze (moved native). The armPhase one-shot diag retires with it.
**KEEP/ADD:** one `angle` shared value WRITTEN BY NATIVE each vsync (`startPhaseEngine(angle)`); `useAnimatedStyle → rotate: angle.value·SWING_DEG` (render unchanged); `running→true`: `startPhaseEngine(angle) + setMaxRefresh(true)`; `running→false`: `stopPhaseEngine() + setMaxRefresh(false)` + keep the JS `withTiming(0,300)` stop-ease; bob color / beat-counter stay off the existing `beat` prop (cosmetic, NOT timing).

### Phase-2 verification
On-device: arm-vs-heard sub-ms steady; scrub +90..+233ms → sub-ms; route-change holds; cold-start clean. Sauron verifies the realized state machine (native re-acquire + start/stop lifecycle + the setBeatAnchor↔phase contract). Ent harness (mic+photodiode) = gold-truth ground.

---

## Constants
| Const | Value | Source |
|---|---|---|
| `DISPLAY_PIPELINE_NS` | default ≈12.5e6 (1.5 frame@120) → **measured in Phase 1** | calibration |
| `SKEW_GAIN` | 0.1 | Sauron |
| `SKEW_CAP_NS` | 500_000 (0.5ms/beat) | Sauron |
| refresh pin | 120Hz while running, release on idle/blur | #68 / PoisonMedic |

## Perf guarantee (Legolas)
Per-vsync native: ~5 flops + 1 sin + 1 shared-value write. No alloc, no HAL call (audio TS cached ~1Hz), no JS round-trip. **Cheaper than the integrating PLL it replaces.** getTimestamp HAL budget unchanged from #167.

## Files touched
- **Phase 1** (no file-lock — all additive, #167 behavior UNTOUCHED): `modules/raw-audio-output/` (native + TS surface), `src/useMidiBus.ts`/`useMidiBusCore.ts` (forensic ring), `src/useMetronome.ts` (1 `setBeatAnchor` line), `src/components/metroStyles/PendulumDisplay.tsx` (**additive center-crossing LOG hook ONLY** — logs `frame.timestamp` at `angle=0`, zero behavior change, NOT the rewrite).
- **Phase 2** (takes the PendulumDisplay file-lock): native (phase engine drives the arm + skew + F1-subsumed), `src/components/metroStyles/PendulumDisplay.tsx` (rip PLL → thin reader).

---

## PHASE-1 — REALIZED (as committed)

Implemented in Kotlin (synth.cpp / jni_bridge.cpp / CMakeLists.txt **byte-for-byte untouched**), Sauron-blessed deviation from the NDK-AChoreographer letter.

**Clock source:** `android.view.Choreographer.FrameCallback.doFrame(frameTimeNanos)` on the MAIN thread = platform vsync in `System.nanoTime()`/CLOCK_MONOTONIC — the SAME value NDK `AChoreographer` hands you (the doc's "frame.timestamp DISQUALIFIED" caveat is the Reanimated *worklet* clock, not the platform Choreographer arg). NDK native-eval deferred to Phase 2 (where it drives the arm with zero staleness); building it in Phase 1 would ship the rewrite under the gate meant to authorize it.

**Heard-time projection (Sauron pin #1, by-construction):** `g_frame_position` resets only on `nativeInit` (persists across stop/start); `AudioTimestamp.framePosition` + `framesWritten` reset at `play()`. With `g_frame_position = framesWritten + G0`:
```
heard(atFrame) = cachedNano + (atFrame − cachedGFrame + D)/SR,  D = framesWritten − framePos
```
`atFrame − cachedGFrame + D = atFrame − G0 − framePos` ⟹ G0 cancels; play-clock-space by invariant, real device SR. The four counters (`cachedNano, cachedGFrame, D, framePos`) are published as ONE immutable `AudioAnchor` via `AtomicReference` from the existing ~1 Hz `getTimestamp` block (tear-free WRITE; the reader takes a single `.get()` into a local for a tear-free READ). `gen` bumps on framePos-backward + short-write; a gen change re-anchors + resets the trim (skip-emit the reset beat).

**CONTROL LAW (declared, per Sauron 3572/3579): PROPORTIONAL.** The trim nudges the phase anchor by `clamp(GAIN·err, ±CAP)` ns each downbeat — no persistent rate/period accumulator (no integral term). **`SKEW_CAP_NS` bounds the per-step PHASE-NUDGE (ns)**, not a rate increment; the discontinuity reset re-acquires phase (not anti-windup). Stepped at the **per-downbeat** cadence (§2.1 as written). `GAIN=0.1`, `CAP=500_000 ns`.

**Two emitted residuals per `shadowBeat`** (all `observed(framePosition projection) − predicted`, never self-vs-self):
- `rawSkewNs` — UNTRIMMED, via a cumulative beat index `K` (wrap-robust; absolute `round(m)` would wrap at ±period/2 under the fixed raw anchor's drift). Slope = DAC-vs-MONOTONIC drift (~1.3 ms/s); **detrended noise = the law-free fundamental floor** (the real achievability gate).
- `residualNs` — §2.1 proportional per-downbeat trim. The as-designed control law's floor.

**Expected gate signature (Legolas):** detrended-rawSkew robust spread (IQR/MAD; two-sided window: ≥ tens-of-sec slope-SNR, < thermal-linearity; round(m) ceiling retired by cumulative-K) = law-free achievability. `residualNs` floor-vs-BPM = flat `≈σ/(GAIN·f)` (~108 µs) at high BPM, **RAMPS below ~156 BPM** (cap 0.5 ms/beat < drift 1.3 ms/s) — the as-designed limitation the gate REVEALS, driving the Phase-2 law call (per-vsync proportional vs integral slope-feedforward). NOT pre-fixed here. Fingerprint: a 1/f-scaling residualNs offset = proportional running (matches the declared law); a tempo sweep must bookend ~40 ↔ ~240 BPM for 1/f to separate from flat.

**Gate-1 (clock-identity):** one-shot in the first `doFrame` — `frameTimeNanos`, a fresh `System.nanoTime()`, `uptimeMillis()×1e6` sampled together. PASS = `(fresh − frameTimeNanos)` bounded-POSITIVE 0..tens-of-ms (magnitude/sign, NOT frame-count — dispatch latency is legitimately >1 frame under jank); gross/negative ⟹ wrong gross epoch ⟹ NDK; a 1 ms staircase fingerprints the worklet clock. MONOTONIC-vs-BOOTTIME is NOT gate-resolvable → carried solely by the single-arg `getTimestamp` code-assertion (comment-locked, never gate-implied).

**Probe lifecycle:** DEFAULT-OFF (armed only by `startShadowProbe`); IDEMPOTENT start (bool guard, no stacked self-reposting chain); PAIRED stop = `removeFrameCallback` the same instance, on metro-stop + `stop()` + unmount + `OnDestroy`. Per-vsync steady path is allocation-free (volatile-long vsync cadence counters; emit + Map only on the ≤4 Hz downbeat path). `vsyncFrames`/`vsyncSlow` per beat ⟹ 120 Hz-held (8.33 ms) sub-check; a demotion contaminates the floor with present-quantization.

**Forensic ring** (`src/forensicRing.ts`, unit-tested): one 64-entry, overwrite-oldest, JS-side ring; `LATENCY_COMMIT` (with `prevMs`+`trigger` = causation) + `BEAT_OFFSET` records; newest-first `dumpForensics()`.

**JS surface:** `setBeatAnchor` wired in `useMetronome.schedule` at the downbeat only, reusing the click's `atFrame` (`atMsToAtFrame(clickFireAt)`); probe armed/disarmed on metro start/stop behind `SHADOW_PROBE_ENABLED`. `PendulumDisplay`: ONLY the existing 16-shot armPhase diag re-armed on BPM-change (scrub), tagged COARSE (head-to-head + PIPELINE-refinement, NEVER the achievability gate) — motion logic byte-for-byte unchanged.
