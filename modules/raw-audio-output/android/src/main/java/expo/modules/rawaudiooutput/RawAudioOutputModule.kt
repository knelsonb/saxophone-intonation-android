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
 * Events:
 *   ready              — { ok: Boolean, error?: String }
 *   audioOutputError   — { reason: String }
 *   audioOutputUnderrun— { framesAccepted: Int }
 *
 * Lifecycle:
 *   SF2 load runs in a background coroutine on the IO dispatcher. ~50-150 ms
 *   on a 30 MB bank. Until `ready` fires (or `isReady()` returns true), the
 *   note/program/pitch calls all execute against an uninitialised synth and
 *   produce silence — they're safe, just inaudible.
 */
class RawAudioOutputModule : Module() {

    private val context: Context
        get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

    @Volatile private var renderer: SynthRenderer? = null
    @Volatile private var ready: Boolean = false

    // Single supervisor scope for the async prepare. Cancelled in OnDestroy.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var prepareJob: Job? = null

    override fun definition() = ModuleDefinition {

        Name("RawAudioOutput")

        Events("ready", "audioOutputError", "audioOutputUnderrun")

        OnDestroy {
            try { renderer?.stop() } catch (_: Exception) {}
            renderer = null
            try { SynthBridge.nativeShutdown() } catch (_: Exception) {}
            ready = false
            scope.cancel()
        }

        // -----------------------------------------------------------------
        // prepareAsync — copy SF2 → cache, init TSF. Fires `ready` event.
        // Idempotent: calling twice while a load is in flight is a no-op.
        // -----------------------------------------------------------------
        AsyncFunction("prepareAsync") { promise: Promise ->
            if (ready) {
                promise.resolve(true)
                return@AsyncFunction
            }
            if (prepareJob?.isActive == true) {
                // Another caller is already preparing; wait for it.
                scope.launch {
                    prepareJob?.join()
                    promise.resolve(ready)
                }
                return@AsyncFunction
            }

            prepareJob = scope.launch {
                val ok = try {
                    val sf2Path = copyAssetToCache(SF2_ASSET, SF2_CACHE_NAME)
                    if (!SynthBridge.isLoaded) {
                        sendEvent("ready", mapOf("ok" to false, "error" to "native library not loaded"))
                        return@launch
                    }
                    val rc = SynthBridge.nativeInit(sf2Path, SAMPLE_RATE, CHANNELS)
                    if (rc != 0) {
                        sendEvent("ready", mapOf("ok" to false, "error" to "tsf_init returned $rc"))
                        return@launch
                    }
                    true
                } catch (e: Exception) {
                    Log.w(TAG, "prepare failed: ${e.message}", e)
                    sendEvent("ready", mapOf("ok" to false, "error" to (e.message ?: "unknown")))
                    false
                }
                if (ok) {
                    ready = true
                    sendEvent("ready", mapOf("ok" to true))
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
            if (renderer?.isRunning == true) return@Function true

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
            return@Function r.isRunning
        }

        // -----------------------------------------------------------------
        // stop — tears down AudioTrack + render thread. TSF state is kept
        // (still loaded, still has any program changes set) so a subsequent
        // start() resumes cleanly.
        // -----------------------------------------------------------------
        Function("stop") {
            val r = renderer ?: return@Function true
            renderer = null
            try { r.stop() } catch (_: Exception) {}
            return@Function true
        }

        Function("noteOn") { channel: Int, midi: Int, velocity: Double ->
            SynthBridge.nativeNoteOn(channel, midi, velocity.toFloat())
        }

        Function("noteOff") { channel: Int, midi: Int ->
            SynthBridge.nativeNoteOff(channel, midi)
        }

        Function("programChange") { channel: Int, program: Int ->
            SynthBridge.nativeProgramChange(channel, program)
        }

        Function("pitchBend") { channel: Int, semitones: Double ->
            SynthBridge.nativePitchBend(channel, semitones.toFloat())
        }

        Function("allNotesOff") { channel: Int ->
            SynthBridge.nativeAllNotesOff(channel)
        }

        Function("setMasterGain") { gain: Double ->
            SynthBridge.nativeSetMasterGain(gain.toFloat())
        }

        Function("isReady") {
            ready && SynthBridge.isLoaded
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
