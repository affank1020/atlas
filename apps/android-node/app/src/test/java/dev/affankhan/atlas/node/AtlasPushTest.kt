package dev.affankhan.atlas.node

import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class AtlasPushTest {
    @Test fun onlyOpaqueWakeEnvelopeIsAllowed() {
        val id=UUID.randomUUID().toString()
        assertTrue(AtlasPush.isOpaqueWake(mapOf("kind" to "atlas_inbox", "deliveryId" to id)))
        assertFalse(AtlasPush.isOpaqueWake(mapOf("kind" to "atlas_inbox", "deliveryId" to "invalid")))
        assertFalse(AtlasPush.isOpaqueWake(mapOf("kind" to "atlas_inbox", "deliveryId" to id, "text" to "secret")))
        assertFalse(AtlasPush.isOpaqueWake(mapOf("kind" to "other", "deliveryId" to id)))
        assertFalse(AtlasPush.isOpaqueWake(mapOf("kind" to "atlas_inbox", "deliveryId" to "1-1-1-1-1")))
    }

    @Test fun acceptsOnlyWellFormedPushAcknowledgement() {
        val id=UUID.randomUUID().toString()
        val ok="""{"type":"response","requestId":"$id","ok":true,"result":{"registered":true}}"""
        val accepted = AtlasPush.parseRegistrationReply(ok)
        assertEquals(id, accepted?.requestId)
        assertEquals(true, accepted?.registered)
        assertNull(accepted?.errorCode)
        assertNull(AtlasPush.parseRegistrationReply(
            """{"type":"response","requestId":"$id","ok":true,"result":{"items":[]}}"""))
        assertNull(AtlasPush.parseRegistrationReply(
            """{"type":"response","requestId":"$id","ok":true,"result":{"registered":true,"text":"secret"}}"""))
    }

    @Test fun failedRegisterThenRecoveryAndOptOutAreCorrelated() {
        val id = UUID.randomUUID().toString()
        val failure = AtlasPush.parseRegistrationReply(
            """{"type":"response","requestId":"$id","ok":false,"error":{"code":"SHARE_UNAVAILABLE","message":"Offline inbox unavailable."}}""")
        assertEquals(id, failure?.requestId)
        assertEquals("SHARE_UNAVAILABLE", failure?.errorCode)
        assertNull(failure?.registered)
        val policy=PushRetryPolicy()
        assertEquals(1_000L, policy.nextDelay(requireNotNull(failure?.errorCode)))
        assertEquals(2_000L, policy.nextDelay("SHARE_BUSY"))
        val recovered = AtlasPush.parseRegistrationReply(
            """{"type":"response","requestId":"$id","ok":true,"result":{"registered":true}}""")
        assertEquals(true, recovered?.registered)
        policy.reset()
        assertEquals(1_000L, policy.nextDelay("SHARE_UNAVAILABLE"))
        val optedOut = AtlasPush.parseRegistrationReply(
            """{"type":"response","requestId":"$id","ok":true,"result":{"registered":false}}""")
        assertEquals(false, optedOut?.registered)
        assertNull(AtlasPush.parseRegistrationReply(
            """{"type":"response","requestId":"$id","ok":false,"error":{"code":"SHARE_UNAVAILABLE","message":"fail","text":"secret"}}"""))
    }

    @Test fun retryStopsAfterFiveAttemptsOrPermanentDenial() {
        val policy=PushRetryPolicy()
        assertNull(policy.nextDelay("SHARE_DENIED"))
        assertNull(policy.nextDelay("INVALID_REQUEST"))
        assertEquals(listOf(1_000L,2_000L,4_000L,8_000L,16_000L),
            (1..5).map { policy.nextDelay("SHARE_UNAVAILABLE") })
        assertNull(policy.nextDelay("SHARE_UNAVAILABLE"))
    }
    @Test fun stopWithoutVisibleActivityKeepsTransportUntilAckAndFirebaseCompletion() {
        val events = mutableListOf<String>()
        val gate = PushRevocationGate { result ->
            events.add("stop-transport")
            assertTrue(result.serverConfirmed)
            assertTrue(result.firebaseTokenDeleted)
        }
        // A Stop request is sent while the service still owns the socket.
        events.add("unregister-sent")
        gate.firebaseDeletionFinished(true)
        assertEquals(listOf("unregister-sent"), events)
        gate.serverUnregistered()
        assertEquals(listOf("unregister-sent", "stop-transport"), events)
        gate.deadlineExpired()
        assertEquals(2, events.size)
    }

    @Test fun forgetMustNotClearCredentialWithoutServerConfirmation() {
        var forgotIdentity = false
        var failureVisible = false
        val gate = PushRevocationGate { result ->
            if (result.serverConfirmed) forgotIdentity = true
            else failureVisible = true
        }
        gate.firebaseDeletionFinished(true)
        assertFalse(forgotIdentity)
        gate.deadlineExpired()
        assertTrue(failureVisible)
        assertFalse(forgotIdentity)
        // A delayed acknowledgement after the timeout cannot masquerade
        // as success or clear the credential.
        gate.serverUnregistered()
        assertFalse(forgotIdentity)
    }

    @Test fun forgetAfterServerAcknowledgementMayClearIdentity() {
        var clearCount = 0
        val gate = PushRevocationGate { result ->
            if (result.serverConfirmed) clearCount++
        }
        gate.serverUnregistered()
        assertEquals(0, clearCount)
        gate.firebaseDeletionFinished(false)
        assertEquals(1, clearCount)
        gate.deadlineExpired()
        assertEquals(1, clearCount)
    }

    @Test fun stopTimeoutIsBoundedAndNeverClaimsServerAcknowledgement() {
        var completed: PushRevocationResult? = null
        val gate = PushRevocationGate { completed = it }
        gate.firebaseDeletionFinished(true)
        assertNull(completed)
        gate.deadlineExpired()
        assertEquals(false, completed?.serverConfirmed)
        assertEquals(true, completed?.firebaseTokenDeleted)
    }

}
