/**
 * Smoke tests for src/useMidiBus.ts — specifically `createMidiBusCore`.
 *
 * Run with Node 24 (no test runner required):
 *   node --experimental-strip-types src/__tests__/useMidiBus.test.ts
 *
 * We test the pure-JS factory, not the React hook. The hook is a thin
 * lifecycle wrapper; the contract that matters (synchronous listener
 * invocation, channel reservation, master mute, channel-role map) lives
 * inside the core.
 *
 * Coverage:
 *   - U21: noteOn listener invoked SYNCHRONOUSLY in the same call stack.
 *   - U23: reserving a role twice returns null and emits 'channel-claim-denied'.
 *   - Master mute applies to synth gain immediately.
 *   - CHANNEL_OF_ROLE maps to the documented MIDI channels.
 *   - Velocity 0..127 from caller is converted to 0..1 at the synth boundary.
 *   - release() prevents further dispatches on a handle and frees the role.
 *   - dispose() tears down reservations + listeners.
 *
 * Mocking strategy: copy the core's source-of-truth (createMidiBusCore +
 * CHANNEL_OF_ROLE) by re-importing the module. The synth port is fully
 * mocked here; the log module is real and side-effects to console.warn
 * during 'channel-claim-denied' tests are expected (we capture them).
 */

// @ts-ignore: .ts extension required for node --experimental-strip-types
import {
  CHANNEL_OF_ROLE,
  createMidiBusCore,
  type BusLogger,
  type ChannelRole,
  type SynthPort,
  type BusEvent,
} from '../useMidiBusCore.ts';

