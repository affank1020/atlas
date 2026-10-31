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
}
