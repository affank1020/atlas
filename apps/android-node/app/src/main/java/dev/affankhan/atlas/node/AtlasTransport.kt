package dev.affankhan.atlas.node

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Outbound Node protocol transport. Until device capabilities exist, this client
 * registers with [] and deliberately cannot receive or execute Workspace operations.
 */
internal class AtlasTransport {
    private val client = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    /** Call from Dispatchers.IO; the ticket is sent only over validated HTTPS. */
    fun enrol(origin: AtlasEndpoint, token: String, name: String, version: String): StoredNode {
        require(token.length >= 32)
        require(name.isNotBlank() && name.length <= 200)
        val body = JSONObject()
            .put("token", token).put("name", name)
            .put("platform", "android").put("version", version)
            .toString().toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder().url(origin.enrolUrl).post(body).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException(
                "Atlas rejected the pairing ticket. Check that it is valid and unexpired."
            )
            val bytes = response.body?.string()?.take(4096) ?: throw IllegalStateException("Empty enrolment response.")
            val json = JSONObject(bytes)
            val nodeId = json.getString("nodeId")
            val credential = json.getString("credential")
            require(nodeId.matches(Regex("[0-9a-fA-F-]{36}")) && credential.length >= 32)
            return StoredNode(origin.httpsBase, nodeId, credential, name)
        }
    }

    fun connect(node: StoredNode, version: String, listener: (ConnectionEvent) -> Unit): WebSocket {
        val endpoint = parseAtlasEndpoint(node.origin)
        val request = Request.Builder()
            .url(endpoint.wssUrl)
            .header("Authorization", "Bearer " + node.credential)
            .build()
        var registered = false
        return client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(registrationMessage(node, version))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!registered) {
                    if (isRegistrationAcknowledgement(text, node.nodeId)) {
                        registered = true
                        listener(ConnectionEvent.Online)
                    } else {
                        webSocket.close(1008, "Registration rejected")
                        listener(ConnectionEvent.Offline("Atlas rejected the Node registration."))
                    }
                    return
                }
                // No device.* capabilities yet: never accept a Workspace command.
                webSocket.close(1008, "Unsupported request")
                listener(ConnectionEvent.Offline("Unsupported server request."))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener(ConnectionEvent.Offline("Node connection closed."))
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                // Do not leak network URLs, tokens, or server response bodies into UI/logs.
                listener(ConnectionEvent.Offline("Could not connect to Atlas."))
            }
        })
    }

    fun close() {
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }
}

internal sealed interface ConnectionEvent {
    data object Online : ConnectionEvent
    data class Offline(val detail: String) : ConnectionEvent
}
