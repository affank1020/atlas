package dev.affankhan.atlas.node

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.util.UUID

/**
 * Push is an opaque wake hint for the durable server inbox, not an approval
 * to fetch or copy message contents. The user must open Inbox.
 */
internal object AtlasPush {
    private const val PREFS = "atlas-push-consent"
    private const val ENABLED = "notifications-enabled"

    fun enabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ENABLED, false)

    fun setEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(ENABLED, enabled).apply()
    }

    fun configured(context: Context): Boolean = FirebaseApp.getApps(context).isNotEmpty()

    fun initialize(application: Application) {
        if (BuildConfig.ATLAS_FCM_APP_ID.isBlank() ||
            BuildConfig.ATLAS_FCM_SENDER_ID.isBlank() ||
            BuildConfig.ATLAS_FCM_API_KEY.isBlank() ||
            BuildConfig.ATLAS_FCM_PROJECT_ID.isBlank()) return
        val options = FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.ATLAS_FCM_APP_ID)
            .setGcmSenderId(BuildConfig.ATLAS_FCM_SENDER_ID)
            .setApiKey(BuildConfig.ATLAS_FCM_API_KEY)
            .setProjectId(BuildConfig.ATLAS_FCM_PROJECT_ID)
            .build()
        FirebaseApp.initializeApp(application, options)
    }

    fun currentToken(context: Context, onToken: (String) -> Unit) {
        if (!configured(context)) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            if (token.isNotBlank()) onToken(token)
        }
    }

    fun registerRequest(requestId: String, token: String): String =
        JSONObject().put("type", "device.push.register")
            .put("requestId", requestId).put("token", token).toString()

    fun unregisterRequest(requestId: String): String =
        JSONObject().put("type", "device.push.unregister")
            .put("requestId", requestId).toString()

    fun isOpaqueWake(data: Map<String, String>): Boolean =
        data.size == 2 && data["kind"] == "atlas_inbox" &&
            runCatching { UUID.fromString(data["deliveryId"]) }.isSuccess
}

class AtlasFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        if (!AtlasPush.enabled(this)) return
        Handler(Looper.getMainLooper()).post {
            (application as AtlasNodeApp).model.onPushTokenChanged(token)
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (!AtlasPush.enabled(this) || !AtlasPush.isOpaqueWake(message.data)) return
        // Do not start a foreground service or fetch data from a background callback.
        BackgroundReceiverService.notifyQueuedInbox(this)
    }
}
