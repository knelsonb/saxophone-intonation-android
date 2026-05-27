package expo.modules.rawaudiooutput

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import timber.log.Timber

/**
 * Owns the AudioTrack and the dedicated render thread.
 *
 * Lifecycle:
 *  - Construct (does not allocate AudioTrack).
 *  - start(): builds AudioTrack, allocates the int16 mix buffer, spins the worker.
 *  - stop(): clears the run flag, joins the thread, pauses+flushes+releases AudioTrack.
 *
 * Render loop pattern:
 *   while (running) {
 *     SynthBridge.nativeRenderShort(buf, frames)   // mutex-guarded
 *     audioTrack.write(buf, 0, samples)            // may return short on underrun
 *   }
 *
 * Underrun handling: AudioTrack.write returns the number of samples actually
 * accepted. On a short write we surface it via `onUnderrun` (one event per
 * stretch — we don't spam if the same condition persists).
 *
 * Single-instance: only one SynthRenderer exists at a time, owned by the
 * Expo module. start() while already running is a no-op; stop() while
 * stopped is a no-op.
 */
internal class SynthRenderer(
    private val sampleRate: Int = 44100,
    private val channels: Int = 2,
    // 1024 frames @ 44.1 kHz ~= 23 ms per render quantum. Small enough to
    // keep noteOn latency low; large enough to avoid per-callback overhead.
    private val framesPerRender: Int = 1024,
    private val onUnderrun: (Int) -> Unit = {},
    private val onError: (String) -> Unit = {},
) {

    @Volatile private var running = false
    private var thread: Thread? = null
    private var audioTrack: AudioTrack? = null

    // Pre-allocated mix buffer; reused every render. Size = frames * channels.
    private val mixBuffer: ShortArray = ShortArray(framesPerRender * channels)

    val isRunning: Boolean get() = running

    fun start() {
        if (running) return
        Timber.tag(TAG).d("start() — sampleRate=%d channels=%d framesPerRender=%d", sampleRate, channels, framesPerRender)
        if (!SynthBridge.isLoaded) {
            Timber.tag(TAG).e("start(): native library not loaded — aborting")
            onError("native library not loaded")
            return
        }

        val channelMask = if (channels == 1) AudioFormat.CHANNEL_OUT_MONO
                          else AudioFormat.CHANNEL_OUT_STEREO

        val minBuf = AudioTrack.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuf == AudioTrack.ERROR_BAD_VALUE || minBuf == AudioTrack.ERROR) {
            Timber.tag(TAG).e("start(): getMinBufferSize returned %d", minBuf)
            onError("AudioTrack.getMinBufferSize returned $minBuf")
            return
        }
        // Double the minimum to give the worker some slack against scheduler jitter.
        val bufSizeBytes = minBuf * 2
        Timber.tag(TAG).d("start(): minBuf=%d bufSizeBytes=%d", minBuf, bufSizeBytes)

        val track = try {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelMask)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build()
                )
                .setBufferSizeInBytes(bufSizeBytes)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } catch (e: Exception) {
            Timber.tag(TAG).e(e, "start(): AudioTrack.Builder threw: %s", e.message)
            onError("AudioTrack.Builder threw: ${e.message}")
            return
        }

        if (track.state != AudioTrack.STATE_INITIALIZED) {
            Timber.tag(TAG).e("start(): AudioTrack failed to initialize (state=%d)", track.state)
            onError("AudioTrack failed to initialize (state=${track.state})")
            try { track.release() } catch (_: Exception) {}
            return
        }
        Timber.tag(TAG).i("start(): AudioTrack created OK — bufSizeBytes=%d state=%d", bufSizeBytes, track.state)

        audioTrack = track
        running = true
        try { track.play() } catch (e: Exception) {
            Timber.tag(TAG).e(e, "start(): AudioTrack.play threw: %s", e.message)
            onError("AudioTrack.play threw: ${e.message}")
            running = false
            try { track.release() } catch (_: Exception) {}
            audioTrack = null
            return
        }

        thread = Thread({ renderLoop(track) }, "SynthRenderer").also {
            // STREAM_MUSIC priority enough for media. Bump slightly above default
            // so we ride out other JS-driven work without underruns.
            it.priority = Thread.NORM_PRIORITY + 1
            it.start()
        }
        Timber.tag(TAG).i("start(): render thread started")
    }

    fun stop() {
        if (!running && thread == null) return
        Timber.tag(TAG).d("stop() — signalling render thread to exit")

        running = false

        // pause() makes any in-flight write() return promptly so the worker
        // can observe running=false. We avoid stop() here because it blocks
        // until the buffer drains, which would defeat the point.
        val track = audioTrack
        try { track?.pause() } catch (_: Exception) {}
        try { track?.flush() } catch (_: Exception) {}

        val t = thread
        if (t != null) {
            try { t.join(1500) } catch (_: InterruptedException) {}
            if (t.isAlive) {
                Log.w(TAG, "render thread did not exit within join window; leaking AudioTrack")
                Timber.tag(TAG).w("stop(): render thread did not exit within 1500 ms join window — leaking AudioTrack")
            } else {
                try { track?.stop() } catch (_: Exception) {}
                try { track?.release() } catch (_: Exception) {}
                audioTrack = null
                Timber.tag(TAG).i("stop(): render thread exited cleanly, AudioTrack released")
            }
        } else {
            try { track?.stop() } catch (_: Exception) {}
            try { track?.release() } catch (_: Exception) {}
            audioTrack = null
            Timber.tag(TAG).d("stop(): no render thread, AudioTrack released directly")
        }
        thread = null
    }

    private fun renderLoop(track: AudioTrack) {
        val samplesPerWrite = framesPerRender * channels
        var underrunStreak = 0

        while (running) {
            // Mutex-guarded inside the JNI layer; safe to call concurrently
            // with noteOn/noteOff/etc from the JNI thread.
            SynthBridge.nativeRenderShort(mixBuffer, framesPerRender)

            val written = try {
                track.write(mixBuffer, 0, samplesPerWrite)
            } catch (e: Exception) {
                Log.w(TAG, "AudioTrack.write threw: ${e.message}")
                running = false
                onError("audiotrack_write_threw: ${e.message}")
                break
            }

            when {
                written == samplesPerWrite -> {
                    if (underrunStreak > 0) underrunStreak = 0
                }

                written >= 0 -> {
                    // Short write — buffer not fully accepted. Counts as underrun.
                    underrunStreak += 1
                    if (underrunStreak == 1) {
                        Timber.tag(TAG).w("renderLoop: underrun — accepted %d of %d samples", written, samplesPerWrite)
                        onUnderrun(written)
                    }
                }

                written == AudioTrack.ERROR_INVALID_OPERATION -> {
                    Log.w(TAG, "AudioTrack.write ERROR_INVALID_OPERATION — stopping")
                    running = false
                    onError("ERROR_INVALID_OPERATION")
                }

                written == AudioTrack.ERROR_BAD_VALUE -> {
                    Log.w(TAG, "AudioTrack.write ERROR_BAD_VALUE — stopping")
                    running = false
                    onError("ERROR_BAD_VALUE")
                }

                written == AudioTrack.ERROR_DEAD_OBJECT -> {
                    Log.w(TAG, "AudioTrack.write ERROR_DEAD_OBJECT — stopping")
                    running = false
                    onError("ERROR_DEAD_OBJECT")
                }

                else -> {
                    Log.w(TAG, "AudioTrack.write returned $written — stopping")
                    running = false
                    onError("UNKNOWN_WRITE_ERROR($written)")
                }
            }
        }
    }

    companion object {
        private const val TAG = "SynthRenderer"
    }
}
