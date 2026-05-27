package expo.modules.rawaudiooutput

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
 */
internal object SynthBridge {

    @Volatile var isLoaded: Boolean = false
        private set

    init {
        isLoaded = try {
            System.loadLibrary("rawaudiooutput")
            true
        } catch (t: Throwable) {
            android.util.Log.e("SynthBridge", "Failed to load native library: ${t.message}", t)
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
}
