package dev.affankhan.atlas.node

import okhttp3.WebSocket

/** A graceful WebSocket.close() can remain alive during an incomplete handshake.
 * Immediately cancel the transport when the UI goes into the background.
 */
internal fun cancelBackgroundSocket(socket: WebSocket?) {
    socket?.cancel()
}
