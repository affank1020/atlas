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

    @Test fun registrationCannotAdvertisePrivilegedCapabilities() {
        val stored = StoredNode("https://atlas.example.com",
            "123e4567-e89b-42d3-a456-426614174000", "a".repeat(43), "Samsung")
        val json = org.json.JSONObject(registrationMessage(stored, "0.1.0"))
        assertEquals("register", json.getString("type"))
        assertEquals(2, json.getInt("protocol"))
        assertEquals(0, json.getJSONArray("capabilities").length())
        assertEquals("android", json.getString("platform"))
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
