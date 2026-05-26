package expo.modules.automicclaim

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager

/**
 * Registers and caches the self-managed PhoneAccount for the tuner call.
 *
 * A PhoneAccount must be registered before TelecomManager.addNewIncomingCall is
 * called. We register lazily on the first startTunerCallAsync invocation and
 * reuse the same handle for the session lifetime. On module destroy we
 * unregister to avoid stale entries accumulating in TelecomManager across
 * Expo Go hot-reloads.
 *
 * CAPABILITY_SELF_MANAGED (0x800): the app manages its own in-call UI.
 * No video capability flag is set — we never want the car to offer a video
 * call route.
 */
class PhoneAccountRegistrar(private val context: Context) {

  companion object {
    private const val HANDLE_ID = "intonation-analyzer-tuner"
  }

  val phoneAccountHandle: PhoneAccountHandle by lazy {
    PhoneAccountHandle(
      ComponentName(context, TunerConnectionService::class.java),
      HANDLE_ID
    )
  }

  private var registered = false

  fun ensureRegistered() {
    if (registered) return
    val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager

    val account = PhoneAccount.builder(phoneAccountHandle, "Intonation Analyzer Tuner")
      .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
      // A dummy URI is required; Telecom does not dial it for self-managed calls.
      .setAddress(Uri.fromParts("tel", "0000000000", null))
      .build()

    telecomManager.registerPhoneAccount(account)
    registered = true
  }

  fun unregister() {
    if (!registered) return
    try {
      val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
      telecomManager.unregisterPhoneAccount(phoneAccountHandle)
    } catch (_: Exception) {
      // Best-effort cleanup; not worth crashing on teardown.
    }
    registered = false
  }
}
