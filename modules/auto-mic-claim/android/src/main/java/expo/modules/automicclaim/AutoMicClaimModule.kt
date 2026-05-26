package expo.modules.automicclaim

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.telecom.TelecomManager
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo Module bridge for the Android Auto mic-claim masquerade feature.
 *
 * Responsibilities:
 *  - Expose JS API surface (getCarConnectionStateAsync, startTunerCallAsync, etc.)
 *  - Manage CarConnectionWatcher lifecycle (registers on OnCreate, cleans up on OnDestroy)
 *  - Inject TunerConnectionService.connectionFactory before placing a call
 *  - Forward TunerConnection events (callState, endCallButton) to JS via sendEvent
 *
 * Call flow (startTunerCallAsync):
 *  1. Verify MANAGE_OWN_CALLS permission
 *  2. PhoneAccountRegistrar.ensureRegistered()
 *  3. Inject connectionFactory into TunerConnectionService companion
 *  4. TelecomManager.addNewIncomingCall → Telecom binds TunerConnectionService
 *  5. onCreateIncomingConnection → TunerConnection constructed + onAnswer() → setActive()
 *  6. eventCallback.onCallActive() → sendEvent("callState", "active")
 */
class AutoMicClaimModule : Module() {

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private lateinit var phoneAccountRegistrar: PhoneAccountRegistrar
  private lateinit var carConnectionWatcher: CarConnectionWatcher

  // Guarded by the module's own lock; only one fake call at a time.
  @Volatile
  private var activeConnection: TunerConnection? = null

  @Volatile
  private var callState: String = "inactive"

  override fun definition() = ModuleDefinition {

    Name("AutoMicClaim")

    // Events emitted to JS.
    // carConnection  — payload: { state: 'connected' | 'disconnected' }
    // callState      — payload: { state: 'inactive' | 'pending' | 'active' | 'ended' }
    // endCallButton  — payload: {} (car's physical end-call key via Telecom)
    Events("carConnection", "callState", "endCallButton")

    OnCreate {
      phoneAccountRegistrar = PhoneAccountRegistrar(context)
      carConnectionWatcher = CarConnectionWatcher(context)
      carConnectionWatcher.start { isConnected ->
        val state = if (isConnected) "connected" else "disconnected"
        sendEvent("carConnection", mapOf("state" to state))
      }
    }

    OnDestroy {
      carConnectionWatcher.stop()
      activeConnection?.disconnect()
      activeConnection = null
      TunerConnectionService.connectionFactory = null
      phoneAccountRegistrar.unregister()
    }

    // -----------------------------------------------------------------------
    // Car connection
    // -----------------------------------------------------------------------

    AsyncFunction("getCarConnectionStateAsync") {
      if (carConnectionWatcher.isCarConnected) "connected" else "disconnected"
    }

    // -----------------------------------------------------------------------
    // Call control
    // -----------------------------------------------------------------------

    AsyncFunction("startTunerCallAsync") { promise: Promise ->
      val ctx = context
      if (!hasManageOwnCallsPermission(ctx)) {
        promise.reject("E_NO_PERMISSION", "MANAGE_OWN_CALLS permission is not granted.", null)
        return@AsyncFunction
      }

      if (callState == "active" || callState == "pending") {
        // Already in a call; treat as success.
        promise.resolve(null)
        return@AsyncFunction
      }

      try {
        phoneAccountRegistrar.ensureRegistered()

        // Inject the factory before addNewIncomingCall so the ConnectionService
        // has it available the moment Telecom binds.
        TunerConnectionService.connectionFactory = TunerConnectionService.ConnectionFactory {
          val conn = TunerConnection(object : TunerConnection.EventCallback {
            override fun onCallActive() {
              callState = "active"
              sendEvent("callState", mapOf("state" to "active"))
            }

            override fun onCallEnded(fromCarButton: Boolean) {
              callState = "ended"
              activeConnection = null
              TunerConnectionService.connectionFactory = null
              sendEvent("callState", mapOf("state" to "ended"))
              if (fromCarButton) {
                sendEvent("endCallButton", emptyMap<String, Any?>())
              }
            }
          })
          activeConnection = conn
          conn
        }

        val telecomManager = ctx.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
        val extras = android.os.Bundle().apply {
          putParcelable(
            TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE,
            phoneAccountRegistrar.phoneAccountHandle
          )
        }

        callState = "pending"
        sendEvent("callState", mapOf("state" to "pending"))

        telecomManager.addNewIncomingCall(phoneAccountRegistrar.phoneAccountHandle, extras)
        promise.resolve(null)

      } catch (e: Exception) {
        callState = "inactive"
        TunerConnectionService.connectionFactory = null
        promise.reject("E_TELECOM", e.message ?: "Failed to start tuner call", e)
      }
    }

    AsyncFunction("endTunerCallAsync") {
      val conn = activeConnection
      if (conn != null) {
        conn.disconnect()
      } else {
        // No active connection; just reset state.
        if (callState != "inactive") {
          callState = "inactive"
          sendEvent("callState", mapOf("state" to "inactive"))
        }
      }
      TunerConnectionService.connectionFactory = null
    }

    AsyncFunction("getCallStateAsync") {
      callState
    }

    // -----------------------------------------------------------------------
    // Permission helpers
    // -----------------------------------------------------------------------

    AsyncFunction("hasManageOwnCallsPermissionAsync") {
      hasManageOwnCallsPermission(context)
    }

    AsyncFunction("requestManageOwnCallsPermissionAsync") { promise: Promise ->
      // MANAGE_OWN_CALLS is a normal (non-dangerous) permission. It is either
      // granted at install time or requires the user to enable it in system
      // settings on affected OEM builds. There is no runtime request dialog for
      // normal permissions — ContextCompat.checkSelfPermission is the ground
      // truth. We surface this honestly to the caller.
      val granted = hasManageOwnCallsPermission(context)
      promise.resolve(granted)
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private fun hasManageOwnCallsPermission(ctx: Context): Boolean {
    return ContextCompat.checkSelfPermission(
      ctx,
      Manifest.permission.MANAGE_OWN_CALLS
    ) == PackageManager.PERMISSION_GRANTED
  }
}
