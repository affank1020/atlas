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

    @Test fun registrationAdvertisesOnlyTextSharingCapabilities() {
        val stored = StoredNode("https://atlas.example.com",
            "123e4567-e89b-42d3-a456-426614174000", "a".repeat(43), "Samsung")
        val json = org.json.JSONObject(registrationMessage(stored, "0.1.0"))
        assertEquals("register", json.getString("type"))
        assertEquals(2, json.getInt("protocol"))
        assertEquals(2, json.getJSONArray("capabilities").length())
        assertEquals("device.share.send", json.getJSONArray("capabilities").getString(0))
        assertEquals("device.share.receive", json.getJSONArray("capabilities").getString(1))
        assertEquals("android", json.getString("platform"))
    }


    @Test fun incomingShareMustBeBoundedAuthenticatedEnvelopeAndFutureExpiry() {
        val requestId = "123e4567-e89b-42d3-a456-426614174001"
        val deliveryId = "123e4567-e89b-42d3-a456-426614174002"
        val source = "123e4567-e89b-42d3-a456-426614174003"
        val now = 1_800_000_000_000L
        fun raw(body: String = "Hello 🎉", expiry: Long = now + 45_000): String =
            org.json.JSONObject().put("type", "request").put("kind", "device_share")
                .put("requestId", requestId).put("deliveryId", deliveryId)
                .put("sourceNodeId", source).put("text", body)
                .put("expiresAt", java.time.Instant.ofEpochMilli(expiry).toString()).toString()
        assertEquals("Hello 🎉", parseIncomingDeviceShare(raw(), now)?.text)
        assertEquals(requestId, parseIncomingDeviceShare(raw(), now)?.requestId)
        // A server-issued 45s deadline is still valid when the tablet's clock
        // differs by 20s in either direction. The foreground prompt duration
        // is independently measured with elapsedRealtime().
        assertEquals("Hello 🎉", parseIncomingDeviceShare(raw(), now - 20_000)?.text)
        assertEquals("Hello 🎉", parseIncomingDeviceShare(raw(), now + 20_000)?.text)
        assertEquals("Hello 🎉", parseIncomingDeviceShare(raw(), now + 46_000)?.text)
        assertEquals(null, parseIncomingDeviceShare(raw(), now + INCOMING_MAX_CLOCK_SKEW_MS + 46_000))
        assertEquals(null, parseIncomingDeviceShare(raw(expiry = now + INCOMING_SERVER_TTL_MS +
            INCOMING_MAX_CLOCK_SKEW_MS + 1), now))
        assertEquals(requestId, incomingDeviceShareRequestId(raw()))
        assertEquals(null, incomingDeviceShareRequestId("""{"type":"request","kind":"workspace","requestId":"$requestId"}"""))
        assertEquals(null, parseIncomingDeviceShare(raw(body = ""), now))
        assertEquals(null, parseIncomingDeviceShare(raw(body = "x".repeat(MAX_SHARE_CHARACTERS + 1)), now))
        assertEquals(null, parseIncomingDeviceShare(raw().replace("device_share", "workspace"), now))
        assertEquals(null, parseIncomingDeviceShare(raw().dropLast(1) + ""","unexpected":true}""", now))
        assertEquals(null, parseIncomingDeviceShare(raw().replace(source, "bad"), now))
    }


    @Test fun recentIncomingCacheDeduplicatesByIdAndRejectsAlteredContent() {
        val id = "123e4567-e89b-42d3-a456-426614174001"
        val deliveryId = "123e4567-e89b-42d3-a456-426614174002"
        val source = "123e4567-e89b-42d3-a456-426614174003"
        val share = IncomingDeviceShare(id, deliveryId, source, "sensitive ✨", 9_999_999L)
        val cache = RecentIncomingShares()
        assertEquals(null, cache.lookup(share, 100L))
        cache.remember(share, IncomingShareOutcome.ACCEPTED, 100L)
        assertEquals(IncomingShareOutcome.ACCEPTED, cache.lookup(share, 101L))
        assertEquals(IncomingShareOutcome.REPLAY, cache.lookup(share.copy(text = "tampered"), 101L))
        assertEquals(IncomingShareOutcome.REPLAY, cache.lookup(share.copy(sourceNodeId = id), 101L))
        assertEquals(null, cache.lookup(share, 300_100L))
        cache.remember(share, IncomingShareOutcome.COPY_FAILED, 300_100L)
        assertEquals(null, cache.lookup(share, 300_101L))
    }

    @Test fun incomingShareReceiptsAreStrictlyCorrelatedAndDoNotContainText() {
        val requestId = "123e4567-e89b-42d3-a456-426614174001"
        for (outcome in IncomingShareOutcome.entries) {
            val response = org.json.JSONObject(incomingDeviceShareResponse(requestId, outcome))
            assertEquals(requestId, response.getString("requestId"))
            assertEquals("response", response.getString("type"))
            assertFalse(response.toString().contains("secret"))
            when (outcome) {
                IncomingShareOutcome.ACCEPTED -> assertTrue(response.getJSONObject("result").getBoolean("accepted"))
                IncomingShareOutcome.DECLINED -> assertFalse(response.getJSONObject("result").getBoolean("accepted"))
                IncomingShareOutcome.BUSY -> assertEquals("SHARE_BUSY", response.getJSONObject("error").getString("code"))
                IncomingShareOutcome.COPY_FAILED ->
                    assertEquals("SHARE_CLIPBOARD_FAILED", response.getJSONObject("error").getString("code"))
                IncomingShareOutcome.REPLAY ->
                    assertEquals("SHARE_REPLAY", response.getJSONObject("error").getString("code"))
                IncomingShareOutcome.EXPIRED ->
                    assertEquals("SHARE_EXPIRED", response.getJSONObject("error").getString("code"))
            }
        }
        assertTrue(runCatching {
            incomingDeviceShareResponse("bad", IncomingShareOutcome.ACCEPTED)
        }.isFailure)
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
        // New server adds durable receive eligibility; older server replies
        // omit it and remain valid without silently claiming support.
        val updated = raw.replace("\"available\":true", "\"available\":true,\"queueCapable\":true")
        assertEquals(listOf(ShareRecipient(mac, "My Mac", "darwin", "online", true, true)),
            parseRecipientsReply(updated)?.recipients)
        assertEquals(null, parseRecipientsReply(updated.replace("\"queueCapable\":true",
            "\"queueCapable\":\"true\"")))
        assertEquals(null, parseRecipientsReply(updated.replace("\"queueCapable\":true",
            "\"unexpected\":true")))
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
