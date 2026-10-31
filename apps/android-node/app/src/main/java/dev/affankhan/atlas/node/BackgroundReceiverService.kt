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
import android.os.SystemClock

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

        fun notifyIncoming(context: Context, remainingMs: Long): Boolean {
            if (!hasNotificationPermission(context) || remainingMs <= 0) return false
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

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
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

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val model = (application as AtlasNodeApp).model
        if (intent?.action == ACTION_STOP) {
            model.stopBackgroundReceiving()
            stopSelf()
            return START_NOT_STICKY
        }
        if (model.pairedNode == null || !hasNotificationPermission(this)) {
            model.stopBackgroundReceiving()
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
            stopSelf()
            return START_NOT_STICKY
        }
        model.startBackgroundReceiving()
        // No automatic restart after process death. The user must launch Atlas
        // again; a durable offline queue/push remains a separate implementation.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        (application as AtlasNodeApp).model.stopBackgroundReceiving()
        cancelIncoming(this)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
