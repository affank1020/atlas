package dev.affankhan.atlas.node

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Handler
import android.os.Looper

/**
 * An explicit, user-started remote-messaging foreground service. This keeps
 * the existing Node v2 WebSocket open while other apps are visible, but is NOT
 * an offline queue, a push receiver, or a guarantee against Android Doze.
 */
class BackgroundReceiverService : Service() {
    companion object {
        const val ACTION_STOP = "dev.affankhan.atlas.node.STOP_BACKGROUND_RECEIVING"
        private const val CHANNEL_STATUS = "atlas-node-background"
        private const val CHANNEL_INCOMING = "atlas-node-incoming"
        private const val STATUS_ID = 9401
        private const val INCOMING_ID = 9402

        fun hasNotificationPermission(context: Context): Boolean =
            Build.VERSION.SDK_INT < 33 ||
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED

        /**
         * Re-create missing channels, but never bypass user-disabled channels.
         * Android retains the user's channel settings after createNotificationChannel.
         */
        private fun ensureChannels(manager: NotificationManager) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL_STATUS, "Atlas background receiving", NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Atlas Node's user-enabled connection to approved devices"
                lockscreenVisibility = Notification.VISIBILITY_SECRET
            })
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL_INCOMING, "Incoming Atlas transfers", NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Review a short-lived transfer from an approved Atlas Node"
                lockscreenVisibility = Notification.VISIBILITY_SECRET
            })
        }

        fun hasUsableNotifications(context: Context): Boolean {
            if (!hasNotificationPermission(context)) return false
            return try {
                val manager = context.getSystemService(NotificationManager::class.java)
                ensureChannels(manager)
                backgroundNotificationsUsable(
                    permissionGranted = true,
                    appNotificationsEnabled = manager.areNotificationsEnabled(),
                    statusImportance = manager.getNotificationChannel(CHANNEL_STATUS)?.importance,
                    incomingImportance = manager.getNotificationChannel(CHANNEL_INCOMING)?.importance,
                )
            } catch (_: RuntimeException) {
                false
            }
        }

        fun notifyIncoming(context: Context, remainingMs: Long): Boolean {
            if (!hasUsableNotifications(context) || remainingMs <= 0) return false
            return try {
                val manager = context.getSystemService(NotificationManager::class.java)
                val open = PendingIntent.getActivity(
                    context, 2, Intent(context, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                val message = Notification.Builder(context, CHANNEL_INCOMING)
                    .setSmallIcon(android.R.drawable.stat_notify_more)
                    .setContentTitle("Incoming Atlas text")
                    .setContentText("Open Atlas to review and approve.")
                    .setContentIntent(open)
                    .setAutoCancel(true)
                    .setVisibility(Notification.VISIBILITY_SECRET)
                    .setCategory(Notification.CATEGORY_MESSAGE)
                    .setTimeoutAfter(remainingMs)
                    .build()
                manager.notify(INCOMING_ID, message)
                true
            } catch (_: SecurityException) {
                false
            }
        }

        fun cancelIncoming(context: Context) {
            context.getSystemService(NotificationManager::class.java).cancel(INCOMING_ID)
        }
    }

    private val handler = Handler(Looper.getMainLooper())

    private val verifyChannels = object : Runnable {
        override fun run() {
            if (!hasUsableNotifications(this@BackgroundReceiverService)) {
                (application as AtlasNodeApp).model.reportBackgroundError(
                    "Atlas notifications are blocked. Enable both Atlas channels in Android Settings.")
                stopSelf()
                return
            }
            // Android does not notify this Service when the user blocks its
            // channels. Poll only while explicitly enabled to avoid a hidden
            // indefinitely-running receiver with no usable Stop notification.
            handler.postDelayed(this, 10_000L)
        }
    }

    override fun onCreate() {
        super.onCreate()
        // Channels are provisioned by hasUsableNotifications before enabling.
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val model = (application as AtlasNodeApp).model
        if (intent?.action == ACTION_STOP) {
            model.stopBackgroundReceiving()
            stopSelf()
            return START_NOT_STICKY
        }
        if (model.pairedNode == null || !hasUsableNotifications(this)) {
            model.stopBackgroundReceiving()
            model.reportBackgroundError(
                "Pair the Node and enable Atlas notifications and both channels in Android Settings.")
            stopSelf()
            return START_NOT_STICKY
        }
        val open = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 3, Intent(this, BackgroundReceiverService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, CHANNEL_STATUS)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Atlas background receiving")
            .setContentText("Connected when Android permits; tap to open Atlas.")
            .setOngoing(true)
            .setContentIntent(open)
            .setVisibility(Notification.VISIBILITY_SECRET)
            .addAction(Notification.Action.Builder(
                android.R.drawable.ic_menu_close_clear_cancel, "Stop", stop,
            ).build())
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(STATUS_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
            } else {
                startForeground(STATUS_ID, notification)
            }
        } catch (_: RuntimeException) {
            model.stopBackgroundReceiving()
            model.reportBackgroundError(
                "Android refused to start the receiving service. Check system restrictions.")
            stopSelf()
            return START_NOT_STICKY
        }
        model.startBackgroundReceiving()
        handler.removeCallbacks(verifyChannels)
        handler.postDelayed(verifyChannels, 10_000L)
        // No automatic restart after process death. The user must launch Atlas
        // again; a durable offline queue/push remains a separate implementation.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(verifyChannels)
        (application as AtlasNodeApp).model.stopBackgroundReceiving()
        cancelIncoming(this)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
