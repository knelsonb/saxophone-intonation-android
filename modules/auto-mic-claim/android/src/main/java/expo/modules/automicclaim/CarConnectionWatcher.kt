package expo.modules.automicclaim

import android.app.UiModeManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter

/**
 * Watches for Android Auto (UI_MODE_TYPE_CAR) connect/disconnect events.
 *
 * We register a BroadcastReceiver for the standard car-mode intents rather than
 * polling UiModeManager. The receiver is created externally (see CarModeReceiver)
 * so it can be declared in the manifest for reliability when the app is not
 * foregrounded; this class handles registration/unregistration of a
 * programmatic listener that is active while the module is alive.
 *
 * On construction we read the current mode synchronously so the first call to
 * getCarConnectionStateAsync returns an accurate answer without waiting for a
 * broadcast.
 */
class CarConnectionWatcher(private val context: Context) {

  private var listener: ((isConnected: Boolean) -> Unit)? = null

  @Volatile
  var isCarConnected: Boolean = false
    private set

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
      when (intent.action) {
        "android.app.action.ENTER_CAR_MODE" -> updateState(true)
        "android.app.action.EXIT_CAR_MODE"  -> updateState(false)
      }
    }
  }

  private var receiverRegistered = false

  init {
    // Snapshot the current UI mode so the first getCarConnectionStateAsync
    // call is accurate even if no broadcast has been received yet.
    val uiManager = context.getSystemService(Context.UI_MODE_SERVICE) as UiModeManager
    // Configuration.UI_MODE_TYPE_CAR == 3. UiModeManager exposes currentModeType
    // which returns the UI_MODE_TYPE_* portion of Configuration.uiMode.
    // There is no UiModeManager named constant for CAR mode before API 31; we
    // use the raw integer value which has been stable since API 8.
    isCarConnected = uiManager.currentModeType == 3
  }

  fun start(onChange: (isConnected: Boolean) -> Unit) {
    listener = onChange
    if (!receiverRegistered) {
      val filter = IntentFilter().apply {
        addAction("android.app.action.ENTER_CAR_MODE")
        addAction("android.app.action.EXIT_CAR_MODE")
      }
      context.registerReceiver(receiver, filter)
      receiverRegistered = true
    }
  }

  fun stop() {
    listener = null
    if (receiverRegistered) {
      try {
        context.unregisterReceiver(receiver)
      } catch (_: IllegalArgumentException) {
        // Already unregistered.
      }
      receiverRegistered = false
    }
  }

  private fun updateState(connected: Boolean) {
    isCarConnected = connected
    listener?.invoke(connected)
  }
}
