package dev.affankhan.atlas.node

import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Exercise real Android channel state; does not change Atlas's own channels. */
class NotificationChannelsTest {
    @Test fun disabledChannelIsReportedAsBlockedByAndroid() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(NotificationManager::class.java)
        val allowedId = "atlas-ci-allowed-channel"
        val blockedId = "atlas-ci-blocked-channel"
        try {
            manager.createNotificationChannel(NotificationChannel(
                allowedId, "Atlas CI allowed", NotificationManager.IMPORTANCE_LOW,
            ))
            manager.createNotificationChannel(NotificationChannel(
                blockedId, "Atlas CI blocked", NotificationManager.IMPORTANCE_NONE,
            ))
            val allowed = manager.getNotificationChannel(allowedId)?.importance
            val blocked = manager.getNotificationChannel(blockedId)?.importance
            assertEquals(NotificationManager.IMPORTANCE_NONE, blocked)
            assertTrue(backgroundNotificationsUsable(true, true, allowed, allowed))
            assertFalse(backgroundNotificationsUsable(true, true, allowed, blocked))
            assertFalse(backgroundNotificationsUsable(true, false, allowed, allowed))
        } finally {
            manager.deleteNotificationChannel(allowedId)
            manager.deleteNotificationChannel(blockedId)
        }
    }
}
