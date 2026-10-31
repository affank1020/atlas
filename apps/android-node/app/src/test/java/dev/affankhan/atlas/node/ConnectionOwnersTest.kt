package dev.affankhan.atlas.node

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionOwnersTest {
    @Test fun activityMayStopWithoutClosingServiceConnection() {
        val both = ConnectionOwners(activityVisible = true, serviceRunning = true)
        val otherApp = both.copy(activityVisible = false)
        assertTrue(otherApp.connected)
        assertFalse(otherApp.canApproveClipboard)
    }

    @Test fun serviceMayStopWithoutClosingVisibleActivityConnection() {
        val both = ConnectionOwners(activityVisible = true, serviceRunning = true)
        assertTrue(both.copy(serviceRunning = false).connected)
    }

    @Test fun noOwnerMeansSocketMustClose() {
        assertFalse(ConnectionOwners().connected)
        assertFalse(ConnectionOwners(serviceRunning = true)
            .copy(serviceRunning = false).connected)
    }

    @Test fun backgroundServiceDoesNotApproveClipboard() {
        assertFalse(ConnectionOwners(serviceRunning = true).canApproveClipboard)
        assertTrue(ConnectionOwners(activityVisible = true).canApproveClipboard)
    }
}
