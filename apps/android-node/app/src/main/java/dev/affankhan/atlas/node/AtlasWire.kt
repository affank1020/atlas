package dev.affankhan.atlas.node

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

/** Separates app-release version, protocol v2 and the HTTPS/WSS transport address. */
internal data class AtlasEndpoint(val httpsBase: String, val wssUrl: String) {
    val enrolUrl: String get() = "$httpsBase/node/enrol"
}

internal fun parseAtlasEndpoint(input: String): AtlasEndpoint {
    val value = input.trim()
    val uri = try { URI(value) } catch (_: Exception) { throw IllegalArgumentException("Enter a valid HTTPS Atlas server URL.") }
    require(uri.scheme?.lowercase() == "https" && !uri.host.isNullOrBlank() &&
        uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
        (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") && uri.port <= 65535) {
        "Use the HTTPS Atlas server origin, with no path, query or credentials."
    }
    val base = URI("https", null, uri.host, uri.port, null, null, null).toASCIIString()
    return AtlasEndpoint(base, base.replaceFirst("https://", "wss://") + "/node/connect")
}

internal fun registrationMessage(node: StoredNode, version: String): String = JSONObject()
    .put("type", "register").put("protocol", 2)
    .put("nodeId", node.nodeId).put("name", node.name)
    .put("platform", "android").put("version", version)
    .put("capabilities", JSONArray()).toString()

internal fun isRegistrationAcknowledgement(raw: String, nodeId: String): Boolean =
    runCatching {
        val message = JSONObject(raw)
        message.optString("type") == "registered" &&
            message.optString("nodeId") == nodeId &&
            message.optInt("protocol") == 2
    }.getOrDefault(false)
