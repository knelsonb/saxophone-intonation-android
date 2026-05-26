package expo.modules.automicclaim

import android.telecom.Connection
import android.telecom.DisconnectCause

/**
 * A self-managed Telecom Connection that represents our fake "tuner call."
 *
 * Lifecycle:
 *   constructed → onAnswer() called immediately by TunerConnectionService
 *                 → setActive() → callState = active
 *   car end-call button / endTunerCallAsync → onDisconnect() → destroyed
 *
 * Thread safety: Telecom callbacks arrive on a binder thread. We guard shared
 * state with @Synchronized. The eventCallback lambda is set before the
 * connection is handed to Telecom and never replaced afterward.
 */
class TunerConnection(
  private val eventCallback: EventCallback
) : Connection() {

  interface EventCallback {
    fun onCallActive()
    fun onCallEnded(fromCarButton: Boolean)
  }

  init {
    // PROPERTY_SELF_MANAGED tells Telecom this call is managed entirely by us;
    // the system will not show its own in-call UI for it.
    connectionProperties = PROPERTY_SELF_MANAGED
    // VOIP mode ensures the audio routing matches a phone call (HFP on BT).
    audioModeIsVoip = true
  }

  // Called by TunerConnectionService immediately after construction so the call
  // becomes ACTIVE without waiting for a remote answer.
  override fun onAnswer() {
    setActive()
    eventCallback.onCallActive()
  }

  // Car's physical end-call button routes here via Telecom.
  override fun onDisconnect() {
    teardown(fromCarButton = true)
  }

  override fun onAbort() {
    teardown(fromCarButton = false)
  }

  override fun onReject() {
    teardown(fromCarButton = false)
  }

  // Called by AutoMicClaimModule.endTunerCallAsync (app-initiated hang-up).
  fun disconnect() {
    teardown(fromCarButton = false)
  }

  @Synchronized
  private fun teardown(fromCarButton: Boolean) {
    if (state == STATE_DISCONNECTED) return
    setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
    destroy()
    eventCallback.onCallEnded(fromCarButton)
  }
}
