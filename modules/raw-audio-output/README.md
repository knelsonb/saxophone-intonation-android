# @local/raw-audio-output

TinySoundFont-backed General MIDI synthesiser for BellCurve. Replaces the
looped-WAV drone (and eventually the metronome) with a single bank-loaded
SF2 driven over an AudioTrack render thread.

## Architecture

```
JS (index.ts)
   ↓ requireNativeModule
RawAudioOutputModule.kt   (Expo Module — Function & AsyncFunction surface)
   ↓
SynthRenderer.kt   ← owns AudioTrack + render thread
   ↓ ShortArray.write loop
SynthBridge.kt   ← static native methods (JNI)
   ↓
jni_bridge.cpp + synth.cpp   ← thin C++ wrapper around tsf.h
   ↓
TinySoundFont (single-header MIT, vendored at cpp/tsf.h)
```

The SF2 (GeneralUser GS v2.0.3, ~30.8 MB) ships inside this module's
`android/src/main/assets/`. On `prepareAsync()` we copy it once into the
app's cache dir (TSF needs a filesystem path), then call `tsf_load_filename`.

## Smoke test (JS caller, will be executed by orchestrator in wave 2)

```ts
import synth from '@local/raw-audio-output';

async function smoke() {
  // 1. Prepare. Returns true when SF2 loaded + TSF initialised.
  const readyOk = await synth.prepareAsync();
  if (!readyOk) {
    console.error('synth failed to prepare');
    return;
  }

  // 2. Boot the render thread + AudioTrack.
  const started = synth.start();
  if (!started) {
    console.error('synth failed to start AudioTrack');
    return;
  }

  // 3. Pick a GM patch: 19 = Church Organ (the planned drone voice).
  synth.programChange(0, 19);

  // 4. Hold middle C for 2 s.
  synth.noteOn(0, 60, 1.0);
  await new Promise((r) => setTimeout(r, 2000));
  synth.noteOff(0, 60);

  // 5. Tear down.
  synth.stop();
}
```

Subscribe to lifecycle events for diagnostics:

```ts
const sub = synth.addReadyListener(({ ok, error }) =>
  console.log('synth ready:', ok, error ?? ''),
);
synth.addUnderrunListener(({ framesAccepted }) =>
  console.warn('underrun, accepted=', framesAccepted),
);
synth.addErrorListener(({ reason }) =>
  console.error('synth error:', reason),
);
// later: sub.remove();
```

## Function signatures (Sauron + Ent consume these in wave 2)

| Function | Signature | Notes |
| --- | --- | --- |
| `prepareAsync()` | `(): Promise<boolean>` | Idempotent. Fires `ready` event. ~50–150 ms on first call. |
| `start()` | `(): boolean` | Boots AudioTrack + worker. Returns true on success. |
| `stop()` | `(): boolean` | Pauses+flushes+releases AudioTrack. SF2 stays loaded. |
| `noteOn(ch, midi, vel)` | `(number, number, number): void` | ch 0–15, midi 0–127, vel 0.0–1.0. |
| `noteOff(ch, midi)` | `(number, number): void` | |
| `programChange(ch, prog)` | `(number, number): void` | GM patch 0–127, bank 0. |
| `pitchBend(ch, semitones)` | `(number, number): void` | –12.0 .. +12.0. Calls `tsf_channel_set_pitchrange(24)` so the full ±12 maps cleanly. |
| `allNotesOff(ch)` | `(number): void` | TSF `sounds_off_all`. |
| `setMasterGain(gain)` | `(number): void` | Linear. 1.0 = unity, 2.0 ≈ +6 dB. |
| `isReady()` | `(): boolean` | True after `prepareAsync` resolves true. |

Events:
- `ready` → `{ ok: boolean; error?: string }`
- `audioOutputUnderrun` → `{ framesAccepted: number }`
- `audioOutputError` → `{ reason: string }`

## License

- TSF: MIT, see [`LICENSE-TSF`](./LICENSE-TSF).
- SF2: GeneralUser GS, free-for-any-use, see [`LICENSE-SF2`](./LICENSE-SF2)
  (includes the file's SHA256 + upstream commit SHA for re-verification).
