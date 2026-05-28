package expo.modules.rawaudiooutput

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
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

    // v1.4 wave-11 N2 — AudioFocus: request on start(), abandon on stop()/OnDestroy.
    // Listener emits audioFocusLost / audioFocusGained events to JS so the
    // metronome and recording can be paused during phone calls or other transient
    // interruptions. JS-side handler (metro.stop / deck.stopRecord) deferred to v1.5.
    private val audioManager: AudioManager by lazy {
        context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    }
    @Volatile private var audioFocusRequest: AudioFocusRequest? = null

    // Low-latency output config, queried ONCE from the device. Rendering at the
    // device's native sample rate is the prerequisite for the FAST mixer path:
    // a mismatched rate (we used to hard-code 44100 on a 48000-native Pixel)
    // forces a HAL resampler and disqualifies the FAST/MMAP track, which is what
    // produced the measured ~245 ms write->hear latency. PROPERTY_OUTPUT_* have
    // been available since API 17; minSdk here is 26. Fallback (48000, 256)
    // because every modern Android output mixes at 48 kHz. The SAME values feed
    // synth_init, the AudioTrack, AND the JS frame-clock peg (via getSampleRate)
    // so the write-frame math can never skew between native and JS.
    private val outputSampleRate: Int by lazy {
        val q = try { audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toIntOrNull() } catch (_: Exception) { null }
        val rate = if (q != null && q > 0) q else 48000
        Timber.tag(TAG).i("outputSampleRate=%d (device reported %s)", rate, q?.toString() ?: "null")
        rate
    }
    private val outputFramesPerBurst: Int by lazy {
        val q = try { audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)?.toIntOrNull() } catch (_: Exception) { null }
        val fpb = if (q != null && q in 32..4096) q else 256
        Timber.tag(TAG).i("outputFramesPerBurst=%d (device reported %s)", fpb, q?.toString() ?: "null")
        fpb
    }

    private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        Timber.tag(TAG).i("audioFocusChange: focusChange=%d", focusChange)
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                // v1.4 wave-11 N2 — notify JS; JS-side pause logic deferred to v1.5.
                try {
                    sendEvent("audioFocusLost", mapOf("type" to focusChange))
                } catch (t: Throwable) {
                    Log.w(TAG, "audioFocusLost emit failed: ${t.message}")
                }
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                try {
                    sendEvent("audioFocusGained", emptyMap<String, Any>())
                } catch (t: Throwable) {
                    Log.w(TAG, "audioFocusGained emit failed: ${t.message}")
                }
            }
        }
    }

    // v1.4.x P3 — audio route recovery. A headphone/Bluetooth/USB plug or
    // unplug can briefly pause or kill the AudioTrack, which freezes the render
    // frame counter. The bus's frame-clock peg then goes stale and the drift
    // gate refuses to re-peg, so scheduled noteOnAt commands land out-of-window
    // and the metronome goes silent + still. We surface route changes to JS via
    // `audioRouteChanged`; the bus force-repegs to the live clock on receipt.
    // (Outright track death — ERROR_DEAD_OBJECT — is surfaced via the existing
    // audioOutputError event; JS rebuilds the track through the normal
    // stop()/start() path.)
    @Volatile private var deviceCallbackRegistered = false
    @Volatile private var deviceCallbackPrimed = false

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
            // The first onAudioDevicesAdded fires synchronously on registration
            // with the already-connected devices — that's not a route CHANGE,
            // so skip it to avoid a spurious re-peg right after start().
            if (!deviceCallbackPrimed) { deviceCallbackPrimed = true; return }
            emitRouteChanged("added")
        }
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
            emitRouteChanged("removed")
        }
    }

    private fun emitRouteChanged(kind: String) {
        // Only signal while actively rendering — a route change between sessions
        // doesn't matter (start() force-repegs anyway).
        if (renderer?.isRunning != true) return
        Timber.tag(TAG).i("audioRouteChanged (%s) — signalling JS to re-peg frame clock", kind)
        try {
            sendEvent("audioRouteChanged", mapOf("kind" to kind))
        } catch (t: Throwable) {
            Log.w(TAG, "audioRouteChanged emit failed: ${t.message}")
        }
    }

    private fun registerDeviceCallback() {
        if (deviceCallbackRegistered) return
        deviceCallbackPrimed = false
        try {
            audioManager.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
            deviceCallbackRegistered = true
            Timber.tag(TAG).d("registerAudioDeviceCallback: registered")
        } catch (e: Exception) {
            Log.w(TAG, "registerAudioDeviceCallback failed: ${e.message}")
        }
    }

    private fun unregisterDeviceCallback() {
        if (!deviceCallbackRegistered) return
        deviceCallbackRegistered = false
        try {
            audioManager.unregisterAudioDeviceCallback(deviceCallback)
            Timber.tag(TAG).d("unregisterAudioDeviceCallback: unregistered")
        } catch (e: Exception) {
            Log.w(TAG, "unregisterAudioDeviceCallback failed: ${e.message}")
        }
    }

    /** Request AUDIOFOCUS_GAIN. Returns true if granted. */
    private fun requestAudioFocus(): Boolean {
        // v1.4 wave-12 — abandon any prior request before creating a new one
        // to prevent overlapping focus requests on rapid start/stop/start cycles.
        audioFocusRequest?.let { prev ->
            audioFocusRequest = null  // v1.4 closeout — clear before abandon so a throw can't strand the ref
            audioManager.abandonAudioFocusRequest(prev)
        }
        // v1.4 wave-11 N2
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setOnAudioFocusChangeListener(audioFocusListener)
            .build()
        audioFocusRequest = req
        val result = audioManager.requestAudioFocus(req)
        Timber.tag(TAG).i("requestAudioFocus: result=%d (1=GRANTED)", result)
        return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    /** Abandon audio focus; safe to call when focus was never held. */
    private fun abandonAudioFocus() {
        // v1.4 wave-11 N2
        val req = audioFocusRequest ?: return
        audioFocusRequest = null
        try {
            audioManager.abandonAudioFocusRequest(req)
            Timber.tag(TAG).i("abandonAudioFocus: done")
        } catch (e: Exception) {
            Log.w(TAG, "abandonAudioFocus failed: ${e.message}")
        }
    }

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

    // -------------------------------------------------------------------------
    // #64 Phase-1 — sub-ms sync SHADOW PROBE (measurement only; drives no view).
    //
    // A Choreographer.FrameCallback on the MAIN thread captures the platform
    // vsync time (frameTimeNanos = CLOCK_MONOTONIC, same epoch as the audio
    // AudioTimestamp.nanoTime — Sauron-blessed). It does ONE clock-identity log
    // on the first frame and accumulates vsync cadence (to confirm 120 Hz held
    // across the floor window). It NEVER emits and NEVER drives a view.
    //
    // The achievability-floor residual is computed per-downbeat in setBeatAnchor
    // from SynthRenderer's cached AudioAnchor — see the §1.3 contract.
    //
    // Lifecycle (Frodo + Legolas): DEFAULT-OFF (armed only by startShadowProbe),
    // IDEMPOTENT start (the shadowActive guard never stacks a second self-
    // reposting chain), PAIRED stop (removeFrameCallback the SAME instance) wired
    // to metro-stop + stop() + OnDestroy. Per-vsync steady path is allocation-
    // free: primitive volatile-long cadence counters only — no Log/Map/boxing.
    // -------------------------------------------------------------------------
    @Volatile private var shadowActive = false
    @Volatile private var shadowResetPending = false
    @Volatile private var gate1Logged = false
    // #64 default ~1.5 frame @120Hz; cancels out of the shadow residual (so it is
    // measurement-irrelevant here) — stored for the gate-1 log + Phase-2 actuation,
    // photodiode-rig-refined before the rewrite.
    @Volatile private var displayPipelineNanos = 12_500_000.0

    // vsync cadence — SINGLE writer (doFrame on main), read by setBeatAnchor.
    // Volatile longs: 64-bit reads/writes are atomic; single-writer so ++ is safe.
    @Volatile private var vsyncLastNanos = 0L
    @Volatile private var vsyncFrameCount = 0L
    @Volatile private var vsyncSlowCount = 0L

    // Trim/anchor state — touched ONLY inside setBeatAnchor (a single call site,
    // so it is thread-consistent no matter which thread Expo runs Functions on).
    // The reset is deferred here via shadowResetPending so startShadowProbe never
    // writes these directly (it may run on a different thread).
    private var shadowAnchored = false
    private var shadowRawAnchorNanos = 0L  // FIXED first-beat heard time (raw drift ramps off this)
    private var shadowTrimAnchorNanos = 0L // §2.1 slow-skew-trimmed anchor
    private var shadowLastHeardNanos = 0L  // previous beat's heard time (for the cumulative-K step)
    private var shadowCumK = 0L            // cumulative beats since the raw anchor (wrap-robust rawSkew)
    private var shadowPrevGen = 0L
    private var shadowPrevVsyncFrames = 0L
    private var shadowPrevVsyncSlow = 0L

    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var choreographer: Choreographer? = null

    private val shadowFrameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            // stopShadowProbe sets shadowActive=false → the chain ends here (no re-post).
            if (!shadowActive) return
            // GATE-1 one-shot clock-identity. Sample frameTimeNanos (the ARG = the
            // past vsync instant), a fresh System.nanoTime() (NOW), and uptimeMillis
            // ALL inside this same doFrame so we measure dispatch latency, not a
            // thread-hop. PASS rule (Sauron/Legolas): (fresh − frameTimeNanos)
            // bounded-POSITIVE in 0..tens-of-ms ⟹ same epoch. Gross |Δ| or large-
            // negative ⟹ wrong gross epoch ⟹ fail→NDK. A 1 ms staircase on the
            // frame/audio legs fingerprints the disqualified worklet clock.
            if (!gate1Logged) {
                gate1Logged = true
                val freshNano = System.nanoTime()
                val uptimeNano = SystemClock.uptimeMillis() * 1_000_000L
                val a = renderer?.audioAnchor()
                Log.i(TAG, "#64 gate1 clock-identity: frameTimeNanos=$frameTimeNanos freshNano=$freshNano " +
                    "dNano_minus_frame=${freshNano - frameTimeNanos} [PASS=bounded-POSITIVE 0..tens-of-ms; gross/negative=wrong-epoch] " +
                    "uptimeNano=$uptimeNano dNano_minus_uptime=${freshNano - uptimeNano} [expect ~0; staircase tell=worklet clock] " +
                    "audioNano=${a?.nanoTime ?: -1L} audioSR=${a?.sampleRate ?: -1} pipelineNs=$displayPipelineNanos")
            }
            // vsync cadence — allocation-free primitive accumulation.
            val last = vsyncLastNanos
            if (last > 0L) {
                vsyncFrameCount++
                if (frameTimeNanos - last > SLOW_VSYNC_NS) vsyncSlowCount++ // > ~10ms ⟹ ARR demoted below ~100Hz
            }
            vsyncLastNanos = frameTimeNanos
            // Self-repost to keep the chain alive while active.
            choreographer?.postFrameCallback(this)
        }
    }

    /** Idempotent. Arms the shadow probe; resets cadence + gate1 on the main thread. */
    private fun startShadowProbeInternal() {
        if (shadowActive) return // idempotent — never stack a second self-reposting chain
        shadowActive = true
        shadowResetPending = true // setBeatAnchor re-anchors on its next call
        mainHandler.post {
            // Reset cadence state on the MAIN thread (same thread as doFrame) so
            // all cadence access is single-threaded, then arm the chain. Remove
            // first as a belt against any orphaned callback (no double-post).
            gate1Logged = false
            vsyncLastNanos = 0L
            vsyncFrameCount = 0L
            vsyncSlowCount = 0L
            val c = Choreographer.getInstance()
            choreographer = c
            c.removeFrameCallback(shadowFrameCallback)
            c.postFrameCallback(shadowFrameCallback)
            Timber.tag(TAG).i("#64 shadow probe ARMED")
        }
    }

    /** Idempotent. Stops the probe and removes the SAME callback instance (paired teardown). */
    private fun stopShadowProbeInternal() {
        if (!shadowActive) return
        shadowActive = false // doFrame's guard ends the chain on its next fire
        mainHandler.post {
            choreographer?.removeFrameCallback(shadowFrameCallback)
            Timber.tag(TAG).i("#64 shadow probe STOPPED")
        }
    }

    /** #64 — emit one BEAT_OFFSET record to JS (≤4Hz downbeat path; Map alloc OK here). */
    private fun emitShadowBeat(heardNanos: Long, rawSkewNs: Long, residualNs: Long,
                               periodNanos: Double, atFrame: Long, gen: Long,
                               vsyncFrames: Long, vsyncSlow: Long, reset: Boolean) {
        try {
            sendEvent("shadowBeat", mapOf(
                "beatHeardNanos" to heardNanos.toDouble(), // ground truth — gate detrends from this
                "rawSkewNs" to rawSkewNs.toDouble(),       // untrimmed drift (slope=drift, noise=floor)
                "residualNs" to residualNs.toDouble(),     // §2.1 per-downbeat trimmed residual
                "periodNanos" to periodNanos,
                "atFrame" to atFrame.toDouble(),
                "gen" to gen.toDouble(),
                "vsyncFrames" to vsyncFrames.toDouble(),   // vsyncs since last beat
                "vsyncSlow" to vsyncSlow.toDouble(),        // of those, intervals >10ms (ARR demote tell)
                "reset" to reset,                           // true = re-anchor beat; exclude from steady floor
            ))
        } catch (t: Throwable) {
            Log.w(TAG, "shadowBeat emit failed: ${t.message}")
        }
    }

    /**
     * #64 Phase-1 — per-downbeat shadow measurement (single call site, so its
     * trim/anchor fields stay thread-consistent). Projects the beat's HEARD time
     * from the cached audio anchor in play-clock frame space, computes the
     * wrap-robust untrimmed rawSkew + the §2.1 per-downbeat trimmed residual, and
     * emits a `shadowBeat`. Re-anchors + resets the trim on any frame-space
     * discontinuity (gen change / first beat) so a flush/underrun step is never
     * dragged across the slow trim. HOLDs (emits nothing) when the clock is
     * unavailable or stale — gate-4, silence-over-wrong.
     */
    private fun handleSetBeatAnchor(beatFrame: Double, periodNanos: Double) {
        if (!shadowActive) return
        val bf = beatFrame.toLong()
        val anchor = renderer?.audioAnchor() ?: return // gate-4: no clock yet → hold
        val nowNanos = System.nanoTime()
        if (nowNanos - anchor.nanoTime > STALE_ANCHOR_NS) return // stale clock → hold
        val sr = anchor.sampleRate
        if (sr <= 0) return
        // heard = nanoTime + (atFrame − gFrame + latFrames)/SR, in LONG ns (no
        // catastrophic cancellation). frameDelta is small (near-future beat +
        // buffer depth) so frameDelta*1e9 stays well within Long range.
        val frameDelta = bf - anchor.gFrame + anchor.latFrames
        val heard = anchor.nanoTime + (frameDelta * 1_000_000_000L) / sr.toLong()

        // Re-anchor on the first beat OR any frame-space discontinuity (gen change
        // = flush/underrun/short-write/route). Reset the trim — never drag a step.
        if (shadowResetPending || !shadowAnchored || anchor.gen != shadowPrevGen) {
            shadowResetPending = false
            shadowAnchored = true
            shadowRawAnchorNanos = heard
            shadowTrimAnchorNanos = heard
            shadowLastHeardNanos = heard
            shadowCumK = 0L
            shadowPrevGen = anchor.gen
            shadowPrevVsyncFrames = vsyncFrameCount
            shadowPrevVsyncSlow = vsyncSlowCount
            emitShadowBeat(heard, 0L, 0L, periodNanos, bf, anchor.gen, 0L, 0L, true)
            return
        }
        if (periodNanos <= 0.0) return
        val period = periodNanos.toLong()

        // rawSkew — UNTRIMMED, via cumulative beat index. Wrap-robust: the raw
        // anchor is FIXED, so the ~1.3 ms/s DAC-vs-MONOTONIC drift would wrap an
        // absolute round(m) at ±period/2. stepK = beats since the previous beat
        // (≈1) accumulates smoothly. SLOPE of rawSkew = drift; detrended NOISE =
        // the fundamental floor (control-law-independent).
        val stepK = Math.round((heard - shadowLastHeardNanos).toDouble() / periodNanos)
        shadowCumK += stepK
        shadowLastHeardNanos = heard
        val rawSkew = heard - (shadowRawAnchorNanos + shadowCumK * period)

        // residual — §2.1 per-downbeat slow-skew trim AS WRITTEN.
        //
        // CONTROL LAW (declared, per Sauron 3572/3579): PROPORTIONAL. The trim
        // NUDGES the phase anchor by clamp(GAIN·err, ±CAP) ns each downbeat — it
        // does NOT accumulate a persistent rate/period correction (no integral
        // term). So SKEW_CAP_NS bounds the per-step PHASE-NUDGE (ns), not a rate
        // increment; the reset above re-acquires phase (not anti-windup). Stepped
        // at the PER-DOWNBEAT cadence (§2.1's actuation cadence as written).
        // Expected gate signature (Legolas): residualNs floor flat ≈σ/(GAIN·f) at
        // high BPM, RAMPS below ~156 BPM (cap 0.5ms/beat < drift ~1.3ms/s). That
        // ramp is the as-designed limitation the gate REVEALS → it drives the
        // Phase-2 law call (per-vsync proportional vs integral slope-feedforward);
        // it is NOT pre-fixed here. The law-free achievability floor is the
        // detrended rawSkew, not this.
        //
        // residual = OBSERVED − PREDICTED:
        //   observed  = `heard` (projected from AudioTimestamp.framePosition)
        //   predicted = trimmed anchor + round(m)·period
        // NEVER simplify to (prediction − the-anchor-that-generated-it): that is
        // self-vs-self → 0-by-construction → the gate lies GREEN (Sauron 3566).
        val mT = Math.round((heard - shadowTrimAnchorNanos).toDouble() / periodNanos)
        val residual = heard - (shadowTrimAnchorNanos + mT * period)
        // proportional phase-nudge clamped to ±CAP — the ONLY feedback term.
        var corr = (residual.toDouble() * SKEW_GAIN).toLong()
        if (corr > SKEW_CAP_NS) corr = SKEW_CAP_NS
        if (corr < -SKEW_CAP_NS) corr = -SKEW_CAP_NS
        shadowTrimAnchorNanos += corr

        val vFrames = vsyncFrameCount - shadowPrevVsyncFrames
        val vSlow = vsyncSlowCount - shadowPrevVsyncSlow
        shadowPrevVsyncFrames = vsyncFrameCount
        shadowPrevVsyncSlow = vsyncSlowCount
        emitShadowBeat(heard, rawSkew, residual, periodNanos, bf, anchor.gen, vFrames, vSlow, false)
    }

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

        Events("ready", "audioOutputError", "audioOutputUnderrun", "commandFired",
               "audioFocusLost", "audioFocusGained", // v1.4 wave-11 N2
               "audioRouteChanged", // v1.4.x P3 — route recovery
               "shadowBeat") // #64 Phase-1 — per-downbeat sub-ms-sync shadow record

        OnDestroy {
            // #64 — paired teardown: stop the shadow probe before anything else so
            // the self-reposting Choreographer callback can't outlive the module.
            try { stopShadowProbeInternal() } catch (_: Exception) {}
            // Wave-2: renderer.stop() before nativeShutdown — do not reorder.
            try { renderer?.stop() } catch (_: Exception) {}
            renderer = null
            unregisterDeviceCallback() // v1.4.x P3 — stop listening for route changes
            abandonAudioFocus() // v1.4 wave-11 N2 — release focus before tearing down
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
                    Timber.tag(TAG).d("prepareAsync: calling nativeInit sampleRate=%d channels=%d", outputSampleRate, CHANNELS)
                    val tInit = System.currentTimeMillis()
                    val rc = SynthBridge.nativeInit(sf2Path, outputSampleRate, CHANNELS)
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
                sampleRate = outputSampleRate,
                channels = CHANNELS,
                framesPerRender = outputFramesPerBurst,
                onUnderrun = { accepted ->
                    sendEvent("audioOutputUnderrun", mapOf("framesAccepted" to accepted))
                },
                onError = { reason ->
                    sendEvent("audioOutputError", mapOf("reason" to reason))
                },
            )
            // v1.4 wave-11 N2 — claim audio focus before AudioTrack starts.
            // Log the result but don't block playback: focus is best-effort.
            val granted = requestAudioFocus()
            Timber.tag(TAG).i("start() audioFocus granted=%b", granted)
            r.start()
            renderer = r
            registerDeviceCallback() // v1.4.x P3 — watch for route changes while playing
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
            // v1.4 wave-10 N1 — null AFTER r.stop() returns so a concurrent
            // start() that sees renderer!=null waits for stop to fully complete
            // before the field is cleared. Previously the null assignment
            // preceded r.stop(), which left a window where start() could see
            // null and create a second renderer while the old one was still
            // tearing down.
            try { r.stop() } catch (_: Exception) {}
            renderer = null
            // #64 — the AudioTrack is gone, so the shadow probe's heard projection
            // has no valid clock; stop it (defense-in-depth — useMetronome also
            // stops it on metro-stop / background).
            try { stopShadowProbeInternal() } catch (_: Exception) {}
            unregisterDeviceCallback() // v1.4.x P3 — stop watching route changes when idle
            abandonAudioFocus() // v1.4 wave-11 N2 — release focus when AudioTrack stops
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

        // The actual output sample rate the synth + AudioTrack run at (device
        // native, queried once). JS reads this to peg the frame clock at the
        // SAME rate the render thread advances g_frame_position — a mismatch
        // here skews every scheduled atFrame (44100 vs 48000 = 8.8% error).
        Function("getSampleRate") {
            outputSampleRate
        }

        // Latest MEASURED write->hear latency in ms (from AudioTrack.getTimestamp,
        // ~1 Hz, warm-gated). -1 until a valid reading exists. The JS bus uses
        // this to auto-compensate visual/audio sync per device + route; it holds
        // the value with a deadband/debounce so this raw figure's jitter never
        // reaches the animation.
        Function("getOutputLatencyMs") {
            renderer?.outputLatencyMs() ?: -1.0
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

        // v1.4.x P1 — logcat passthrough. RN release builds don't pipe JS
        // console.* to logcat (that routing is __DEV__-gated), so the in-app
        // forensic logger (src/log.ts) is invisible to `adb logcat` on release
        // APKs. This Function lets the JS logger mirror entries into Android's
        // native log so on-device timing/diagnostics are observable in the field
        // without a debug build. Gentle by design — callers send whole formatted
        // lines (per-event, not per-frame).
        Function("nativeLog") { level: String, tag: String, msg: String ->
            when (level) {
                "error" -> Log.e(tag, msg)
                "warn"  -> Log.w(tag, msg)
                "info"  -> Log.i(tag, msg)
                else    -> Log.d(tag, msg)
            }
        }

        // v1.4.x P4 — pin the display to its highest refresh rate while the app
        // is foregrounded. The Pixel's LTPO panel otherwise down-switches
        // (120→80→60) mid-animation to save power, changing the frame cadence
        // and making the metronome's continuous sweep micro-judder. Requesting
        // the top mode on the Activity window holds the rate steady. Pass false
        // (on background) to release back to the system's adaptive default.
        // Colocated here as a host-window utility to avoid a second native
        // module; semantically separate from the synth.
        Function("setHighRefreshRate") { enable: Boolean ->
            val activity = appContext.activityProvider?.currentActivity ?: return@Function
            activity.runOnUiThread {
                try {
                    val window = activity.window ?: return@runOnUiThread
                    val lp = window.attributes
                    if (enable) {
                        @Suppress("DEPRECATION")
                        val display = window.windowManager?.defaultDisplay
                        val current = display?.mode
                        // Highest refresh rate AT THE CURRENT RESOLUTION (don't
                        // switch resolution — only the rate).
                        val best = display?.supportedModes
                            ?.filter {
                                current == null ||
                                    (it.physicalWidth == current.physicalWidth &&
                                     it.physicalHeight == current.physicalHeight)
                            }
                            ?.maxByOrNull { it.refreshRate }
                        if (best != null) {
                            lp.preferredDisplayModeId = best.modeId
                            lp.preferredRefreshRate = best.refreshRate
                        }
                    } else {
                        lp.preferredDisplayModeId = 0
                        lp.preferredRefreshRate = 0f
                    }
                    window.attributes = lp
                    Timber.tag(TAG).i(
                        "setHighRefreshRate(%b): modeId=%d rate=%.1f",
                        enable, lp.preferredDisplayModeId, lp.preferredRefreshRate,
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "setHighRefreshRate failed: ${e.message}")
                }
            }
        }

        // -----------------------------------------------------------------
        // #64 Phase-1 — sub-ms sync instrumentation surface (measurement
        // only; the #167 path is untouched). See the module-level shadow
        // probe doc + the #64 changeset §1.1.
        // -----------------------------------------------------------------

        // CLOCK_MONOTONIC nanoseconds (System.nanoTime) for the JS clock-identity
        // co-log. JS double holds ns to <2ns granularity until ~104 days uptime.
        Function("getMonotonicNanos") {
            System.nanoTime().toDouble()
        }

        // Snapshot of SynthRenderer's cached audio-clock anchor (the existing
        // ~1Hz getTimestamp read — NO new HAL call). nanoTime is the SINGLE-ARG
        // getTimestamp overload = TIMEBASE_MONOTONIC. {valid:false} until warm.
        Function("getAudioTimestamp") {
            val a = renderer?.audioAnchor()
            if (a == null) {
                mapOf("valid" to false)
            } else {
                mapOf(
                    "valid" to true,
                    "nanoTime" to a.nanoTime.toDouble(),
                    "framePosition" to a.framePos.toDouble(),
                    "gFrame" to a.gFrame.toDouble(),
                    "latFrames" to a.latFrames.toDouble(),
                    "rate" to a.sampleRate,
                    "gen" to a.gen.toDouble(),
                )
            }
        }

        // The frameTimeNanos→photon compositor+scanout constant. CANCELS out of
        // the shadow residual (so it is measurement-irrelevant in Phase 1) —
        // stored for the gate-1 log + Phase-2 actuation, rig-refined before the
        // rewrite. Replaces the pendulum's PEG_BRIDGE_MS in Phase 2.
        Function("setDisplayPipelineNanos") { ns: Double ->
            displayPipelineNanos = ns
        }

        // Arm / disarm the shadow probe. Both idempotent; paired teardown. The
        // probe is DEFAULT-OFF — only a startShadowProbe call posts the
        // Choreographer callback, so a normal practice session pays zero cost.
        Function("startShadowProbe") {
            startShadowProbeInternal()
        }
        Function("stopShadowProbe") {
            stopShadowProbeInternal()
        }

        // Per-downbeat anchor + shadow measurement. beatFrame = the #167 atFrame
        // (g_frame_position space); periodNanos = 60e9/bpm. No-op unless the probe
        // is armed. Emits one `shadowBeat` per downbeat (the achievability-floor
        // record). Does NOT touch the #167 pendulum PLL.
        Function("setBeatAnchor") { beatFrame: Double, periodNanos: Double ->
            handleSetBeatAnchor(beatFrame, periodNanos)
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
        // #64 Phase-1 — shadow trim + gating constants. SKEW_GAIN/CAP mirror the
        // Phase-2 §2.1 control law EXACTLY so Phase 1 shadow-proves that math.
        private const val SKEW_GAIN = 0.1
        private const val SKEW_CAP_NS = 500_000L      // 0.5 ms/beat correction ceiling
        private const val STALE_ANCHOR_NS = 2_000_000_000L // anchor older than 2s ⟹ hold (gate-4)
        private const val SLOW_VSYNC_NS = 10_000_000L  // inter-vsync >10ms ⟹ ARR demoted below ~100Hz
        // Sample rate is no longer fixed — it's queried from the device
        // (outputSampleRate) so we render at the native rate and hit the FAST
        // mixer. TSF resamples the SF2 to whatever output rate it's given, so
        // the bank's own rate is irrelevant. Stereo.
        private const val CHANNELS = 2
    }
}
