package dev.affankhan.atlas.node

import android.app.NotificationManager
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Channel blocking must fail closed independently of Android 13 permission. */
class NotificationReadinessTest {
    private fun usable(permission: Boolean = true, appEnabled: Boolean = true,
                       status: Int? = NotificationManager.IMPORTANCE_LOW,
                       incoming: Int? = NotificationManager.IMPORTANCE_HIGH) =
        backgroundNotificationsUsable(permission, appEnabled, status, incoming)

    @Test fun allPermissionsAndBothChannelsRequired() {
        assertTrue(usable())
        assertFalse(usable(permission = false))
        assertFalse(usable(appEnabled = false)) // Android 8–12 global notification switch
        assertFalse(usable(status = NotificationManager.IMPORTANCE_NONE))
        assertFalse(usable(incoming = NotificationManager.IMPORTANCE_NONE))
        assertFalse(usable(status = null))
        assertFalse(usable(incoming = null))
        assertFalse(usable(status = NotificationManager.IMPORTANCE_NONE,
            incoming = NotificationManager.IMPORTANCE_NONE))
    }
}
