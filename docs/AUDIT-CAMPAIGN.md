# v1.4 Audit Campaign — Methodology

This document captures how the v1.4 audit campaign was run so future sessions
can pick up the same pattern without rediscovering it.

---

## The wave loop

1. **Dispatch** 5–10 Uruk-Hai (haiku-class agents, fast + cheap) to review the
   codebase through a single audit lens each. Each Uruk files findings as
   critical / high / medium / false-positive.
2. **Triage**: Sonnet (coordinator) reads all findings, merges duplicates,
   rejects false-positives, and ranks the remainder.
3. **Patch**: Sonnet characters (Treebeard, Aragorn, Legolas, Frodo) each own
   their domain and write the fixes.
4. **Rebuild + install**: `npm run prebuild && npm run build:android`, sideload
   to the Pixel 9 Pro, smoke-test the affected flows.
5. **Next wave**: rotate to the next lens or repeat the same lens until it
   comes back clean.

Convergence rule: **3 consecutive clean waves on a lens** OR clearly
diminishing returns (all remaining findings are medium/note + tablet-validated)
signals that lens is done.

---

## Triage tiers

| Tier | Definition | Action |
|---|---|---|
| **Critical** | Ship-blocker — crash, data loss, silent wrong output, audio routing hole | Fix before next build |
| **High** | Fix this cycle — noticeable to a daily user, affects core flows | Fix in current wave |
| **Medium** | Backlog — real issue but not breaking anything today | File, fix in next cycle |
| **False-positive** | Uruk misread the code — no actual bug | Document the pattern so it doesn't recur |

False-positive rate across the v1.4 campaign ran roughly 30–40 % per wave.
Document the false-positive reason so the next wave's prompt can exclude it.

---

## The 9 audit lenses

Each lens is a focused question the Uruk-Hai answer for every screen and hook.

### 1. Silence over wrong
Wrong output is worse than silence. Check: does the code emit audio/events
when it cannot guarantee correctness? Targets: past-atFrame command drops,
late command rejection, YIN results from corrupted buffers, drone notes fired
while muted.

### 2. Drone dead-on
Every pitch change must re-anchor — `noteOff` + `noteOn` + A4-only
`pitchBend`. No frequency chase ("slide to the new pitch over N ms"). No
state drift where the synth pitch and the UI pitch diverge. Only A4
calibration changes go through `pitchBend`; everything else is a hard
note-change.

### 3. Real-time scheduling determinism
Beats must arrive at audio hardware at the promised frame, not at a JS event
loop approximation. Check: frame-clock peg freshness, past-atFrame drop
threshold, WAV/synth parallel-fire consistency, clearScheduled on stop/resume,
`noteOff` drain, `start(preservePhase)` correctness.

### 4. Animation smoothness
Every animated value must use the native driver. No two tweens targeting the
same node must run concurrently (stop before start). Duration must be stable
across rerenders (no recalculation that resets an in-flight animation). Check
PendulumDisplay, PulseDisplay, FlashDisplay, LedRowDisplay, StrobeDisplay.

### 5. Display sizes
Primary target: Pixel 9 Pro (landscape tablet, ~1344x2992 px, ~490 dp wide in
landscape). Secondary: 360 dp phones (must not overflow or clip). Check:
PitchPipes column grid, IntonationTable percentage columns, LedRow bar sizing,
drum picker rows, bottom sheet snap points, font scaling.

### 6. Transient state glitches
UI transitions must be atomic (pass through silence / blank, never through a
wrong intermediate state). Check: instrument switch must reset YIN before
emitting new pitch; profile load must batch all state before any render;
mute/unmute must coordinate drone + metronome together (bus master-mute);
native start/stop race paths.

### 7. Empty / loading / error states
Every screen must explicitly handle all three states. "Loading" must show a
spinner or skeleton — never a blank screen with no feedback. "Empty" must show
a prompt, not nothing. "Error" must say what failed and what the user can do.
Check all four tab screens plus bottom sheets and modals.

### 8. Microinteractions
Tap targets must give visual feedback within one frame (opacity / scale change
via native driver). Disabled controls must look disabled and not accept input.
Toast durations must match the message length (short messages ≤ 2 s; multi-
line ≤ 4 s). Haptic feedback on destructive actions and key confirmations.
Long-press affordances must be discoverable or documented in-UI.

### 9. Long-session stability
After 30+ minutes of continuous use: memory growth must be flat, not a slow
leak. Wake-lock must be released if the app backgrounds. File handles must
close after DECK takes finish. `bucketAccumsRef` must be capped. Audio focus
must be relinquished cleanly. No dangling RAF/timer callbacks after unmount.

### 10. Audio routing
Speaker, wired headphones, Bluetooth SCO, Bluetooth A2DP, USB audio, Android
Auto. Check: `AudioFocus` listener wired; route-change events handled;
`AudioCapture` sample-rate fallback for BT SCO (which forces 16 kHz);
auto-mic-claim module asserts priority; drone + metronome both route to the
correct output after a route change.

---

## Sonnet character roles

| Character | Domain |
|---|---|
| **Treebeard** | State machines, hooks, data-flow correctness, persistence |
| **Aragorn** | Native modules, security, audio focus, platform edge cases |
| **Legolas** | Performance, display, audio engine, animation, scheduling |
| **Frodo** | UX, error messages, user-facing states, docs |

On UX-axis questions, Frodo's vote is decisive per the saved council weighting
(`lotc-council-ux-weighting.md`).

---

## Wave-by-wave summary

The v1.4 campaign ran at least 3 complete waves before convergence. Specific
per-wave records were not persisted to disk; the table below summarises the
pattern from the commit history and triage notes.

| Wave | Primary lens(es) | Findings dispatched | Confirmed real | False-positives | Outcome |
|---|---|---|---|---|---|
| 1 | silence-over-wrong, scheduling | ~10 | 8 | 2 | Patch: past-atFrame drop, clearScheduled, noteOff drain |
| 2 | drone dead-on, transient state | ~8 | 5 | 3 | Patch: dead-on refactor, loadProfile batch, mute-leak |
| 3 | animation, display sizes | ~9 | 6 | 3 | Patch: LedRow, PitchPipes grid, tween stop-before-start |
| 4–13 | rotating lens coverage (all 10) | ~8 avg | ~4 avg | ~4 avg | ~120 total fixes across waves 1–13 |

"Confirmed real" counts only issues that produced a code change. Issues that
were real but deferred to a later version count as medium backlog, not
false-positives.

---

## How to continue next session

1. Read this file first.
2. Read `CHANGELOG.md` for the v1.4 summary — it captures the known-fixed set
   so you don't re-open closed bugs.
3. Pick the next unfinished lens (audio routing and long-session stability
   often have residual medium items).
4. Write a tight Uruk-Hai prompt: "You are reviewing BellCurve for [lens].
   Triage as critical / high / medium / false-positive. File findings in the
   standard format." Dispatch 5–8 agents.
5. Triage, patch, rebuild, install. Repeat.
6. Update this file with the new wave rows.

---

## Related docs

- `docs/v1.3-council-decisions.md` — locked design decisions (bus contracts,
  profile hydration, channel-claim policy, render-count CI gate).
- `docs/v1.3-metro-redesign.md` — Frodo's METRO tab design.
- `docs/v1.3-state-machine-scrub.md` — Gandalf's hook state-machine analysis.
