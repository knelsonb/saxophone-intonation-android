package expo.modules.automicclaim

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.PhoneAccountHandle

/**
 * Self-managed ConnectionService. Telecom binds to this whenever it needs to
 * create a call on our PhoneAccountHandle.
 *
 * We only use addNewIncomingCall (not placeCall), so onCreateIncomingConnection
 * is the live path. onCreateOutgoingConnection is implemented as a safety valve
 * in case the PhoneAccount handle is ever used for an outgoing scenario.
 *
 * The static connectionFactory is injected by AutoMicClaimModule before any
 * call is placed. If it is null when Telecom binds, we return a failed
 * Connection so the system can recover gracefully rather than crashing.
 */
class TunerConnectionService : ConnectionService() {

  override fun onCreateIncomingConnection(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest?
  ): Connection {
    val factory = connectionFactory
    if (factory == null) {
      return Connection.createFailedConnection(
        android.telecom.DisconnectCause(android.telecom.DisconnectCause.ERROR, "Module not ready")
      )
    }
    val conn = factory.create()
    // Immediately move to ACTIVE — this is a fake call, no real answer needed.
    conn.onAnswer()
    return conn
  }

  override fun onCreateOutgoingConnection(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest?
  ): Connection {
    val factory = connectionFactory
    if (factory == null) {
      return Connection.createFailedConnection(
        android.telecom.DisconnectCause(android.telecom.DisconnectCause.ERROR, "Module not ready")
      )
    }
    val conn = factory.create()
    conn.onAnswer()
    return conn
  }

  companion object {
    // Set by AutoMicClaimModule.OnCreate; cleared by OnDestroy.
    @Volatile
    var connectionFactory: ConnectionFactory? = null
  }

  fun interface ConnectionFactory {
    fun create(): TunerConnection
  }
}
