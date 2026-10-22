package dev.affankhan.atlas.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecipientLookupGateTest {
    @Test fun unansweredLookupTimesOutAndAllowsRetryWithoutReconnecting() {
        val gate = RecipientLookupGate(2_500)
        assertTrue(gate.start("hung-request", 1_000))
        assertFalse(gate.start("parallel-request", 3_501))
        // A timeout must clear the same pending request that the socket would finish.
        assertFalse(gate.finish("wrong-request"))
        assertEquals("hung-request", gate.pendingRequestId)
        assertTrue(gate.finish("hung-request"))
        assertEquals(null, gate.pendingRequestId)
        assertFalse(gate.finish("hung-request"))
        assertTrue(gate.start("new-request", 11_000))
        assertFalse("Late reply must not affect a newer lookup", gate.finish("hung-request"))
        assertEquals("new-request", gate.pendingRequestId)
        assertTrue(gate.finish("new-request"))
    }

    @Test fun immediateRefreshDoesNotBeginOrChangePreviouslyCompletedLookup() {
        val gate = RecipientLookupGate(2_500)
        assertTrue(gate.start("first", 100))
        assertTrue(gate.finish("first"))
        assertFalse(gate.start("too-fast", 200))
        assertEquals(null, gate.pendingRequestId)
        assertFalse(gate.start("still-too-fast", 2_599))
        assertTrue(gate.start("refreshed", 2_600))
        assertTrue(gate.finish("refreshed"))
    }

    @Test fun disconnectResetsBothPendingRequestAndCooldown() {
        val gate = RecipientLookupGate(2_500)
        assertTrue(gate.start("old-socket", 10_000))
        gate.reset()
        assertEquals(null, gate.pendingRequestId)
        assertFalse(gate.finish("old-socket"))
        assertTrue(gate.start("new-socket", 10_001))
    }
}
