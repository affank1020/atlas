package dev.affankhan.atlas.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InboxWireTest {
    private val a = "123e4567-e89b-42d3-a456-426614174000"
    private val b = "123e4567-e89b-42d3-a456-426614174001"
    private val c = "123e4567-e89b-42d3-a456-426614174002"

    @Test fun validListAndResolutionAreStrict() {
        val list = """{"type":"response","requestId":"$a","ok":true,"result":{"items":[{"deliveryId":"$b","sourceNodeId":"$c","text":"hello","expiresAt":"2030-01-01T00:00:00Z"}]}}"""
        val parsed = parseInboxListReply(list)
        assertEquals(a, parsed?.requestId)
        assertEquals("hello", parsed?.items?.single()?.text)
        val copied = """{"type":"response","requestId":"$a","ok":true,"result":{"state":"copied"}}"""
        assertEquals("copied", parseInboxResolutionReply(copied)?.state)
        assertTrue(inboxListRequest(a).contains("device.share.inbox.list"))
        assertTrue(inboxResolutionRequest(a,b,true).contains("device.share.inbox.resolve"))
    }

    @Test fun malformedAndUnboundedPayloadsAreRejected() {
        val list = """{"type":"response","requestId":"$a","ok":true,"result":{"items":[{"deliveryId":"$b","sourceNodeId":"$c","text":"hello","expiresAt":"2030-01-01T00:00:00Z"}],"extra":"no"}}"""
        assertNull(parseInboxListReply(list))
        val copied = """{"type":"response","requestId":"$a","ok":true,"result":{"state":"accepted"}}"""
        assertNull(parseInboxResolutionReply(copied))
        val errors = """{"type":"response","requestId":"$a","ok":false,"error":{"code":"SHARE_DENIED","message":"denied"}}"""
        assertEquals("SHARE_DENIED", parseInboxListReply(errors)?.errorCode)
        assertEquals("SHARE_DENIED", parseInboxResolutionReply(errors)?.errorCode)
    }
}
