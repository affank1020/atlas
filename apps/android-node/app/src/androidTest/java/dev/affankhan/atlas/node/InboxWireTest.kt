package dev.affankhan.atlas.node

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InboxWireTest {
    private val requestId="123e4567-e89b-42d3-a456-426614174001"
    private val deliveryId="123e4567-e89b-42d3-a456-426614174002"
    private val source="123e4567-e89b-42d3-a456-426614174003"

    @Test fun requestsAreTargetScopedAndNeverContainCredentialOrPlaintextWhenReading() {
        for (raw in listOf(inboxListRequest(requestId),
            inboxReadRequest(requestId,deliveryId),
            inboxDecideRequest(requestId,deliveryId,true),
            inboxDecideRequest(requestId,deliveryId,false))) {
            val json=JSONObject(raw)
            assertEquals(requestId,json.getString("requestId"))
            assertFalse(json.has("nodeId"))
            assertFalse(json.has("credential"))
            assertFalse(json.has("text"))
        }
        assertEquals("device.inbox.list",JSONObject(inboxListRequest(requestId)).getString("type"))
        assertEquals("device.inbox.read",JSONObject(inboxReadRequest(requestId,deliveryId)).getString("type"))
        assertEquals("user_copied",JSONObject(inboxDecideRequest(requestId,deliveryId,true)).getString("decision"))
        assertEquals("declined",JSONObject(inboxDecideRequest(requestId,deliveryId,false)).getString("decision"))
        assertTrue(runCatching { inboxReadRequest(requestId,"bad") }.isFailure)
    }

    @Test fun listAndReadHaveStrictBoundsAndMetadataOnlyListing() {
        val meta=JSONObject().put("deliveryId",deliveryId).put("sourceNodeId",source)
            .put("expiresAt","2026-11-01T19:00:00Z").put("createdAt","2026-10-31T19:00:00Z")
        fun envelope(result:JSONObject):String=JSONObject().put("type","response")
            .put("requestId",requestId).put("ok",true).put("result",result).toString()
        val list=envelope(JSONObject().put("items",org.json.JSONArray().put(meta)))
        val parsed=parseInboxReply(list)
        assertTrue(parsed is InboxReply.Items)
        assertEquals(deliveryId,(parsed as InboxReply.Items).items.first().deliveryId)
        assertFalse(list.contains("secret"))
        assertNull(parseInboxReply(envelope(JSONObject().put("items",
            org.json.JSONArray().put(meta).put(meta)))))
        val content=envelope(JSONObject().put("deliveryId",deliveryId)
            .put("sourceNodeId",source).put("text","Unicode 🎉"))
        assertEquals("Unicode 🎉",(parseInboxReply(content) as InboxReply.Content).text)
        assertNull(parseInboxReply(envelope(JSONObject().put("deliveryId",deliveryId)
            .put("sourceNodeId",source).put("text","x".repeat(16_385)))))
        assertNull(parseInboxReply(envelope(JSONObject().put("deliveryId",deliveryId)
            .put("sourceNodeId",source).put("text","Unicode 🎉").put("extra","bad"))))
    }

    @Test fun decisionAndErrorsAreSeparatedFromContents() {
        val decision=JSONObject().put("type","response").put("requestId",requestId)
            .put("ok",true).put("result",JSONObject().put("deliveryId",deliveryId)
                .put("status","user_copied")).toString()
        assertEquals("user_copied",(parseInboxReply(decision) as InboxReply.Decision).status)
        assertNull(parseInboxReply(decision.replace("user_copied","queued")))
        val failure=JSONObject().put("type","response").put("requestId",requestId)
            .put("ok",false).put("error",JSONObject().put("code","SHARE_DENIED")
                .put("message","Unavailable")).toString()
        assertEquals("SHARE_DENIED",(parseInboxReply(failure) as InboxReply.Failure).code)
        assertNull(parseInboxReply("{bad json"))
    }
}