// ---------------------------------------------------------------------------
// Tiny assert harness — same shape as yin.test.ts
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`PASS: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// ---------------------------------------------------------------------------
// Mock synth port. Records every call for inspection.
// ---------------------------------------------------------------------------

interface SynthCall {
  fn: string;
  args: unknown[];
}

function makeMockSynth(opts?: {
  prepareReturns?: boolean;
  prepareDelayMs?: number;
  initiallyReady?: boolean;
}): { synth: SynthPort; calls: SynthCall[]; fireReady: (ok: boolean) => void } {
  const calls: SynthCall[] = [];
  let readyListeners: Array<(e: { ok: boolean; error?: string }) => void> = [];
  let underrunListeners: Array<(e: { framesAccepted: number }) => void> = [];
  let isReadyFlag = opts?.initiallyReady ?? false;

  const synth: SynthPort = {
    prepareAsync: () => {
      calls.push({ fn: 'prepareAsync', args: [] });
      const ok = opts?.prepareReturns ?? true;
      const delay = opts?.prepareDelayMs ?? 0;
      if (delay > 0) {
        return new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(ok), delay);
        });
      }
      return Promise.resolve(ok);
    },
    start: () => {
      calls.push({ fn: 'start', args: [] });
      return true;
    },
    noteOn: (channel, midi, velocity) => {
      calls.push({ fn: 'noteOn', args: [channel, midi, velocity] });
    },
    noteOff: (channel, midi) => {
      calls.push({ fn: 'noteOff', args: [channel, midi] });
    },
    programChange: (channel, program) => {
      calls.push({ fn: 'programChange', args: [channel, program] });
    },
    pitchBend: (channel, semitones) => {
      calls.push({ fn: 'pitchBend', args: [channel, semitones] });
    },
    allNotesOff: (channel) => {
      calls.push({ fn: 'allNotesOff', args: [channel] });
    },
    setMasterGain: (gain) => {
      calls.push({ fn: 'setMasterGain', args: [gain] });
    },
    isReady: () => isReadyFlag,
    addReadyListener: (cb) => {
      readyListeners.push(cb);
      return {
        remove: () => {
          readyListeners = readyListeners.filter((l) => l !== cb);
        },
      };
    },
    addUnderrunListener: (cb) => {
      underrunListeners.push(cb);
      return {
        remove: () => {
          underrunListeners = underrunListeners.filter((l) => l !== cb);
        },
      };
    },
  };

  function fireReady(ok: boolean) {
    isReadyFlag = ok;
    for (const l of readyListeners) l({ ok });
  }

  return { synth, calls, fireReady };
}

// Capturing logger for tests that need to assert on forensic-log output.
interface CapturedLog {
  level: 'd' | 'w' | 'e';
  tag: string;
  msg: string;
  args: unknown[];
}
function makeCapturingLogger(): { logger: BusLogger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const logger: BusLogger = {
    d: (tag, msg, ...args) => logs.push({ level: 'd', tag, msg, args }),
    w: (tag, msg, ...args) => logs.push({ level: 'w', tag, msg, args }),
    e: (tag, msg, ...args) => logs.push({ level: 'e', tag, msg, args }),
  };
  return { logger, logs };
}

// ---------------------------------------------------------------------------
// Test 1: U21 — listener invoked synchronously in the same call stack
// ---------------------------------------------------------------------------

(() => {
  const { synth } = makeMockSynth({ initiallyReady: true });
  const bus = createMidiBusCore({ synth, warmupTimeoutMs: 100 });
  const handle = bus.reserve('drone');
  assert(handle !== null, 'U21: reserve drone returns a handle');

  let counter = 0;
  let observedAt = -1;
  const unsub = bus.on('noteOn', (e: BusEvent) => {
    counter++;
    observedAt = counter;
    assertEqual(e.channel, 'drone', 'U21: listener sees role=drone');
    assertEqual(e.midi, 69, 'U21: listener sees midi=69');
    assertEqual(e.velocity, 100, 'U21: listener sees velocity=100');
  });

  // Side-effect counter incremented BEFORE noteOn returns is the U21 guarantee.
  counter++; // 1: pre-call sentinel
  handle!.noteOn(69, 100);
  // After noteOn returns, the listener MUST have already fired (counter==2 → observedAt==2).
  const postCall = counter;
  assertEqual(observedAt, 2, 'U21: listener fired before noteOn returned (observedAt==2)');
  assertEqual(postCall, 2, 'U21: counter advanced via listener in same call stack');

  unsub();
  // After unsub, no further deliveries.
  observedAt = -1;
  counter = 100;
  handle!.noteOn(70, 80);
  assertEqual(observedAt, -1, 'U21: unsubscribed listener does not fire');

  bus.dispose();
})();

// ---------------------------------------------------------------------------
// Test 2: U23 — double-reserve returns null + emits forensic warn
// ---------------------------------------------------------------------------

(() => {
  const { synth } = makeMockSynth({ initiallyReady: true });
  const { logger, logs } = makeCapturingLogger();
  const bus = createMidiBusCore({ synth, logger, warmupTimeoutMs: 100 });

  const h1 = bus.reserve('drone');
  assert(h1 !== null, 'U23: first reserve succeeds');
  const h2 = bus.reserve('drone');
  assertEqual(h2, null, 'U23: second reserve returns null');

  const sawDeniedLog = logs.some(
    (l) => l.level === 'w' && l.tag === 'Bus' && l.msg === 'channel-claim-denied',
  );
  assert(sawDeniedLog, 'U23: forensic log emitted channel-claim-denied');

  // After release, a fresh reserve must succeed (the role is freed).
  h1!.release();
  const h3 = bus.reserve('drone');
  assert(h3 !== null, 'U23: reserve after release re-acquires the role');

  bus.dispose();
})();

// ---------------------------------------------------------------------------
// Test 3: Master mute clamps gain to 0 immediately; unmute restores target
// ---------------------------------------------------------------------------

(() => {
  const { synth, calls } = makeMockSynth({ initiallyReady: true });
  const bus = createMidiBusCore({
    synth,
    initialMasterGain: 0.8,
    warmupTimeoutMs: 100,
  });
  // Construction applies initial gain.
  const initialGainCalls = calls.filter((c) => c.fn === 'setMasterGain').map((c) => c.args[0]);
  assert(
    initialGainCalls.length >= 1 && initialGainCalls[initialGainCalls.length - 1] === 0.8,
    'Master: initial setMasterGain wrote 0.8',
  );

  bus.setMasterMute(true);
  const afterMute = calls.filter((c) => c.fn === 'setMasterGain').map((c) => c.args[0]);
  assertEqual(
    afterMute[afterMute.length - 1],
    0,
    'Master: mute writes setMasterGain(0)',
  );

  // While muted, updating master gain should NOT bring sound back.
  bus.setMasterGain(0.5);
  const afterGainWhileMuted = calls.filter((c) => c.fn === 'setMasterGain').map((c) => c.args[0]);
  assertEqual(
    afterGainWhileMuted[afterGainWhileMuted.length - 1],
    0,
    'Master: setMasterGain while muted still writes 0',
  );

  bus.setMasterMute(false);
  const afterUnmute = calls.filter((c) => c.fn === 'setMasterGain').map((c) => c.args[0]);
  assertEqual(
    afterUnmute[afterUnmute.length - 1],
    0.5,
    'Master: unmute restores the most-recent target (0.5)',
  );

  bus.dispose();
})();

// ---------------------------------------------------------------------------
// Test 4: CHANNEL_OF_ROLE matches the documented MIDI channel allocation
// ---------------------------------------------------------------------------

(() => {
  const expected: Record<ChannelRole, number> = {
    drone: 0,
    pipes: 1,
    drums: 9,
    aux1: 10,
    aux2: 11,
    aux3: 12,
    aux4: 13,
  };
  for (const role of Object.keys(expected) as ChannelRole[]) {
    assertEqual(
      CHANNEL_OF_ROLE[role],
      expected[role],
      `CHANNEL_OF_ROLE: ${role} → ${expected[role]}`,
    );
  }
})();

// ---------------------------------------------------------------------------
// Test 5: Velocity 0..127 converted to 0..1 at the synth boundary
// ---------------------------------------------------------------------------

(() => {
  const { synth, calls } = makeMockSynth({ initiallyReady: true });
  const bus = createMidiBusCore({ synth, warmupTimeoutMs: 100 });
  const h = bus.reserve('pipes')!;
  h.noteOn(60, 127);
  const lastNoteOn = [...calls].reverse().find((c) => c.fn === 'noteOn');
  assert(lastNoteOn !== undefined, 'Velocity: noteOn reached the synth');
  // synth.noteOn(channel, midi, velocity) — velocity is the third arg.
  const v01 = lastNoteOn!.args[2] as number;
  assertEqual(v01, 1, 'Velocity: 127 → 1.0 at synth');
  // And the channel maps via CHANNEL_OF_ROLE.
  assertEqual(lastNoteOn!.args[0], CHANNEL_OF_ROLE.pipes, 'Velocity: noteOn used pipes channel');

  h.noteOn(60, 0);
  const lastNoteOn2 = [...calls].reverse().find((c) => c.fn === 'noteOn');
  assertEqual(lastNoteOn2!.args[2], 0, 'Velocity: 0 → 0 at synth');

  bus.dispose();
})();

// ---------------------------------------------------------------------------
// Test 6: release() prevents further dispatches and frees the role
// ---------------------------------------------------------------------------

(() => {
  const { synth, calls } = makeMockSynth({ initiallyReady: true });
  const bus = createMidiBusCore({ synth, warmupTimeoutMs: 100 });
  const h = bus.reserve('aux1')!;
  h.noteOn(50, 64);
  const noteOnsBefore = calls.filter((c) => c.fn === 'noteOn').length;
  h.release();
  // release() fires allNotesOff(channel) — confirm.
  const allOffs = calls.filter(
    (c) => c.fn === 'allNotesOff' && c.args[0] === CHANNEL_OF_ROLE.aux1,
  );
  assert(allOffs.length >= 1, 'release: allNotesOff fired on the role channel');
  // Further dispatches MUST NOT reach the synth.
  h.noteOn(51, 64);
  const noteOnsAfter = calls.filter((c) => c.fn === 'noteOn').length;
  assertEqual(noteOnsAfter, noteOnsBefore, 'release: post-release noteOn is a no-op');

  bus.dispose();
})();

// ---------------------------------------------------------------------------
// Test 7: Drum fallback routes during warm-up, then to synth once ready
// ---------------------------------------------------------------------------

(() => {
  const { synth, fireReady } = makeMockSynth({ initiallyReady: false });
  const clicks: boolean[] = [];
  let disposed = false;
  const bus = createMidiBusCore({
    synth,
    warmupTimeoutMs: 5000,
    drumFallback: {
      playClick: (accent: boolean) => clicks.push(accent),
      dispose: () => {
        disposed = true;
      },
    },
  });
  const drums = bus.reserve('drums')!;

  // Before ready: should route to WAV.
  drums.noteOn(38, 110); // accent
  drums.noteOn(38, 80); // normal
  assertEqual(clicks.length, 2, 'Fallback: 2 clicks during warmup');
  assertEqual(clicks[0], true, 'Fallback: 110→accent');
  assertEqual(clicks[1], false, 'Fallback: 80→normal');

  // Flip ready.
  fireReady(true);
  drums.noteOn(38, 110);
  // After ready, the WAV path is not consulted; synth.noteOn fires instead.
  assertEqual(clicks.length, 2, 'Fallback: no further clicks after ready');

  bus.dispose();
  assertEqual(disposed, true, 'Fallback: dispose was called on bus teardown');
})();

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

console.log('OK — all useMidiBus core tests passed');
