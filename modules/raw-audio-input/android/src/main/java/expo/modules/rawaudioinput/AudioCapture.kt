package expo.modules.rawaudioinput

import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder

private const val TAG = "AudioCapture"

/**
 * Owns one AudioRecord instance and one capture thread.
 *
 * Lifecycle:
 *  - Constructed with desired parameters; does NOT open AudioRecord yet.
 *  - start(): tries source/rate fallback chain, opens AudioRecord, starts thread.
 *  - stop(): signals thread to exit, joins, releases AudioRecord.
 *
 * Fallback chains:
 *  - Source: preferredSource → VOICE_RECOGNITION → MIC
 *  - Sample rate: 48000 → 44100 → getNativeSampleRate()
 *
 * Buffer sizes:
 *  - AudioRecord internal buffer = getMinBufferSize × 2 (avoids overruns).
 *  - Emit cadence = bufferDurationMs worth of samples per callback.
 *
 * Thread safety: start/stop must be called from the same thread (the Expo
 * module coroutine dispatcher). The capture thread only writes to the
 * emitCallback; the running flag is @Volatile so the thread observes stop()
 * without a lock.
 */
internal class AudioCapture(
    private val desiredSampleRate: Int,
    private val bufferDurationMs: Int,
    private val preferredSource: Int,
    private val emitCallback: (floatData: ByteArray, actualSampleRate: Int) -> Unit,
    private val errorCallback: (reason: String) -> Unit,
    private val context: Context? = null, // v1.4 wave-11 — used for PROPERTY_OUTPUT_SAMPLE_RATE query
) {

    // Written by start(), read by stop() and the capture thread.
    @Volatile private var record: AudioRecord? = null
    @Volatile private var running = false
    private var captureThread: Thread? = null

    // Resolved during start(); surfaced to callers via activeSource / actualSampleRate.
    var activeSource: Int = preferredSource
        private set
    var actualSampleRate: Int = desiredSampleRate
        private set

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Opens AudioRecord (with fallback) and starts the capture thread.
     * Returns normally on success; throws on complete failure (all sources and
     * rates rejected by the hardware).
     */
    fun start() {
        if (running) return

        val (rec, chosenSource, chosenRate) = openAudioRecord()
            ?: throw IllegalStateException("AudioRecord could not be initialized for any source/rate combination")

        activeSource = chosenSource
        actualSampleRate = chosenRate
        record = rec

        val samplesPerEmit = (chosenRate * bufferDurationMs / 1000).coerceAtLeast(1)
        // float32 = 4 bytes per sample
        val emitBufferBytes = samplesPerEmit * 4

        running = true
        rec.startRecording()

        captureThread = Thread({
            captureLoop(rec, samplesPerEmit, emitBufferBytes, chosenRate)
        }, "RawAudioCapture").also { it.start() }
    }

    /**
     * Signals the capture thread to exit and blocks until it finishes.
     * Safe to call when not started (no-op).
     *
     * Ordering matters: rec.read(READ_BLOCKING) inside the capture loop can
     * block indefinitely on its own. Calling rec.stop() first unblocks the
     * read so the loop can observe running=false and exit. Only after the
     * thread is confirmed exited do we call rec.release(); releasing while
     * a read is in flight is undefined behaviour (SIGSEGV in the audio HAL).
     */
    fun stop() {
        val rec = record
        val thread = captureThread

        running = false

        // Unblock the pending read() so the thread loop can return.
        if (rec != null) {
            try { rec.stop() } catch (_: Exception) {}
        }

        // 2s is a generous safety bound; rec.stop() should let the loop
        // exit within milliseconds in the normal case.
        if (thread != null) {
            try { thread.join(2000) } catch (_: InterruptedException) {}
        }

        if (rec != null) {
            if (thread == null || !thread.isAlive) {
                try { rec.release() } catch (_: Exception) {}
            } else {
                // Thread did not exit within the join window. Releasing now
                // would race the in-flight read — far better to leak the
                // AudioRecord (OS reclaims it on process exit) than to crash.
                Log.w(TAG, "stop: capture thread still alive after join; leaking AudioRecord to avoid use-after-free")
            }
        }

        captureThread = null
        record = null
    }

    // -------------------------------------------------------------------------
    // AudioRecord construction with fallback
    // -------------------------------------------------------------------------

    private data class RecordResult(
        val record: AudioRecord,
        val source: Int,
        val sampleRate: Int,
    )

    private fun openAudioRecord(): RecordResult? {
        // Source fallback chain.
        val sources = buildList {
            add(preferredSource)
            if (preferredSource != MediaRecorder.AudioSource.VOICE_RECOGNITION) {
                add(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            }
            if (preferredSource != MediaRecorder.AudioSource.MIC) {
                add(MediaRecorder.AudioSource.MIC)
            }
        }.distinct()

        // v1.4 wave-11 N1 — exhaustive rate fallback chain.
        // Query PROPERTY_OUTPUT_SAMPLE_RATE first: it reflects the device's
        // hardware mixer rate and succeeds on BT SCO (16 000 Hz), USB audio,
        // and unusual OEM HALs where 44100/48000 both fail. We put it ahead of
        // the standard rates so AudioRecord opens at native cost (no SRC).
        // All candidates are logged so device-specific failures are diagnosable
        // in logcat without needing a repro device.
        val nativeRate: Int? = context?.let { ctx ->
            try {
                val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                am.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toIntOrNull()
            } catch (e: Exception) {
                Log.w(TAG, "PROPERTY_OUTPUT_SAMPLE_RATE query failed: ${e.message}")
                null
            }
        }
        Log.d(TAG, "rate fallback: desired=$desiredSampleRate nativeRate=$nativeRate")
        val rates = listOfNotNull(
            desiredSampleRate,
            nativeRate,
            44100,
            48000,
            22050,
            16000,  // BT SCO
            8000,   // edge-case HW
        ).distinct()

        for (source in sources) {
            for (rate in rates) {
                Log.d(TAG, "trying source=$source rate=$rate") // v1.4 wave-11 N1
                val minBytes = AudioRecord.getMinBufferSize(
                    rate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_FLOAT,
                )
                if (minBytes == AudioRecord.ERROR_BAD_VALUE || minBytes == AudioRecord.ERROR) {
                    Log.d(TAG, "getMinBufferSize rejected source=$source rate=$rate, skipping")
                    continue
                }
                // Double the minimum to reduce overrun risk at low buffer-duration settings.
                val bufSize = minBytes * 2

                val rec = try {
                    AudioRecord(
                        source,
                        rate,
                        AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_FLOAT,
                        bufSize,
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "AudioRecord constructor threw for source=$source rate=$rate: ${e.message}")
                    continue
                }

                if (rec.state == AudioRecord.STATE_INITIALIZED) {
                    Log.i(TAG, "AudioRecord opened: source=$source rate=$rate bufSize=$bufSize")
                    return RecordResult(rec, source, rate)
                } else {
                    Log.w(TAG, "AudioRecord not initialized: source=$source rate=$rate state=${rec.state}")
                    try { rec.release() } catch (_: Exception) {}
                }
            }
        }

        return null
    }

    // -------------------------------------------------------------------------
    // Capture thread loop
    // -------------------------------------------------------------------------

    private fun captureLoop(
        rec: AudioRecord,
        samplesPerEmit: Int,
        emitBufferBytes: Int,
        chosenRate: Int,
    ) {
        // Reuse a single float buffer for reads; copy to ByteArray for each emit.
        val floatBuf = FloatArray(samplesPerEmit)

        while (running) {
            val read = rec.read(floatBuf, 0, samplesPerEmit, AudioRecord.READ_BLOCKING)

            when {
                read > 0 -> {
                    // Convert float array to little-endian ByteArray for the JS bridge.
                    // We copy `read` samples (may be less than samplesPerEmit on the
                    // last partial read before stop()).
                    val bb = ByteBuffer.allocate(read * 4).order(ByteOrder.LITTLE_ENDIAN)
                    val fb = bb.asFloatBuffer()
                    fb.put(floatBuf, 0, read)
                    emitCallback(bb.array(), chosenRate)
                }

                read == AudioRecord.ERROR_INVALID_OPERATION -> {
                    // Recording was stopped externally or the object is in a bad state.
                    Log.w(TAG, "captureLoop: ERROR_INVALID_OPERATION — stopping")
                    running = false
                    errorCallback("ERROR_INVALID_OPERATION")
                }

                read == AudioRecord.ERROR_BAD_VALUE -> {
                    // Buffer size or format parameter rejected. Not recoverable.
                    Log.w(TAG, "captureLoop: ERROR_BAD_VALUE — stopping")
                    running = false
                    errorCallback("ERROR_BAD_VALUE")
                }

                read == AudioRecord.ERROR_DEAD_OBJECT -> {
                    // Hardware was lost (e.g. another app stole exclusive access).
                    // Not recoverable without a new AudioRecord.
                    Log.w(TAG, "captureLoop: ERROR_DEAD_OBJECT — stopping")
                    running = false
                    errorCallback("ERROR_DEAD_OBJECT")
                }

                read == 0 -> {
                    // READ_BLOCKING returned 0 — can happen if the record was just
                    // started. Yield and retry rather than spinning.
                    Thread.sleep(1)
                }

                else -> {
                    // Catch-all for undocumented negative return values.
                    Log.w(TAG, "captureLoop: unexpected read=$read — stopping")
                    running = false
                    errorCallback("UNKNOWN_READ_ERROR($read)")
                }
            }
        }
    }
}
