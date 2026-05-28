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

    // Latest measured write->hear latency (ms), updated ~1x/sec from
    // getTimestamp once the stream is warm. -1 until a valid reading exists.
    // JS reads this (getOutputLatencyMs) to drive auto visual/audio sync
    // compensation; it is the MEASUREMENT, not the held compensation value.
    @Volatile private var lastLatencyMs: Double = -1.0
    fun outputLatencyMs(): Double = lastLatencyMs

    val isRunning: Boolean get() = running

    fun start() {
        if (running) return
        // v1.4 wave-10 N2 — if a prior stop() timed out it left audioTrack
        // non-null (leak-to-avoid-double-init). Refuse to re-init; the leaked
        // worker still owns the track. Consistent with refuse-to-close semantics.
        if (audioTrack != null) {
            Timber.tag(TAG).e("start(): audioTrack != null after stop timeout — refusing double-init (leaked worker still active)")
            return
        }
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

        // The FAST track (AUDIO_OUTPUT_FLAG_FAST) is granted at BUILD time from
        // the REQUESTED buffer size. A large request (we used minBuf*2 ~ 5772
        // frames) silently drops the FAST flag and routes through the normal
        // mixer's deep buffer (a ~60 ms pipe) + HAL — which is why we measured
        // ~85 ms even with PERFORMANCE_MODE_LOW_LATENCY set and a shrunk
        // effective buffer. A few HAL bursts is small enough to keep FAST.
        // Requesting below getMinBufferSize is legal for a fast track; if a
        // device rejects it (state != INITIALIZED) we fall back to the safe
        // regular buffer rather than ship NO audio (silence-over-wrong is about
        // glitches, not refusing to play).
        val frameBytes = channels * 2 // PCM16
        val lowLatBytes = framesPerRender * frameBytes * LOW_LATENCY_BURSTS
        val fallbackBytes = minBuf * 2
        Timber.tag(TAG).d("start(): minBuf=%d lowLatBytes=%d fallbackBytes=%d", minBuf, lowLatBytes, fallbackBytes)

        fun buildTrack(bufBytes: Int): AudioTrack? = try {
            val t = AudioTrack.Builder()
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
                .setBufferSizeInBytes(bufBytes)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
                .build()
            if (t.state == AudioTrack.STATE_INITIALIZED) t
            else { Timber.tag(TAG).w("buildTrack(%d): state=%d, not INITIALIZED", bufBytes, t.state); try { t.release() } catch (_: Exception) {}; null }
        } catch (e: Exception) {
            Timber.tag(TAG).w("buildTrack(%d) threw: %s", bufBytes, e.message); null
        }

        var usedBytes = lowLatBytes
        var track = buildTrack(lowLatBytes)
        if (track == null) {
            Timber.tag(TAG).w("start(): low-latency track (%d B) failed — falling back to regular %d B", lowLatBytes, fallbackBytes)
            usedBytes = fallbackBytes
            track = buildTrack(fallbackBytes)
        }
        if (track == null) {
            onError("AudioTrack failed to initialize (low-latency and fallback both failed)")
            return
        }
        // Non-null binding for the render-thread closure below (Kotlin can't
        // smart-cast a captured var to non-null).
        val liveTrack: AudioTrack = track
        Log.i(TAG, "lowlat config: rate=$sampleRate burst=$framesPerRender reqBytes=$usedBytes capacityFrames=${liveTrack.bufferCapacityInFrames} effFrames=${liveTrack.bufferSizeInFrames} perfMode=${liveTrack.performanceMode}")
        audioTrack = liveTrack
        running = true
        try { liveTrack.play() } catch (e: Exception) {
            Timber.tag(TAG).e(e, "start(): AudioTrack.play threw: %s", e.message)
            onError("AudioTrack.play threw: ${e.message}")
            running = false
            try { liveTrack.release() } catch (_: Exception) {}
            audioTrack = null
            return
        }

        thread = Thread({ renderLoop(liveTrack) }, "SynthRenderer").also {
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
                // v1.4 wave-10 N2 — join timed out: worker still holds the
                // AudioTrack. Do NOT null audioTrack or release it — the live
                // thread is still writing to it and would crash on a null/
                // released object. Do NOT null thread — a subsequent start()
                // will see thread!=null (via audioTrack!=null guard) and refuse
                // to double-init. Log + leak; mirrors synth.cpp refuse-to-close
                // semantics.
                Log.e(TAG, "render thread did not exit within 1500 ms — leaking AudioTrack to avoid double-init")
                Timber.tag(TAG).e("stop(): render thread did not exit within 1500 ms join window — leaking AudioTrack")
                // audioTrack intentionally NOT nulled; thread intentionally NOT nulled.
            } else {
                try { track?.stop() } catch (_: Exception) {}
                try { track?.release() } catch (_: Exception) {}
                audioTrack = null
                thread = null
                Timber.tag(TAG).i("stop(): render thread exited cleanly, AudioTrack released")
            }
        } else {
            try { track?.stop() } catch (_: Exception) {}
            try { track?.release() } catch (_: Exception) {}
            audioTrack = null
            thread = null
            Timber.tag(TAG).d("stop(): no render thread, AudioTrack released directly")
        }
    }

    private fun renderLoop(track: AudioTrack) {
        // Real-time priority for the render thread. At a small low-latency
        // buffer (a few ms) the default NORM_PRIORITY+1 is not enough — one
        // ordinary scheduler timeslice eviction would underrun. THREAD_PRIORITY_AUDIO
        // (Linux nice -16) must be set FROM this thread. (silence-over-wrong:
        // an underrun is an audible glitch, so this is mandatory once the
        // buffer shrinks.)
        try {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO)
        } catch (e: Exception) {
            Log.w(TAG, "setThreadPriority(THREAD_PRIORITY_AUDIO) failed: ${e.message}")
        }

        val samplesPerWrite = framesPerRender * channels
        var underrunStreak = 0

        // Output-latency probe (LOAD-BEARING). framesWritten counts frames
        // accepted by AudioTrack; getTimestamp().framePosition is frames the DAC
        // has actually PRESENTED — the difference is the in-flight (write->heard)
        // latency. The warm-gated `lastLatencyMs` write below is read by the JS
        // bus (getOutputLatencyMs) to drive #167 auto sync-compensation; sampled
        // at ~1 Hz, the rate the bus watchdog needs.
        // NEVER log inside this loop: it runs on the THREAD_PRIORITY_AUDIO render
        // thread, where a string alloc / binder write can priority-invert into an
        // underrun (audible dropout). The committed value is logged off-thread by
        // the bus (`latency-comp set`).
        val ats = android.media.AudioTimestamp()
        var framesWritten = 0L
        var lastLatLogNs = 0L

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

            // Accumulate frames the DAC has accepted (drives the probe below).
            if (written > 0) framesWritten += written / channels
            val nowNs = System.nanoTime()
            if (nowNs - lastLatLogNs > 1_000_000_000L) { // ~1 Hz — as often as the watchdog needs, no more
                lastLatLogNs = nowNs
                if (track.getTimestamp(ats)) {
                    val latFrames = framesWritten - ats.framePosition
                    val latMs = latFrames * 1000.0 / sampleRate
                    // Only publish once the stream is warm (>=1 s written) and the
                    // reading is sane — during warm-up framesWritten races ahead of
                    // the DAC and inflates the figure.
                    if (framesWritten > sampleRate && latFrames in 1..sampleRate.toLong()) {
                        lastLatencyMs = latMs
                    }
                }
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
        // Requested AudioTrack buffer = this many render bursts. Must be small
        // enough to keep the FAST flag (a large request drops to the regular
        // mixer's ~60 ms pipe). 2 bursts trades a little underrun headroom for
        // the fast path; OUTLAT + the underrun counter tell us if we need 3-4.
        private const val LOW_LATENCY_BURSTS = 2
    }
}
