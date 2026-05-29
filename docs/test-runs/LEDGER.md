# BellCurve — Test-Run Ledger

One row per run. **Tier:** `A/off`=off-device logic, `A/AVD`=emulator, `B`=real Pixel HW.
**V:** GREEN / RED / PARTIAL / BLOCKED. Honesty: only what was DEMONSTRATED (per the test plan §0).

| Run | Tier | Suite | V | Notes |
|---|---|---|---|---|
| 2026-05-28 | A/off | regression (tsc+legacy+jest) | GREEN | tsc clean; yin pitch-math + legacy + renderCount pass (2 todo). Baseline @5405ea0. |
| 2026-05-28 | B | #65 bob-slide | GREEN | on-device: bob slides upper-third@100 → pivot@240 BPM (captures 12/17). |
| 2026-05-28 | B | #68 120Hz metro pin | PARTIAL | pin+release work (HUD 120 running / 48 stopped) but the LTPO **demotes to 60Hz at low BPM** — Window hint isn't a hard pin; needs Surface.setFrameRate. |
| 2026-05-28 | B | #64 gate-1 sweep | BLOCKED | egress VALIDATED (ShadowBeat/PendDiag/gate1 streaming; ramp visible @30 BPM, vf/vs flags the 60Hz demotion) but the full bookended sweep **WiFi-dropped** (0 lines captured). Needs a stable Pixel link (USB) + a clean 120Hz hold. |
| 2026-05-28 | B | #67 tuner overdraw | PENDING | fix committed 2bcd5db; on-device needle-float + LedRow-truncation check needs a sounding note (fold with A4 loopback). |
| 2026-05-28 | B | A4 loopback | PENDING | driver ready (a4_loopback.sh); needs acoustic setup + a stable link. |
| 2026-05-28 | A/off | regression | GREEN | tsc+legacy+jest clean |
| 2026-05-28 | A/AVD | install | GREEN | apk installed |
| 2026-05-28 | A/AVD | launch-no-crash | GREEN | no crash on launch |
| 2026-05-28 | A/AVD | stability(meminfo) | INFO | see meminfo-start/30s.txt (compare TOTAL PSS for growth) |
| 2026-05-28 | A/AVD | layout-capture | ISSUE | (1) LANDSCAPE TUNER breaks — strobe overdraws the toggle + DRONE clipped; REAL (app.json orientation="default" allows landscape) → task #69. (2) Portrait: AVD swiftshader mis-renders the strobe (the real Pixel renders it fine) ⟹ headless-GL AVD is UNRELIABLE for GL-component layout review — use the Pixel, or try `-gpu swangle_indirect`/`-gpu host`. AVD stays valid for regression/crash/functional/stability. |
| 2026-05-28 | A/AVD | monkey-fuzz | GREEN | 2000 random events @100ms, NO crash (crash buffer empty). App survives heavy fuzzing. |
| 2026-05-28 | A/AVD | CentArc layout | ISSUE | DEFAULT tuner style (arc) renders OVERLAPPING the TUNER/CUSTOMIZATION toggle + gap below, on pixel_7 1080×2400. RN-layout (swiftshader-independent) → real. Pixel was on STROBE style so this arc bug was never seen there — may be the operator's actual #67 "floating tuner". Investigating CentArc/tunerWidgets. |
| 2026-05-28 | A/AVD matrix | TUNER layout | ISSUE | #69+#70 REPRODUCE across 3 configs: bc_test pixel_7 portrait (arc overlaps toggle), phone landscape (break), bc_tablet 2560×1600 landscape (arc overlaps toggle + +00¢/TAP-LOG/COLLECT jumble). ⟹ REAL responsive-layout bug in TunerScreen (centerPortrait centering + arc stack overflow), NOT config-specific/swiftshader. Fix-diagnosis sub-agent dispatched. |
| 2026-05-28 | A/off | audit: accuracy (pitch/cents/A4) | GREEN | sauron: 0 crit/warn. YIN + cents + transposition + drone/pipes pitchBend traced mic→display→disk→synth, verified by hand. Only cosmetic: 0.5¢ tier raw toFixed(1) in 2/3 widgets (→#13). |
| 2026-05-28 | A/off | audit: hardening (crash/edge) | GREEN | uruk-hai: CLEAN. Consistent clamping (A4/BPM/MIDI/vel), NaN/Inf guards, div-by-0 guards, lifecycle teardown; silence-over-wrong upheld. |
| 2026-05-28 | A/off | audit: perf/leaks/anim | INFO | legolas: NO unbounded leaks. 7 warn (RAF tick runs 120Hz off-tuner-tab; un-debounced prefs setters; bus Array.from per MIDI event; runOnJS re-arm on BPM scrub) + 8 note → #12. |
| 2026-05-28 | A/off | audit: UX/states/a11y | ISSUE | frodo: 1 CRITICAL — metro profiles never persist, lost on restart (#10) — +5 warn (DRONE-ON lies before pitch lock; TUNER CLEAR no confirm/undo; stepper no limit feedback; no haptics on TAP/START/RECORD) + 4 note → #10/#11. |
| 2026-05-28 | A/off | audit: style/dead-code | INFO | gollum: 5 nits — dead arcNeedleTip; 2 stray console.warn; unused freqToMidi export → #13. |
| 2026-05-28 | A/AVD | #70 fix (Edit 1) | GREEN | VERIFIED bc_test pixel_7: built release APK (JS re-bundled — createBundleReleaseJsAndAssets ran), LIVE-mode CentArc now renders cleanly BELOW the TUNER/CUSTOMIZATION toggle — overlap GONE, arc top-anchored (avd-tuner-70fix-LIVE.png). COLLECT-mode bucket card also clean (avd-tuner-70fix-portrait.png). |
| 2026-05-28 | A/AVD | metro persistence (gandalf) | PARTIAL | MetroScreen renders all 4 User profiles post-refactor, NO crash (avd-metro-postfix.png); tsc+jest GREEN. NOT YET demonstrated: edit-survives-restart (blind-tap UI drive unreliable on AVD → defer to Pixel/instrumented). Impl: profiles lifted to useMetronome, persisted via prefsUpdate(metroProfilesJson), legacy-safe fallback. |
| 2026-05-28 | A/AVD | monkey-smoke (post-batch) | GREEN | 800 events @80ms across all screens incl. refactored METRO — crash buffer empty, no FATAL. |
| 2026-05-28 | A/off | batch tsc+jest | GREEN | tsc_rc=0; legacy yin pitch-math + renderCount pass. Batch = #70 layout + 5 polish nits + metro-persistence + test mock. |
