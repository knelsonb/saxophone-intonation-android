package expo.modules.automicclaim

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Manifest-declared broadcast receiver for car-mode enter/exit intents.
 *
 * The manifest declaration ensures we receive these broadcasts even when the
 * app is not foregrounded (relevant if the user launches the app after
 * connecting to Android Auto, so the initial state is already 'connected').
 *
 * When the module is alive the CarConnectionWatcher registers its own
 * programmatic receiver that handles live callbacks; this receiver's job is
 * limited to updating the static snapshot so getCarConnectionStateAsync can
 * answer correctly even before the module is instantiated.
 */
class CarModeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      "android.app.action.ENTER_CAR_MODE" -> lastKnownCarConnected = true
      "android.app.action.EXIT_CAR_MODE"  -> lastKnownCarConnected = false
    }
  }

  companion object {
    @Volatile
    var lastKnownCarConnected: Boolean = false
  }
}
