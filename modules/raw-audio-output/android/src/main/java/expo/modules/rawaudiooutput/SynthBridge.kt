package expo.modules.rawaudiooutput

import timber.log.Timber

/**
 * Thin Kotlin wrapper over the TinySoundFont native library.
 *
 * All methods route into JNI; the C side enforces thread-safety with an
 * internal mutex so callers from the worker thread and the JNI thread can
 * interleave without explicit Kotlin-side synchronisation.
 *
 * Loaded once per process via System.loadLibrary in the companion object's
 * init block. If the load fails (e.g. unsupported ABI), `isLoaded` is false
 * and every native call becomes a no-op.
 *
 * v1.4 additions:
 *  - nativeNoteOnAt: scheduled noteOn (atFrame in render-frame units)
 *  - nativeGetCurrentFrame: atomic read of the monotonic frame counter
 *  - nativeRegisterFiredCallback: install an object exposing
 *    `onCommandFired(kind, tickKind, channel, midi, velocity, atFrame)`.
 *    The native trampoline calls this method on the AUDIO RENDER THREAD —
 *    listeners must post to a dispatcher and return immediately.
 */
internal object SynthBridge {

    @Volatile var isLoaded: Boolean = false
        private set

    init {
        Timber.tag("BellCurve.RawAudioOutput.SynthBridge").d("System.loadLibrary(\"rawaudiooutput\") starting")
        val t0 = System.currentTimeMillis()
        isLoaded = try {
            System.loadLibrary("rawaudiooutput")
            val ms = System.currentTimeMillis() - t0
            Timber.tag("BellCurve.RawAudioOutput.SynthBridge").i("native library loaded in %d ms", ms)
            true
        } catch (t: Throwable) {
            android.util.Log.e("SynthBridge", "Failed to load native library: ${t.message}", t)
            Timber.tag("BellCurve.RawAudioOutput.SynthBridge").e(t, "Failed to load native library")
            false
        }
    }

    // -------------------------------------------------------------------------
    // Native methods (implemented in jni_bridge.cpp)
    // -------------------------------------------------------------------------

    /** Returns 0 on success, non-zero on failure. */
    external fun nativeInit(sf2Path: String, sampleRate: Int, channels: Int): Int
    external fun nativeShutdown()
    external fun nativeSetMasterGain(gain: Float)
    external fun nativeNoteOn(channel: Int, midi: Int, velocity: Float)
    external fun nativeNoteOff(channel: Int, midi: Int)
    external fun nativeProgramChange(channel: Int, program: Int)
    external fun nativePitchBend(channel: Int, semitones: Float)
    external fun nativeAllNotesOff(channel: Int)
    /** Renders `frames` frames into outBuf (length must be frames * channels). */
    external fun nativeRenderShort(outBuf: ShortArray, frames: Int): Int

    // v1.4
    /**
     * Scheduled noteOn. atFrame is an absolute index in the synth's monotonic
     * frame clock. tickKind: 0=none, 1=beat, 2=sub.
     */
    external fun nativeNoteOnAt(channel: Int, midi: Int, velocity: Float, atFrame: Long, tickKind: Int)
    /** Atomic read of the render-frame counter. */
    external fun nativeGetCurrentFrame(): Long
    /**
     * Drop only SCHEDULED commands (atFrame >= 0). Fire-ASAP commands
     * (atFrame < 0) are preserved. Called from stop paths to prevent
     * tail-firing after user-requested silence. Renamed from nativeClearQueue
     * in v1.4 to make the partition contract explicit.
     */
    external fun nativeClearScheduled() // v1.4
    /**
     * Register a listener object. Pass null to clear. The object MUST expose:
     *   fun onCommandFired(kind: Int, tickKind: Int, channel: Int, midi: Int,
     *                       velocity: Float, atFrame: Long)
     * which is invoked on the AUDIO RENDER THREAD via JNI AttachCurrentThread.
     */
    external fun nativeRegisterFiredCallback(listener: Any?)

    // -------------------------------------------------------------------------
    // Kotlin-side convenience wrappers
    // -------------------------------------------------------------------------

    fun noteOnAt(channel: Int, midi: Int, velocity: Float, atFrame: Long, tickKind: Int) {
        if (!isLoaded) return
        nativeNoteOnAt(channel, midi, velocity, atFrame, tickKind)
    }

    fun getCurrentFrame(): Long {
        if (!isLoaded) return 0L
        return nativeGetCurrentFrame()
    }

    // v1.4 — clear scheduled wrapper. Drops only atFrame >= 0 commands;
    // preserves fire-ASAP (atFrame < 0) legacy noteOns. Safe to call before
    // nativeInit (C side partitions an empty vector under the lock).
    fun clearScheduled() { // v1.4
        if (!isLoaded) return
        nativeClearScheduled()
    }
}
