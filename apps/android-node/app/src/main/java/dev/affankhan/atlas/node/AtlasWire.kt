package dev.affankhan.atlas.node

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.UUID

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
    .put("capabilities", JSONArray().put("device.share.send")).toString()

internal fun isRegistrationAcknowledgement(raw: String, nodeId: String): Boolean =
    runCatching {
        val message = JSONObject(raw)
        message.optString("type") == "registered" &&
            message.optString("nodeId") == nodeId &&
            message.optInt("protocol") == 2
    }.getOrDefault(false)

/** Explicit, manually chosen Node target. Never infer sender identity from the client. */
internal fun validNodeId(value: String): Boolean =
    value.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"))

internal fun shareMessage(
    requestId: String, deliveryId: String, targetId: String, text: String,
): String {
    require(validNodeId(requestId) && validNodeId(deliveryId) && validNodeId(targetId))
    require(text.isNotBlank() && text.length <= MAX_SHARE_CHARACTERS)
    return JSONObject()
        .put("type", "device.share.submit")
        .put("requestId", requestId)
        .put("deliveryId", deliveryId)
        .put("targetNodeId", targetId)
        .put("text", text).toString()
}

internal data class ShareReply(
    val requestId: String, val accepted: Boolean? = null, val errorCode: String? = null,
)

/** Reject malformed/unexpected Node responses without leaking user-selected text. */
internal fun parseShareReply(raw: String): ShareReply? = runCatching {
    val json = JSONObject(raw)
    val id = json.getString("requestId")
    if (json.getString("type") != "response" || !validNodeId(id)) return@runCatching null
    when (json.get("ok")) {
        true -> {
            val result = json.getJSONObject("result")
            if (!result.has("accepted") || result.length() != 1) return@runCatching null
            val accepted = result.get("accepted") as? Boolean ?: return@runCatching null
            ShareReply(id, accepted = accepted)
        }
        false -> {
            val code = json.getJSONObject("error").getString("code")
            if (!code.matches(Regex("[A-Z_]{1,80}"))) return@runCatching null
            ShareReply(id, errorCode = code)
        }
        else -> null
    }
}.getOrNull()
