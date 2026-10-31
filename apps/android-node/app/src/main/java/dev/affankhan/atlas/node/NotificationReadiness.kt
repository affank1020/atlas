package dev.affankhan.atlas.node

import android.app.NotificationManager

/**
 * The notification permission alone is insufficient on Android 8+: a user
 * can block the app or either of the two channels independently.
 *
 * A background share may only wait for approval when both the ongoing Stop
 * notification and the short-lived incoming approval notification are usable.
 */
internal fun backgroundNotificationsUsable(
    permissionGranted: Boolean,
    appNotificationsEnabled: Boolean,
    statusImportance: Int?,
    incomingImportance: Int?,
): Boolean =
    permissionGranted && appNotificationsEnabled &&
        statusImportance != null && incomingImportance != null &&
        statusImportance != NotificationManager.IMPORTANCE_NONE &&
        incomingImportance != NotificationManager.IMPORTANCE_NONE
