/**
 * Smoke tests for src/useMidiBusCore.ts — createMidiBus (v1.4 factory).
 *
 * Run with Node 24 (no test runner required):
 *   node --experimental-strip-types src/__tests__/midiBus.test.ts
 *
 * Strategy: pure-JS mock of the MidiBusSynthPort surface. We assert that:
 *   1. noteOnAt routes through to synth.noteOnAt with the correct atFrame
 *      computed from the bus's frame-clock peg (wall-clock → frame).
 *   2. ChannelHandle.noteOnAt forwards the tick discriminator (beat/sub/none).
 *   3. The bus re-emits the native commandFired event as a normalised
 *      FiredEvent to subscribers.
 *   4. Repeg advances the peg origin; subsequent atMsToAtFrame uses the new
 *      origin (no off-by-one accumulation).
 *
 * NOT covered (requires native bridge):
 *   - JNI trampoline thread-attach correctness.
 *   - Render-quantum partition logic in synth.cpp.
 *   - AudioTrack write underrun behaviour.
 *
 * Adapted from Sauron's midiBus.test.ts: SynthPort → MidiBusSynthPort so the
 * lightweight mock (no prepareAsync/start/addReadyListener) satisfies the
 * narrower createMidiBus port type.
 */

// @ts-ignore: .ts extension required for node --experimental-strip-types
import {
  createMidiBus,
  createMidiBusCore,
  vel127To01,
  CHANNEL_OF_ROLE,
  type FiredPayload,
  type MidiBusSynthPort,
  type SynthPort,
} from '../useMidiBusCore.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) { console.error(`FAIL: ${message}`); process.exit(1); }
  console.log(`PASS: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// MidiBusSynthPort mock — captures calls and lets the test inject a frame clock.
// ---------------------------------------------------------------------------

interface NoteOnAtCall {
  channel: number; midi: number; velocity: number; atFrame: number; tickKind: number;
}

function makeMockSynth(initialFrame: number = 0): {
  port: MidiBusSynthPort;
  setFrame: (f: number) => void;
  fire: (p: FiredPayload) => void;
  calls: { noteOn: any[]; noteOnAt: NoteOnAtCall[]; noteOff: any[]; allNotesOff: number[] };
} {
  let currentFrame = initialFrame;
  const callsNoteOn: any[] = [];
  const callsNoteOnAt: NoteOnAtCall[] = [];
  const callsNoteOff: any[] = [];
  const callsAllNotesOff: number[] = [];
  const firedListeners: Array<(e: FiredPayload) => void> = [];

  const port: MidiBusSynthPort = {
    noteOn(channel, midi, velocity) { callsNoteOn.push({ channel, midi, velocity }); },
    noteOff(channel, midi) { callsNoteOff.push({ channel, midi }); },
    programChange() { /* unused in tests */ },
    pitchBend() { /* unused */ },
    allNotesOff(channel) { callsAllNotesOff.push(channel); },
    noteOnAt(channel, midi, velocity, atFrame, tickKind) {
      callsNoteOnAt.push({ channel, midi, velocity, atFrame, tickKind });
    },
    getCurrentFrame() { return currentFrame; },
    addCommandFiredListener(cb) {
      firedListeners.push(cb);
      return { remove() {
        const i = firedListeners.indexOf(cb);
        if (i >= 0) firedListeners.splice(i, 1);
      } };
    },
  };

  return {
    port,
    setFrame(f) { currentFrame = f; },
    fire(p) { for (const cb of firedListeners) cb(p); },
    calls: { noteOn: callsNoteOn, noteOnAt: callsNoteOnAt, noteOff: callsNoteOff, allNotesOff: callsAllNotesOff },
  };
}

// ---------------------------------------------------------------------------
// 1. Frame-clock peg math.
//
// Peg at t=10_000 ms, frame=44100. SampleRate=44100. atMs=10_500 ms must
// resolve to atFrame = 44100 + (500 * 44100 / 1000) = 44100 + 22050 = 66150.
// ---------------------------------------------------------------------------

{
  const mock = makeMockSynth(44100);
  let nowMs = 10_000;
  const bus = createMidiBus({
    synth: mock.port,
    sampleRate: 44100,
    now: () => nowMs,
    repegIntervalMs: 0, // disable auto-repeg; we control peg explicitly
  });
  // Manual initial peg at the snapshot above.
  bus.repeg();

  const af = bus.atMsToAtFrame(10_500);
  assertEqual(af, 66150, 'atMsToAtFrame at +500ms');

  const af2 = bus.atMsToAtFrame(10_000);
  assertEqual(af2, 44100, 'atMsToAtFrame at peg origin');

  const af3 = bus.atMsToAtFrame(9_500);
  assertEqual(af3, 22050, 'atMsToAtFrame at -500ms (past) — still valid; native treats as fire-ASAP');

  bus.dispose();
}

// ---------------------------------------------------------------------------
// 2. ChannelHandle.noteOnAt forwards with tick discriminator.
// ---------------------------------------------------------------------------

{
  const mock = makeMockSynth(0);
  let nowMs = 1_000;
  const bus = createMidiBus({
    synth: mock.port,
    sampleRate: 44100,
    now: () => nowMs,
    repegIntervalMs: 0,
  });
  bus.repeg(); // peg at (1000ms, frame=0)

  const ch = bus.channel(9);
  ch.noteOnAt(60, 100, 1_010, 'beat');  // +10 ms → 441 frames
  ch.noteOnAt(62, 80, 1_020, 'sub');    // +20 ms → 882 frames
  ch.noteOnAt(64, 127, 1_030);          // default tick='none'

  assertEqual(mock.calls.noteOnAt.length, 3, 'three noteOnAt calls forwarded');
  assertEqual(mock.calls.noteOnAt[0].channel, 9, 'channel preserved');
  assertEqual(mock.calls.noteOnAt[0].midi, 60, 'midi preserved');
  assertEqual(mock.calls.noteOnAt[0].atFrame, 441, 'atFrame for +10ms');
  assertEqual(mock.calls.noteOnAt[0].tickKind, 1, 'tickKind beat=1');
  assertEqual(mock.calls.noteOnAt[1].tickKind, 2, 'tickKind sub=2');
  assertEqual(mock.calls.noteOnAt[2].tickKind, 0, 'tickKind none=0 (default)');

  // Velocity is 0..1 normalised.
  assertEqual(mock.calls.noteOnAt[0].velocity, 100 / 127, 'velocity 100/127');
  assertEqual(mock.calls.noteOnAt[2].velocity, 1, 'velocity 127 → 1.0');

  bus.dispose();
}

// ---------------------------------------------------------------------------
// 3. Re-emit native commandFired as bus FiredEvent.
// ---------------------------------------------------------------------------

{
  const mock = makeMockSynth(0);
  const bus = createMidiBus({
    synth: mock.port,
    sampleRate: 44100,
    now: () => 0,
    repegIntervalMs: 0,
  });

  const seen: any[] = [];
  const unsub = bus.addFiredListener((e) => seen.push(e));

  // Native fires NoteOn (kind=1) tickKind=1 (beat).
  mock.fire({ kind: 1, tickKind: 1, channel: 9, midi: 37, velocity: 0.78, atFrame: 12345 });
  // Native fires NoteOff (kind=2) tickKind=0.
  mock.fire({ kind: 2, tickKind: 0, channel: 9, midi: 37, velocity: 0, atFrame: 12500 });

  assertEqual(seen.length, 2, 'two events re-emitted');
  assertEqual(seen[0].kind, 'noteOn', 'first event kind=noteOn');
  assertEqual(seen[0].tick, 'beat', 'first event tick=beat');
  assertEqual(seen[0].channel, 9, 'first event channel preserved');
  assertEqual(seen[0].midi, 37, 'first event midi preserved');
  assertEqual(seen[0].atFrame, 12345, 'first event atFrame preserved');
  assertEqual(seen[1].kind, 'noteOff', 'second event kind=noteOff');
  assertEqual(seen[1].tick, 'none', 'second event tick=none');

  unsub();
  mock.fire({ kind: 1, tickKind: 1, channel: 9, midi: 38, velocity: 1, atFrame: 99999 });
  assertEqual(seen.length, 2, 'no events after unsubscribe');

  bus.dispose();
}

// ---------------------------------------------------------------------------
// 4. Repeg moves the origin; subsequent math uses the new origin.
// ---------------------------------------------------------------------------

{
  const mock = makeMockSynth(0);
  let nowMs = 1_000;
  const bus = createMidiBus({
    synth: mock.port,
    sampleRate: 44100,
    now: () => nowMs,
    repegIntervalMs: 0,
  });
  bus.repeg(); // peg (1000ms, 0)

  // 5 seconds later, advance frame to 220_500 (= 5 * 44100). A faithful
  // peg sample at this moment should yield (6000ms, 220500) — i.e. the
  // ratio holds; any future atMs computes against the new origin without
  // accumulating bias.
  nowMs = 6_000;
  mock.setFrame(220_500);
  bus.repeg();

  // atMs = 6_500 → +500ms → +22050 frames → 242550.
  const af = bus.atMsToAtFrame(6_500);
  assertEqual(af, 242550, 'atMsToAtFrame after repeg');

  bus.dispose();
}

// ---------------------------------------------------------------------------
// 5. vel127To01 helper boundary behaviour.
// ---------------------------------------------------------------------------

{
  assertEqual(vel127To01(0), 0, 'vel 0 → 0');
  assertEqual(vel127To01(127), 1, 'vel 127 → 1');
  assertEqual(vel127To01(-5), 0, 'vel <0 clamped to 0');
  assertEqual(vel127To01(200), 1, 'vel >127 clamped to 1');
  assertEqual(vel127To01(64), 64 / 127, 'vel 64 mid-range');
  assertEqual(vel127To01(Number.NaN), 0, 'vel NaN → 0');
}

// ---------------------------------------------------------------------------
// 6. v1.4 Belt 1 — clearScheduled() routes through to synth.clearScheduled.
// ---------------------------------------------------------------------------

{
  let cleared = 0;
  const mock = makeMockSynth(0);
  // Extend the mock with a clearScheduled probe.
  (mock.port as any).clearScheduled = () => { cleared += 1; };

  const bus = createMidiBus({
    synth: mock.port,
    sampleRate: 44100,
    now: () => 0,
    repegIntervalMs: 0,
  });

  bus.clearScheduled();
  assertEqual(cleared, 1, 'Belt-1: bus.clearScheduled forwards to synth.clearScheduled');

  bus.clearScheduled();
  assertEqual(cleared, 2, 'Belt-1: clearScheduled is idempotent (calls each time)');

  bus.dispose();
}

// ---------------------------------------------------------------------------
// 7. v1.4 Belt 1 — clearScheduled on a port without the method is a no-op.
// ---------------------------------------------------------------------------

{
  const mock = makeMockSynth(0);
  // Ensure no clearScheduled is present.
  delete (mock.port as any).clearScheduled;

  const bus = createMidiBus({
    synth: mock.port,
    sampleRate: 44100,
    now: () => 0,
    repegIntervalMs: 0,
  });

  let threw = false;
  try { bus.clearScheduled(); } catch { threw = true; }
  assertEqual(threw, false, 'Belt-1: clearScheduled on legacy port is silent no-op (no throw)');

  bus.dispose();
}

// ---------------------------------------------------------------------------
// 8. v1.4 Belt 2 — past-atFrame check primitives (atMsToAtFrame, currentFrame
//     comparison). Verifies the math underpinning useMetronome's schedule()
//     guard: a wall-clock target in the past projects to an atFrame strictly
//     less than the synth's current frame.
// ---------------------------------------------------------------------------

{
  const mock = makeMockSynth(0);
  let nowMs = 1_000;
  const bus = createMidiBus({
    synth: mock.port,
    sampleRate: 44100,
    now: () => nowMs,
    repegIntervalMs: 0,
  });
  bus.repeg(); // peg (1000ms, 0)

  // Advance the synth frame clock to 44100 (1 second of real time) without
  // re-pegging. atMs=1500 is "in the past" if currentFrame has advanced past
  // its projected position. Project: 1500ms is 500ms after the peg origin →
  // atFrame=22050. currentFrame=44100. atFrame < currentFrame → past.
  mock.setFrame(44100);
  const atFrame = bus.atMsToAtFrame(1_500);
  assertEqual(atFrame, 22050, 'Belt-2: atFrame for atMs in the past');
  const currentFrame = mock.port.getCurrentFrame ? mock.port.getCurrentFrame() : 0;
  assert(atFrame < currentFrame, 'Belt-2: atFrame strictly < currentFrame for past atMs');

  // Forward case: atMs in the future projects to atFrame > currentFrame.
  // atMs=2_000 → 1000ms after peg → atFrame=44100. currentFrame=44100.
  // atFrame == currentFrame is the boundary (treated as past per spec '<=').
  const atFrameFuture = bus.atMsToAtFrame(2_500);
  assertEqual(atFrameFuture, 66150, 'Belt-2: atFrame for atMs in the future');
  assert(atFrameFuture > currentFrame, 'Belt-2: atFrame strictly > currentFrame for future atMs');

  bus.dispose();
}

// ---------------------------------------------------------------------------
// 9. Drift gate — steady clock drift is ACCEPTED and tracked.
//
// Regression test for the bug that shipped a dead/late metronome: the audio
// DAC crystal vs system wall clock drift (~1300 ppm observed on a Pixel 9 Pro,
// ~6.5ms per 5s interval). The old 2ms gate rejected EVERY auto-repeg → peg
// went permanently stale → unbounded scheduling error. The gate (now 50ms)
// must ACCEPT steady drift and keep tracking it across intervals.
//
// We detect accept-vs-reject by observing the origin through atMsToAtFrame:
// an accepted repeg moves the origin; a rejected one holds the prior origin.
// ---------------------------------------------------------------------------

{
  const mock = makeMockSynth(0);
  let nowMs = 1_000;
  const bus = createMidiBus({ synth: mock.port, sampleRate: 44100, now: () => nowMs, repegIntervalMs: 0 });
  bus.repeg(); // peg (1000ms, frame 0)

  // 5s later the frame counter advanced at ~44044/s (vs nominal 44100) → ~6.35ms
  // behind the nominal projection. Legitimate drift; must be accepted.
  nowMs = 6_000;
  mock.setFrame(220_220); // 44044 * 5
  bus.repeg();
  assertEqual(bus.atMsToAtFrame(6_000), 220_220, 'drift gate: steady ~1300ppm drift ACCEPTED (peg tracks)');

  // Another interval — still < 50ms per step, so it keeps tracking (no
  // permanent staleness — exactly the bug we fixed).
  nowMs = 11_000;
  mock.setFrame(440_440);
  bus.repeg();
  assertEqual(bus.atMsToAtFrame(11_000), 440_440, 'drift gate: steady drift keeps tracking across intervals');

  bus.dispose();
}

// ---------------------------------------------------------------------------
// 10. Drift gate — a process-pause-sized step is REJECTED, prior peg held.
// ---------------------------------------------------------------------------

{
  const mock = makeMockSynth(0);
  let nowMs = 1_000;
  const bus = createMidiBus({ synth: mock.port, sampleRate: 44100, now: () => nowMs, repegIntervalMs: 0 });
  bus.repeg(); // peg (1000ms, 0)

  // 5s of wall time pass but the renderer froze ~4s (only 1s of frames): implied
  // shift ~4000ms ≫ 50ms → REJECTED. The OLD origin is held, so atMsToAtFrame
  // projects from (1000, 0): 0 + round(5000·44.1) = 220500 (NOT the new 44100).
  nowMs = 6_000;
  mock.setFrame(44_100);
  bus.repeg();
  assertEqual(bus.atMsToAtFrame(6_000), 220_500, 'drift gate: process-pause step REJECTED (prior peg held)');

  bus.dispose();
}

// ---------------------------------------------------------------------------
// 11. Peg guard — never anchor to frame 0 (renderer not ticked / just reset).
// ---------------------------------------------------------------------------

{
  const mock = makeMockSynth(100_000);
  let nowMs = 1_000;
  const bus = createMidiBus({ synth: mock.port, sampleRate: 44100, now: () => nowMs, repegIntervalMs: 0 });
  bus.repeg(); // peg (1000ms, 100000)

  // getCurrentFrame returns 0 (e.g. just after a track re-init). Pegging here
  // would map wall-clock onto a counter about to jump from 0. Must be skipped;
  // old origin held → atMsToAtFrame(2000) = 100000 + round(1000·44.1) = 144100.
  nowMs = 2_000;
  mock.setFrame(0);
  bus.repeg();
  assertEqual(bus.atMsToAtFrame(2_000), 144_100, 'peg guard: newFrame<=0 SKIPPED (never anchor to frame 0)');

  bus.dispose();
}

// ---------------------------------------------------------------------------
// 12. Peg guard — a backward wall-clock step (NTP/DST) is skipped.
// ---------------------------------------------------------------------------

{
  const mock = makeMockSynth(220_500);
  let nowMs = 5_000;
  const bus = createMidiBus({ synth: mock.port, sampleRate: 44100, now: () => nowMs, repegIntervalMs: 0 });
  bus.repeg(); // peg (5000ms, 220500)

  // now() jumps backward (clock correction). Committing it would corrupt the
  // origin pair. Must be skipped; old origin held → atMsToAtFrame(5000) = 220500.
  nowMs = 4_000;
  mock.setFrame(264_600);
  bus.repeg();
  assertEqual(bus.atMsToAtFrame(5_000), 220_500, 'peg guard: backward wall-clock step SKIPPED');

  bus.dispose();
}

// ---------------------------------------------------------------------------
// 13. emit listener snapshot — unsubscribe-during-callback (gates future
//     size===1 fast-path in firedListeners iteration, and N-listener snapshot
//     guarantee).
//
// Regression for the #64 timing-critical bus: all listeners present at emit-
// time must be called exactly once on THAT emit even when one of them
// unsubscribes itself mid-loop. The removing listener (B) must NOT be called
// on the NEXT emit; A and C must continue to be called.
//
// Additionally, the single-listener degenerate case is pinned: exactly one
// subscriber → one emit → invoked exactly once.  This is the path a future
// size===1 fast-path would special-case, so we lock its behavior now before
// the optimisation ships.
// ---------------------------------------------------------------------------

{
  // --- N-listener (3) unsubscribe-during-callback ---
  const mock = makeMockSynth(0);
  const bus = createMidiBus({
    synth: mock.port,
    sampleRate: 44100,
    now: () => 0,
    repegIntervalMs: 0,
  });

  const seen: string[] = [];

  // Listener A — passive observer.
  const offA = bus.addFiredListener((_e) => { seen.push('A'); });

  // Listener B — removes itself during its own callback.
  let offB!: () => void;
  offB = bus.addFiredListener((_e) => {
    seen.push('B');
    offB(); // self-unsubscribe mid-emit
  });

  // Listener C — passive observer.
  const offC = bus.addFiredListener((_e) => { seen.push('C'); });

  // First emit: all three are subscribed at emit-time → all three must fire.
  mock.fire({ kind: 1, tickKind: 0, channel: 0, midi: 60, velocity: 0.5, atFrame: 1 });

  assertEqual(seen.length, 3, 'emit-snapshot: all 3 listeners fired on first emit');
  assertEqual(seen[0], 'A', 'emit-snapshot: A fired first');
  assertEqual(seen[1], 'B', 'emit-snapshot: B fired second (before self-unsubscribe took effect)');
  assertEqual(seen[2], 'C', 'emit-snapshot: C fired third');

  // Second emit: B has unsubscribed → only A and C must fire.
  seen.length = 0;
  mock.fire({ kind: 1, tickKind: 0, channel: 0, midi: 61, velocity: 0.5, atFrame: 2 });

  assertEqual(seen.length, 2, 'emit-snapshot: only 2 listeners on second emit (B removed)');
  assertEqual(seen[0], 'A', 'emit-snapshot: A still fires after B removed');
  assertEqual(seen[1], 'C', 'emit-snapshot: C still fires after B removed');

  offA();
  offC();
  bus.dispose();
}

{
  // --- single-listener degenerate case (fast-path pin) ---
  const mock = makeMockSynth(0);
  const bus = createMidiBus({
    synth: mock.port,
    sampleRate: 44100,
    now: () => 0,
    repegIntervalMs: 0,
  });

  let singleCount = 0;
  const offSingle = bus.addFiredListener((_e) => { singleCount += 1; });

  mock.fire({ kind: 1, tickKind: 0, channel: 0, midi: 60, velocity: 0.5, atFrame: 1 });

  assertEqual(singleCount, 1, 'emit-snapshot single: exactly one invocation for one subscriber');

  // A second fire — still exactly one invocation per emit.
  mock.fire({ kind: 1, tickKind: 0, channel: 0, midi: 61, velocity: 0.5, atFrame: 2 });
  assertEqual(singleCount, 2, 'emit-snapshot single: exactly two total invocations after two emits');

  offSingle();
  bus.dispose();
}

// ---------------------------------------------------------------------------
// 14. resolveRole correctness — reserve → fire → release → re-reserve
//     (gates a planned reverse channel→role map in createMidiBusCore).
//
// Uses createMidiBusCore (the role-bus) because resolveRole is the internal
// helper that maps a raw MIDI channel number back to a ChannelRole for the
// re-emitted BusEvent. createMidiBus has no roles (its FiredEvent.channel is
// always the raw numeric channel).
//
// Scenario:
//   1. Reserve 'pipes' → fire on CHANNEL_OF_ROLE['pipes'] → BusEvent.channel
//      must equal 'pipes'.
//   2. Release the reservation, re-reserve 'pipes', fire again → role still
//      resolves correctly (no stale attribution from the old handle).
//   3. Fire on an UNRESERVED channel (no current reservation) → BusEvent.channel
//      falls back to 'drone' (the documented sentinel for unregistered channels).
// ---------------------------------------------------------------------------

{
  // Minimal SynthPort stub for createMidiBusCore — satisfies the interface
  // without touching native code.
  const firedCbs: Array<(e: FiredPayload) => void> = [];
  const corePort: SynthPort = {
    prepareAsync()   { return Promise.resolve(true); },
    start()          { return true; },
    isReady()        { return true; },
    noteOn()         { /* noop */ },
    noteOff()        { /* noop */ },
    programChange()  { /* noop */ },
    pitchBend()      { /* noop */ },
    allNotesOff()    { /* noop */ },
    setMasterGain()  { /* noop */ },
    addReadyListener(_cb) { return { remove() {} }; },
    addCommandFiredListener(cb) {
      firedCbs.push(cb);
      return { remove() {
        const i = firedCbs.indexOf(cb);
        if (i >= 0) firedCbs.splice(i, 1);
      }};
    },
  };

  function fireCore(p: FiredPayload): void {
    for (const cb of firedCbs) cb(p);
  }

  const core = createMidiBusCore({
    synth: corePort,
    repegIntervalMs: 0,
  });

  const seenRoles: string[] = [];
  core.on('noteOn', (e) => { seenRoles.push(e.channel as string); });

  // 1. Reserve 'pipes', fire on its channel → must attribute to 'pipes'.
  const pipesChannel = CHANNEL_OF_ROLE['pipes']; // = 1
  const handle = core.reserve('pipes');
  assert(handle !== null, 'resolveRole: reserve pipes returned a handle');

  fireCore({ kind: 1, tickKind: 0, channel: pipesChannel, midi: 60, velocity: 0.5, atFrame: 1 });
  assertEqual(seenRoles.length, 1, 'resolveRole: one noteOn event emitted');
  assertEqual(seenRoles[0], 'pipes', 'resolveRole: channel attributed to pipes (reserved)');

  // 2. Release and re-reserve; fire again → must still attribute to 'pipes'.
  handle!.release();
  const handle2 = core.reserve('pipes');
  assert(handle2 !== null, 're-reserve: second reserve returned a handle');

  seenRoles.length = 0;
  fireCore({ kind: 1, tickKind: 0, channel: pipesChannel, midi: 61, velocity: 0.5, atFrame: 2 });
  assertEqual(seenRoles.length, 1, 'resolveRole re-reserve: one noteOn event emitted');
  assertEqual(seenRoles[0], 'pipes', 'resolveRole re-reserve: channel still attributed to pipes after release+re-reserve');

  // 3. Fire on an unreserved channel → must fall back to 'drone'.
  const unusedChannel = CHANNEL_OF_ROLE['aux4']; // = 13, never reserved
  seenRoles.length = 0;
  fireCore({ kind: 1, tickKind: 0, channel: unusedChannel, midi: 62, velocity: 0.5, atFrame: 3 });
  assertEqual(seenRoles.length, 1, 'resolveRole fallback: one noteOn event emitted for unreserved channel');
  assertEqual(seenRoles[0], 'drone', 'resolveRole fallback: unreserved channel falls back to drone');

  core.dispose();
}

console.log('ALL PASS: midiBus.test.ts');
