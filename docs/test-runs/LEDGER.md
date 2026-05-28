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
