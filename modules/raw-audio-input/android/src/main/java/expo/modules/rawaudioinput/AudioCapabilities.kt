package expo.modules.rawaudioinput

import android.content.Context
import android.media.AudioManager
import android.os.Build

/**
 * Static helpers for querying device audio hardware capabilities.
 *
 * UNPROCESSED source detection: Android 7.0 (API 24) added
 * AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED. On older APIs
 * (not reachable given our minSdk 26, but guarded defensively) we return false.
 *
 * Native sample rate: PROPERTY_OUTPUT_SAMPLE_RATE reflects the hardware mixer
 * rate. Android does not expose a separate input-side native rate via a public
 * API — the output rate is the closest proxy. On Pixel devices the two are
 * identical (48 kHz). On rare devices they may differ; the negotiation in
 * AudioCapture will catch any real mismatch at AudioRecord construction time.
 */
internal object AudioCapabilities {

    /**
     * Returns true if the device advertises support for AudioSource.UNPROCESSED (= 9).
     * Requires API 24+; always returns false below that API level.
     */
    fun isUnprocessedSupported(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        return try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true"
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Returns the hardware output sample rate in Hz, or 48000 as a safe default
     * if the property is absent or unparseable.
     *
     * Android docs: "may be 0 if the property is not available."
     * We treat 0 and any non-positive / non-finite values as missing and fall
     * back to 48000 (the universal Pixel hardware rate).
     */
    fun getNativeSampleRate(context: Context): Int {
        return try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val raw = am.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)
            val parsed = raw?.toIntOrNull() ?: 0
            if (parsed > 0) parsed else 48000
        } catch (_: Exception) {
            48000
        }
    }
}
