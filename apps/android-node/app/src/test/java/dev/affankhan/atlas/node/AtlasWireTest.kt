package dev.affankhan.atlas.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AtlasWireTest {
    @Test fun acceptsOnlyUnambiguousHttpsOrigin() {
        val endpoint = parseAtlasEndpoint("https://atlas.example.com")
        assertEquals("https://atlas.example.com/node/enrol", endpoint.enrolUrl)
        assertEquals("wss://atlas.example.com/node/connect", endpoint.wssUrl)
        for (invalid in listOf("http://atlas.example.com", "https://user:secret@atlas.example.com",
            "https://atlas.example.com/api", "https://atlas.example.com/?token=unsafe",
            "https://atlas.example.com/#fragment", "javascript:alert(1)")) {
            assertTrue("Expected $invalid to be denied", runCatching { parseAtlasEndpoint(invalid) }.isFailure)
        }
    }

    @Test fun registrationAdvertisesOnlyOutboundShareCapability() {
        val stored = StoredNode("https://atlas.example.com",
            "123e4567-e89b-42d3-a456-426614174000", "a".repeat(43), "Samsung")
        val json = org.json.JSONObject(registrationMessage(stored, "0.1.0"))
        assertEquals("register", json.getString("type"))
        assertEquals(2, json.getInt("protocol"))
        assertEquals(1, json.getJSONArray("capabilities").length())
        assertEquals("device.share.send", json.getJSONArray("capabilities").getString(0))
        assertEquals("android", json.getString("platform"))
    }

    @Test fun submitsBoundedTextWithoutClientSpecifiedSource() {
        val requestId = "123e4567-e89b-42d3-a456-426614174001"
        val deliveryId = "123e4567-e89b-42d3-a456-426614174002"
        val targetId = "123e4567-e89b-42d3-a456-426614174003"
        val message = org.json.JSONObject(shareMessage(requestId, deliveryId, targetId, "hello"))
        assertEquals("device.share.submit", message.getString("type"))
        assertEquals(targetId, message.getString("targetNodeId"))
        assertFalse(message.has("sourceNodeId"))
        assertTrue(runCatching { shareMessage(requestId, deliveryId, "bad", "hello") }.isFailure)
        assertTrue(runCatching { shareMessage(requestId, deliveryId, targetId, "x".repeat(16_385)) }.isFailure)
        assertTrue(runCatching { shareMessage(requestId, deliveryId, targetId, "   ") }.isFailure)
    }

    @Test fun replyRequiresStrictBooleanAndMatchingCorrelationId() {
        val id = "123e4567-e89b-42d3-a456-426614174001"
        assertEquals(true, parseShareReply("""{"type":"response","requestId":"$id","ok":true,"result":{"accepted":true}}""")?.accepted)
        assertEquals(false, parseShareReply("""{"type":"response","requestId":"$id","ok":true,"result":{"accepted":false}}""")?.accepted)
        assertEquals("SHARE_DENIED", parseShareReply("""{"type":"response","requestId":"$id","ok":false,"error":{"code":"SHARE_DENIED","message":"Denied"}}""")?.errorCode)
        assertEquals(null, parseShareReply("""{"type":"response","requestId":"$id","ok":true,"result":{"accepted":"true"}}"""))
        assertEquals(null, parseShareReply("not json"))
    }

    @Test fun recipientDirectoryUsesCorrelatedBoundedMetadata() {
        val id = "123e4567-e89b-42d3-a456-426614174001"
        val mac = "123e4567-e89b-42d3-a456-426614174002"
        val request = org.json.JSONObject(recipientDirectoryMessage(id))
        assertEquals("device.share.recipients", request.getString("type"))
        assertEquals(2, request.length())
        assertFalse(request.has("sourceNodeId"))
        val raw = """{"type":"response","requestId":"$id","ok":true,"result":{"recipients":[{"nodeId":"$mac","name":"My Mac","platform":"darwin","status":"online","available":true}]}}"""
        val parsed = parseRecipientsReply(raw)
        assertEquals(id, parsed?.requestId)
        assertEquals(listOf(ShareRecipient(mac, "My Mac", "darwin", "online", true)), parsed?.recipients)
        assertEquals(null, parseShareReply(raw))
        val denied = """{"type":"response","requestId":"$id","ok":false,"error":{"code":"SHARE_DENIED","message":"Denied"}}"""
        assertEquals("SHARE_DENIED", parseRecipientsReply(denied)?.errorCode)
        assertEquals(null, parseRecipientsReply(raw.replace("\"available\":true", "\"available\":\"true\"")))
        assertEquals(null, parseRecipientsReply(raw.replace("\"online\"", "\"offline\"")))
        assertEquals(null, parseRecipientsReply(raw.replace("\"name\":\"My Mac\"", "\"name\":\"\"")))
        val duplicated = raw.replace("]}}", ",{\"nodeId\":\"$mac\",\"name\":\"Copy\",\"platform\":\"darwin\",\"status\":\"online\",\"available\":true}]}}")
        assertEquals(null, parseRecipientsReply(duplicated))
    }

    @Test fun invalidHandshakeCannotClaimOnline() {
        val id = "123e4567-e89b-42d3-a456-426614174000"
        assertTrue(isRegistrationAcknowledgement(
            """{"type":"registered","protocol":2,"nodeId":"$id"}""", id))
        assertFalse(isRegistrationAcknowledgement(
            """{"type":"registered","protocol":1,"nodeId":"$id"}""", id))
        assertFalse(isRegistrationAcknowledgement(
            """{"type":"registered","protocol":2,"nodeId":"different"}""", id))
        assertFalse(isRegistrationAcknowledgement("garbled JSON", id))
    }
}
