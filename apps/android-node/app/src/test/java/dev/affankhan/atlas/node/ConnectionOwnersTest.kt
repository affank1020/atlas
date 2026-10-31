package dev.affankhan.atlas.node

import org.junit.Assert.assertEquals
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
    @Test fun stopWithoutActivityRetainsSocketUntilPushAckOrDeadline() {
        val stopping = ConnectionOwners(serviceRunning = true).copy(serviceRunning = false)
        assertFalse(stopping.mayReleaseSocket(revocationPending = true))
        assertTrue(stopping.mayReleaseSocket(revocationPending = false))
    }

    @Test fun forgetWithActivityLeavingRetainsSocketUntilPushAckOrDeadline() {
        val leaving = ConnectionOwners(visibleActivities = 1).activityStopped()
        assertFalse(leaving.mayReleaseSocket(revocationPending = true))
        assertTrue(leaving.mayReleaseSocket(revocationPending = false))
    }

    @Test fun offThenOnBeforeServerAcknowledgementStartsOnceAndSkipsStaleStop() {
        val intent = BackgroundReceiveIntentGate()
        val effects = mutableListOf<String>()
        intent.start(revocationInProgress = false) { effects.add("start-1") }
        val oldStop = intent.stop { effects.add("stop-1") }
        intent.start(revocationInProgress = true) { effects.add("start-2") }
        assertTrue(intent.desiredEnabled)
        oldStop() // Server unregister acknowledgement for superseded stop
        assertEquals(listOf("start-1"), effects)
        intent.completeRevocation()
        assertEquals(listOf("start-1", "start-2"), effects)
        intent.completeRevocation()
        assertEquals(2, effects.size)
    }

    @Test fun offThenOnBeforeTimeoutCannotStopNewerServiceStart() {
        val intent = BackgroundReceiveIntentGate()
        val effects = mutableListOf<String>()
        val oldStop = intent.stop { effects.add("drop-socket-and-stop-service") }
        // A newer Service startId arrives before the old Stop times out.
        intent.start(revocationInProgress = true) { effects.add("start-service-new-id") }
        oldStop()
        assertTrue(effects.isEmpty())
        intent.completeRevocation() // timeout rather than successful ack
        assertEquals(listOf("start-service-new-id"), effects)
        assertTrue(intent.desiredEnabled)
    }

    @Test fun newestStopSupersedesPendingReenableAndIsOnlyOneApplied() {
        val intent = BackgroundReceiveIntentGate()
        val effects = mutableListOf<String>()
        val firstStop = intent.stop { effects.add("old-stop") }
        intent.start(revocationInProgress = true) { effects.add("queued-restart") }
        val lastStop = intent.stop { effects.add("last-stop") }
        firstStop()
        intent.completeRevocation()
        assertTrue(effects.isEmpty())
        lastStop()
        assertEquals(listOf("last-stop"), effects)
        assertFalse(intent.desiredEnabled)
    }

    @Test fun serviceRestartAfterNotificationStopDoesNotLoseNewConnectionOwner() {
        val intent = BackgroundReceiveIntentGate()
        val events = mutableListOf<String>()
        val notificationStop = intent.stop { events.add("remove-owner") }
        // Android delivers a new START command while the previous stop waits.
        intent.start(revocationInProgress = true) { events.add("start-owner") }
        val revoke = PushRevocationGate { notificationStop(); intent.completeRevocation() }
        revoke.serverUnregistered()
        revoke.firebaseDeletionFinished(true)
        assertEquals(listOf("start-owner"), events)
    }

}
