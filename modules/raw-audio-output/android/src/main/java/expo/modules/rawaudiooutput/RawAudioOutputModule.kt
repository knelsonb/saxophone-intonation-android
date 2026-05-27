package expo.modules.rawaudiooutput

import android.content.Context
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import timber.log.Timber
import java.io.File
import java.io.FileOutputStream

/**
 * Expo Module bridge for the BellCurve TinySoundFont synthesiser.
 *
 * Exposes (all are Expo "Function" entries — synchronous from the JS side
 * with the exception of `prepareAsync` which awaits the SF2 load):
 *
 *   prepareAsync()                  — copies the SF2 from assets, calls
 *                                     synth_init. Fires `ready` when done.
 *                                     Idempotent.
 *   start()                         — boots AudioTrack + render thread.
 *   stop()                          — tears them down.
 *   noteOn(channel, midi, velocity) — 0-15, 0-127, 0.0-1.0
 *   noteOff(channel, midi)
 *   programChange(channel, program) — GM patch 0-127 (bank 0)
 *   pitchBend(channel, semitones)   — -12.0 .. +12.0
 *   allNotesOff(channel)
 *   setMasterGain(gain)             — 0.0 .. 2.0 (>1 boosts above unity)
 *   isReady()                       — true when SF2 loaded and worker can be started
 *
 * v1.4 additions:
 *   noteOnAt(channel, midi, velocity, atFrame, tickKind)
 *                                   — scheduled noteOn. atFrame in render
 *                                     frames; tickKind 0/1/2 (none/beat/sub).
 *   getCurrentFrame() → Long       — monotonic render-frame counter (atomic).
 *   commandFired event             — fired from the audio render thread
 *                                     (relayed via the Default dispatcher) on
 *                                     EVERY command apply. Payload:
 *                                       { kind, tickKind, channel, midi,
 *                                         velocity, atFrame }
 *                                     kind: 1=NoteOn, 2=NoteOff,
 *                                           3=ProgramChange, 4=PitchBend,
 *                                           5=AllNotesOff, 6=SetMasterGain.
 *
 * Events:
 *   ready              — { ok: Boolean, error?: String }
 *   audioOutputError   — { reason: String }
 *   audioOutputUnderrun— { framesAccepted: Int }
 *   commandFired       — { kind, tickKind, channel, midi, velocity, atFrame }
 *
 * Lifecycle:
 *   SF2 load runs in a background coroutine on the IO dispatcher. ~50-150 ms
 *   on a 30 MB bank. Until `ready` fires (or `isReady()` returns true), the
 *   note/program/pitch calls all execute against an uninitialised synth and
 *   produce silence — they're safe, just inaudible.
 *
 *   The fire listener is registered ONCE on first prepareAsync success, and
 *   torn down in OnDestroy (or repeated prepareAsync calls — idempotent).
 */
class RawAudioOutputModule : Module() {

    private val context: Context
        get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

    @Volatile private var renderer: SynthRenderer? = null
    @Volatile private var ready: Boolean = false

    // Single supervisor scope for the async prepare. Cancelled in OnDestroy.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var prepareJob: Job? = null

    // v1.4 — fire callback listener. Created lazily on first prepareAsync
    // success, kept alive until OnDestroy (or a fresh prepareAsync that
    // re-installs). It relays from the audio render thread to a coroutine
    // dispatcher so sendEvent (which may touch JS bridge state) doesn't
    // happen on the render thread.
    private val fireScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    @Volatile private var firedListener: CommandFiredListener? = null

    init {
        // Plant a DebugTree once per process. Guard with treeCount so hot-
        // reloads and multiple module instantiations don't stack duplicate trees.
        if (Timber.treeCount == 0) {
            Timber.plant(Timber.DebugTree())
        }
        Timber.tag(TAG).d("RawAudioOutputModule instantiated")
    }

    /**
     * Listener invoked directly from the JNI trampoline on the audio render
     * thread. We post the payload to fireScope.launch and return ASAP —
     * never block the renderer.
     */
    internal inner class CommandFiredListener {
        @Suppress("unused") // called via JNI reflection
        fun onCommandFired(kind: Int, tickKind: Int, channel: Int, midi: Int,
                           velocity: Float, atFrame: Long) {
            // Capture into immutable locals so the launched block doesn't race
            // with subsequent calls reusing this listener instance.
            val k = kind; val tk = tickKind; val ch = channel
            val m = midi; val v = velocity; val af = atFrame
            fireScope.launch {
                try {
                    sendEvent("commandFired", mapOf(
                        "kind" to k,
                        "tickKind" to tk,
                        "channel" to ch,
                        "midi" to m,
                        "velocity" to v.toDouble(),
                        "atFrame" to af,
                    ))
                } catch (t: Throwable) {
                    Log.w(TAG, "commandFired emit failed: ${t.message}")
                }
            }
        }
    }

