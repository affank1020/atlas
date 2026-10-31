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
    private const val PENDING_REVOCATION = "server-revocation-pending"

    fun enabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ENABLED, false)

    fun setEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(ENABLED, enabled).apply()
        if (configured(context)) FirebaseMessaging.getInstance().isAutoInitEnabled = enabled
    }

    /** Persist an unconfirmed server-side opt-out across process death. */
    fun revocationPending(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(PENDING_REVOCATION, false)

    fun markRevocationPending(context: Context, pending: Boolean) {
        // Synchronous commit: the service may be stopped immediately after
        // the correlated remote acknowledgement or our bounded timeout.
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(PENDING_REVOCATION, pending).commit()
    }

    /** Invalidate the old Firebase token even if Atlas is unreachable.
     * A failed deletion is surfaced to the caller; never claim revocation.
     */
    fun deleteToken(context: Context, finished: (Boolean) -> Unit) {
        if (!configured(context)) {
            finished(true)
            return
        }
        FirebaseMessaging.getInstance().deleteToken()
            .addOnCompleteListener { finished(it.isSuccessful) }
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
        FirebaseMessaging.getInstance().isAutoInitEnabled = enabled(application)
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

    fun isOpaqueWake(data: Map<String, String>): Boolean {
        if (data.size != 2 || data["kind"] != "atlas_inbox") return false
        val id = data["deliveryId"] ?: return false
        return runCatching { UUID.fromString(id).toString() == id }.getOrDefault(false)
    }

    /** Responses contain no command discriminator; the ViewModel correlates
     * this strictly bounded envelope with its own outstanding request UUID. */
    fun parseRegistrationReply(raw: String): PushRegistrationReply? = runCatching {
        val envelope = JSONObject(raw)
        if (envelope.length() != 4 || envelope.optString("type") != "response")
            return@runCatching null
        val id = envelope.getString("requestId")
        if (UUID.fromString(id).toString() != id) return@runCatching null
        when (envelope.opt("ok")) {
            true -> {
                val result = envelope.optJSONObject("result") ?: return@runCatching null
                if (result.length() != 1 || result.opt("registered") !is Boolean)
                    return@runCatching null
                PushRegistrationReply(id, result.getBoolean("registered"), null)
            }
            false -> {
                val error = envelope.optJSONObject("error") ?: return@runCatching null
                if (error.length() != 2) return@runCatching null
                val code = error.getString("code")
                val message = error.getString("message")
                if (!code.matches(Regex("[A-Z_]{1,80}")) || message.length > 200)
                    return@runCatching null
                PushRegistrationReply(id, null, code)
            }
            else -> null
        }
    }.getOrNull()
}

internal data class PushRegistrationReply(
    val requestId: String,
    val registered: Boolean?,
    val errorCode: String?,
)

/** Bounded retry policy used for both failed registration and opt-out.
 * Authentication and configuration errors require user/operator action.
 */
internal class PushRetryPolicy {
    private var retries = 0
    fun reset() { retries = 0 }
    fun nextDelay(errorCode: String): Long? {
        if (errorCode in setOf("SHARE_DENIED", "NODE_AUTH_INVALID", "INVALID_REQUEST",
                "NODE_DISCONNECTED", "SHARE_REPLAY")) return null
        if (retries >= 5) return null
        return (1_000L shl retries++).coerceAtMost(16_000L)
    }
}

/**
 * The transport must stay alive until the opt-out is acknowledged, or the
 * bounded deadline expires. Firebase token deletion is an independent safety
 * fallback; it never masquerades as successful server-side unregistration.
 */
internal data class PushRevocationResult(val serverConfirmed: Boolean, val firebaseTokenDeleted: Boolean)

internal class PushRevocationGate(private val finish: (PushRevocationResult) -> Unit) {
    private var serverConfirmed = false
    private var firebaseDeleted: Boolean? = null
    private var finished = false

    fun serverUnregistered() {
        if (finished) return
        serverConfirmed = true
        completeIfReady()
    }
    fun firebaseDeletionFinished(success: Boolean) {
        if (finished) return
        firebaseDeleted = success
        completeIfReady()
    }
    private fun completeIfReady() {
        if (serverConfirmed && firebaseDeleted != null) complete()
    }
    fun deadlineExpired() = complete()
    private fun complete() {
        if (finished) return
        finished = true
        finish(PushRevocationResult(serverConfirmed, firebaseDeleted == true))
    }
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
