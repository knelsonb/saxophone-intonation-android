package expo.modules.rawaudioinput

import android.content.Context
import android.media.MediaRecorder
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo Module bridge for low-latency raw audio capture.
 *
 * Exposes:
 *   getCapabilitiesAsync()       — device UNPROCESSED support + native sample rate
 *   startCaptureAsync(options)   — opens AudioRecord (with fallback), starts thread
 *   stopCaptureAsync()           — stops thread + releases AudioRecord
 *   getActiveSourceAsync()       — returns the string label of the current source
 *
 * Events:
 *   audioStreamBuffer  — { data: ByteArray, sampleRate: Int }
 *   captureStateChange — { isStreaming: Boolean, activeSource: String }
 *
 * Only one capture session is allowed at a time. A second startCaptureAsync
 * call while one is active stops the previous session first.
 */
class RawAudioInputModule : Module() {

    private val context: Context
        get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

    @Volatile
    private var capture: AudioCapture? = null

    override fun definition() = ModuleDefinition {

        Name("RawAudioInput")

        Events("audioStreamBuffer", "captureStateChange", "audioStreamError")

        // -----------------------------------------------------------------
        // OnDestroy — ensure the capture thread is stopped when the module
        // is torn down (app background, hot reload, etc.)
        // -----------------------------------------------------------------
        OnDestroy {
            stopCapture()
        }

        // -----------------------------------------------------------------
        // getCapabilitiesAsync
        // -----------------------------------------------------------------
        AsyncFunction("getCapabilitiesAsync") {
            mapOf(
                "supportsUnprocessed" to AudioCapabilities.isUnprocessedSupported(context),
                "nativeSampleRate"    to AudioCapabilities.getNativeSampleRate(context),
            )
        }

        // -----------------------------------------------------------------
        // startCaptureAsync
        // -----------------------------------------------------------------
        AsyncFunction("startCaptureAsync") { options: Map<String, Any>, promise: Promise ->
            // If a previous session is running, stop it first so resources are freed.
            val previous = capture
            if (previous != null) {
                stopCapture()
            }

            val requestedRate   = (options["sampleRate"]        as? Number)?.toInt() ?: 48000
            val bufDurationMs   = (options["bufferDurationMs"]  as? Number)?.toInt() ?: 25
            val preferredLabel  = (options["preferredSource"]   as? String) ?: "unprocessed"

            val preferredSource = labelToAudioSource(preferredLabel)

            val cap = AudioCapture(
                desiredSampleRate  = requestedRate,
                bufferDurationMs   = bufDurationMs,
                preferredSource    = preferredSource,
                emitCallback       = { data, rate ->
                    // Called from the capture thread. sendEvent is thread-safe.
                    sendEvent(
                        "audioStreamBuffer",
                        mapOf(
                            "data"       to data,
                            "sampleRate" to rate,
                        )
                    )
                },
                errorCallback      = { reason ->
                    capture = null
                    // Fire both: captureStateChange so isStreaming flips false,
                    // and audioStreamError so the engine can transition to a
                    // dedicated stream-failed state with the reason string.
                    sendEvent(
                        "audioStreamError",
                        mapOf("reason" to reason),
                    )
                    sendEvent(
                        "captureStateChange",
                        mapOf(
                            "isStreaming"  to false,
                            "activeSource" to "mic",
                            "errorReason"  to reason,
                        )
                    )
                },
            )

            try {
                cap.start()
                capture = cap
                sendEvent(
                    "captureStateChange",
                    mapOf(
                        "isStreaming"  to true,
                        "activeSource" to audioSourceToLabel(cap.activeSource),
                    )
                )
                promise.resolve(
                    mapOf(
                        "actualSampleRate" to cap.actualSampleRate,
                        "activeSource"     to audioSourceToLabel(cap.activeSource),
                    )
                )
            } catch (e: Exception) {
                capture = null
                promise.reject("E_CAPTURE_FAILED", e.message ?: "AudioRecord could not be initialized", e)
            }
        }

        // -----------------------------------------------------------------
        // stopCaptureAsync
        // -----------------------------------------------------------------
        AsyncFunction("stopCaptureAsync") {
            stopCapture()
        }

        // -----------------------------------------------------------------
        // getActiveSourceAsync
        // -----------------------------------------------------------------
        AsyncFunction("getActiveSourceAsync") {
            val cap = capture ?: return@AsyncFunction "none"
            audioSourceToLabel(cap.activeSource)
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private fun stopCapture() {
        val cap = capture ?: return
        capture = null
        try { cap.stop() } catch (_: Exception) {}
        sendEvent(
            "captureStateChange",
            mapOf(
                "isStreaming"  to false,
                "activeSource" to audioSourceToLabel(cap.activeSource),
            )
        )
    }

    /** Maps the JS string label to the Android AudioSource integer constant. */
    private fun labelToAudioSource(label: String): Int = when (label) {
        "unprocessed"      -> 9 // MediaRecorder.AudioSource.UNPROCESSED — added in API 24.
        "voice_recognition"-> MediaRecorder.AudioSource.VOICE_RECOGNITION
        else               -> MediaRecorder.AudioSource.MIC
    }

    /** Maps an AudioSource integer back to the label surfaced in JS. */
    private fun audioSourceToLabel(source: Int): String = when (source) {
        9                                         -> "unprocessed"
        MediaRecorder.AudioSource.VOICE_RECOGNITION -> "voice_recognition"
        else                                      -> "mic"
    }
}
