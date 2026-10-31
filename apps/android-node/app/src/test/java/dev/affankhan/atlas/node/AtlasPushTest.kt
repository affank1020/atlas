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
        assertEquals(id,AtlasPush.parseRegistrationAck(ok))
        assertNull(AtlasPush.parseRegistrationAck(
            """{"type":"response","requestId":"$id","ok":true,"result":{"items":[]}}"""))
        assertNull(AtlasPush.parseRegistrationAck(
            """{"type":"response","requestId":"$id","ok":true,"result":{"registered":true,"text":"secret"}}"""))
    }
}