    override fun definition() = ModuleDefinition {

        Name("RawAudioOutput")

        Events("ready", "audioOutputError", "audioOutputUnderrun", "commandFired")

        OnDestroy {
            // Wave-2: renderer.stop() before nativeShutdown — do not reorder.
            try { renderer?.stop() } catch (_: Exception) {}
            renderer = null
            // v1.4: tear down fired callback before nativeShutdown.
            try { SynthBridge.nativeRegisterFiredCallback(null) } catch (_: Exception) {}
            firedListener = null
            try { SynthBridge.nativeShutdown() } catch (_: Exception) {}
            ready = false
            scope.cancel()
            try { fireScope.cancel() } catch (_: Exception) {}
        }

        // -----------------------------------------------------------------
        // prepareAsync — copy SF2 → cache, init TSF. Fires `ready` event.
        // Idempotent: calling twice while a load is in flight is a no-op.
        // -----------------------------------------------------------------
        AsyncFunction("prepareAsync") { promise: Promise ->
            Timber.tag(TAG).d("prepareAsync entry — ready=%b, prepareJob.isActive=%b", ready, prepareJob?.isActive == true)
            if (ready) {
                Timber.tag(TAG).i("prepareAsync: already ready, resolving true immediately")
                promise.resolve(true)
                return@AsyncFunction
            }
            if (prepareJob?.isActive == true) {
                // Another caller is already preparing; wait for it.
                Timber.tag(TAG).d("prepareAsync: prepare already in-flight, joining existing job")
                scope.launch {
                    prepareJob?.join()
                    Timber.tag(TAG).i("prepareAsync: joined existing job, ready=%b", ready)
                    promise.resolve(ready)
                }
                return@AsyncFunction
            }

            prepareJob = scope.launch {
                val t0 = System.currentTimeMillis()
                val ok = try {
                    Timber.tag(TAG).d("prepareAsync: copying SF2 from assets — %s", SF2_ASSET)
                    val sf2Path = copyAssetToCache(SF2_ASSET, SF2_CACHE_NAME)
                    val copyMs = System.currentTimeMillis() - t0
                    Timber.tag(TAG).i("prepareAsync: SF2 ready at %s (copy/cache %d ms)", sf2Path, copyMs)
                    if (!SynthBridge.isLoaded) {
                        Timber.tag(TAG).e("prepareAsync: native library not loaded — aborting")
                        sendEvent("ready", mapOf("ok" to false, "error" to "native library not loaded"))
                        return@launch
                    }
                    Timber.tag(TAG).d("prepareAsync: calling nativeInit sampleRate=%d channels=%d", SAMPLE_RATE, CHANNELS)
                    val tInit = System.currentTimeMillis()
                    val rc = SynthBridge.nativeInit(sf2Path, SAMPLE_RATE, CHANNELS)
                    val initMs = System.currentTimeMillis() - tInit
                    Timber.tag(TAG).i("prepareAsync: nativeInit returned %d in %d ms", rc, initMs)
                    if (rc != 0) {
                        Timber.tag(TAG).e("prepareAsync: tsf_init returned %d — firing ready(ok=false)", rc)
                        sendEvent("ready", mapOf("ok" to false, "error" to "tsf_init returned $rc"))
                        return@launch
                    }
                    true
                } catch (e: Exception) {
                    Log.w(TAG, "prepare failed: ${e.message}", e)
                    Timber.tag(TAG).e(e, "prepareAsync: exception — %s", e.message)
                    sendEvent("ready", mapOf("ok" to false, "error" to (e.message ?: "unknown")))
                    false
                }
                if (ok) {
                    ready = true
                    val totalMs = System.currentTimeMillis() - t0
                    Timber.tag(TAG).i("prepareAsync: complete ok=true total %d ms — firing ready event", totalMs)
                    // v1.4 — install the fire listener once we know the synth
                    // is alive. Re-registration overwrites the prior listener
                    // (the JNI bridge swaps + DeleteGlobalRef internally).
                    try {
                        val listener = firedListener ?: CommandFiredListener().also { firedListener = it }
                        SynthBridge.nativeRegisterFiredCallback(listener)
                    } catch (t: Throwable) {
                        Log.w(TAG, "fire-callback register failed: ${t.message}")
                    }
                    sendEvent("ready", mapOf("ok" to true))
                } else {
                    Timber.tag(TAG).w("prepareAsync: complete ok=false")
                }
                promise.resolve(ok)
            }
        }

        // -----------------------------------------------------------------
        // start — boots AudioTrack + render thread. Returns immediately.
        // Calling start() before prepareAsync() succeeds produces silence
        // until the synth is initialised; the worker is still safe to run.
        // -----------------------------------------------------------------
        Function("start") {
            Timber.tag(TAG).d("start() entry — renderer.isRunning=%b, ready=%b", renderer?.isRunning == true, ready)
            if (renderer?.isRunning == true) {
                Timber.tag(TAG).d("start(): already running, no-op")
                return@Function true
            }

            val r = SynthRenderer(
                sampleRate = SAMPLE_RATE,
                channels = CHANNELS,
                onUnderrun = { accepted ->
                    sendEvent("audioOutputUnderrun", mapOf("framesAccepted" to accepted))
                },
                onError = { reason ->
                    sendEvent("audioOutputError", mapOf("reason" to reason))
                },
            )
            r.start()
            renderer = r
            val running = r.isRunning
            Timber.tag(TAG).i("start() exit — isRunning=%b", running)
            return@Function running
        }

        // -----------------------------------------------------------------
        // stop — tears down AudioTrack + render thread. TSF state is kept
        // (still loaded, still has any program changes set) so a subsequent
        // start() resumes cleanly.
        // -----------------------------------------------------------------
        Function("stop") {
            Timber.tag(TAG).d("stop() entry — renderer=%s", if (renderer == null) "null" else "present")
            val r = renderer ?: run {
                Timber.tag(TAG).d("stop(): no renderer, no-op")
                return@Function true
            }
            renderer = null
            try { r.stop() } catch (_: Exception) {}
            Timber.tag(TAG).i("stop() exit — renderer released")
            return@Function true
        }

        Function("noteOn") { channel: Int, midi: Int, velocity: Double ->
            Timber.tag(TAG).d("noteOn ch=%d midi=%d vel=%.2f", channel, midi, velocity)
            SynthBridge.nativeNoteOn(channel, midi, velocity.toFloat())
        }

        Function("noteOff") { channel: Int, midi: Int ->
            Timber.tag(TAG).d("noteOff ch=%d midi=%d", channel, midi)
            SynthBridge.nativeNoteOff(channel, midi)
        }

        Function("programChange") { channel: Int, program: Int ->
            Timber.tag(TAG).i("programChange ch=%d program=%d", channel, program)
            SynthBridge.nativeProgramChange(channel, program)
        }

        Function("pitchBend") { channel: Int, semitones: Double ->
            Timber.tag(TAG).d("pitchBend ch=%d semitones=%.3f", channel, semitones)
            SynthBridge.nativePitchBend(channel, semitones.toFloat())
        }

        Function("allNotesOff") { channel: Int ->
            Timber.tag(TAG).i("allNotesOff ch=%d", channel)
            SynthBridge.nativeAllNotesOff(channel)
        }

        Function("setMasterGain") { gain: Double ->
            Timber.tag(TAG).i("setMasterGain gain=%.3f", gain)
            SynthBridge.nativeSetMasterGain(gain.toFloat())
        }

        Function("isReady") {
            ready && SynthBridge.isLoaded
        }

        // v1.4 — scheduled noteOn. atFrame is the absolute render-frame index
        // returned by getCurrentFrame() pegged to wall-clock on the JS side.
        // tickKind: 0=none, 1=beat, 2=sub.
        Function("noteOnAt") { channel: Int, midi: Int, velocity: Double, atFrame: Long, tickKind: Int ->
            SynthBridge.nativeNoteOnAt(channel, midi, velocity.toFloat(), atFrame, tickKind)
        }

        // v1.4 — sync getter for the frame clock. Atomic acquire-load
        // on the C side; this Function path stays on the JS thread.
        Function("getCurrentFrame") {
            // Kotlin Long → JS number. JS Number safely represents integers up
            // to 2^53 — at 44.1 kHz that's ~6500 years of continuous render.
            // // v1.4-followup: switch to BigInt if anyone runs the synth for
            // millennia.
            SynthBridge.getCurrentFrame()
        }

        // v1.4 — drop pending SCHEDULED commands (atFrame >= 0) while
        // preserving fire-ASAP (atFrame < 0) legacy noteOns. Belt-1 of the
        // stop discipline: useMetronome.stop() calls bus.clearScheduled()
        // BEFORE ch.allNotesOff() so future-scheduled noteOns can't tail-fire
        // after user-requested silence. Renamed from clearQueue in v1.4.
        Function("clearScheduled") { // v1.4
            Timber.tag(TAG).d("clearScheduled() — dropping scheduled commands, preserving fire-ASAP")
            SynthBridge.clearScheduled()
        }
    }

    // -------------------------------------------------------------------------
    // Asset → cache copy. TSF requires a filesystem path; assets are zipped
    // inside the APK and not directly addressable. We copy once and reuse.
    // -------------------------------------------------------------------------
    private fun copyAssetToCache(assetName: String, cacheName: String): String {
        val outFile = File(context.cacheDir, cacheName)
        if (outFile.exists() && outFile.length() > 0L) {
            // Best-effort: trust the cached copy. A future version-bump field
            // could invalidate, but for now the SF2 is immutable per release.
            return outFile.absolutePath
        }
        context.assets.open(assetName).use { input ->
            FileOutputStream(outFile).use { output ->
                input.copyTo(output, bufferSize = 64 * 1024)
            }
        }
        return outFile.absolutePath
    }

    companion object {
        private const val TAG = "RawAudioOutputModule"
        private const val SF2_ASSET = "GeneralUser-GS.sf2"
        private const val SF2_CACHE_NAME = "GeneralUser-GS.sf2"
        // AudioTrack + TSF stereo @ 44.1 kHz. Matches STREAM_MUSIC default
        // and the SF2's native sample rate.
        private const val SAMPLE_RATE = 44100
        private const val CHANNELS = 2
    }
}
