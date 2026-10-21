package dev.affankhan.atlas.node

import okhttp3.Request
import okhttp3.WebSocket
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Test

/** Simulates stopping while the WebSocket is still connecting. */
class BackgroundSocketTest {
    @Test fun stoppingCancelsInFlightSocketInsteadOfGracefulClose() {
        val socket = FakeConnectingWebSocket()
        cancelBackgroundSocket(socket)
        assertEquals(1, socket.cancelCount)
        assertEquals(0, socket.closeCount)
    }

    @Test fun stopWithoutSocketIsSafe() {
        cancelBackgroundSocket(null)
    }

    private class FakeConnectingWebSocket : WebSocket {
        var cancelCount = 0
        var closeCount = 0
        override fun request(): Request =
            Request.Builder().url("https://example.org/node/connect").build()
        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean = false
        override fun send(bytes: ByteString): Boolean = false
        override fun close(code: Int, reason: String?): Boolean {
            closeCount++
            return true
        }
        override fun cancel() { cancelCount++ }
    }
}
