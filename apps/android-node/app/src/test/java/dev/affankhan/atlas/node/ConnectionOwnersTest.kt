package dev.affankhan.atlas.node

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionOwnersTest {
    @Test fun activityMayStopWithoutClosingServiceConnection() {
        val both = ConnectionOwners(visibleActivities = 1, serviceRunning = true)
        val otherApp = both.activityStopped()
        assertTrue(otherApp.connected)
        assertFalse(otherApp.canApproveClipboard)
    }

    @Test fun serviceMayStopWithoutClosingVisibleActivityConnection() {
        val both = ConnectionOwners(visibleActivities = 1, serviceRunning = true)
        assertTrue(both.copy(serviceRunning = false).connected)
    }

    @Test fun overlappingActivitiesDoNotDisconnectEachOther() {
        val first = ConnectionOwners().activityStarted()
        val second = first.activityStarted()
        val oneStopped = second.activityStopped()
        assertTrue(oneStopped.connected)
        assertTrue(oneStopped.canApproveClipboard)
        assertFalse(oneStopped.activityStopped().connected)
        assertFalse(oneStopped.activityStopped().activityStopped().connected)
    }

    @Test fun noOwnerMeansSocketMustClose() {
        assertFalse(ConnectionOwners().connected)
        assertFalse(ConnectionOwners(serviceRunning = true)
            .copy(serviceRunning = false).connected)
    }

    @Test fun backgroundServiceDoesNotApproveClipboard() {
        assertFalse(ConnectionOwners(serviceRunning = true).canApproveClipboard)
        assertTrue(ConnectionOwners(visibleActivities = 1).canApproveClipboard)
    }
}
