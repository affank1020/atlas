package dev.affankhan.atlas.node

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.time.Instant
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
    .put("capabilities", JSONArray().put("device.share.send").put("device.share.receive")).toString()

internal fun isRegistrationAcknowledgement(raw: String, nodeId: String): Boolean =
    runCatching {
        val message = JSONObject(raw)
        message.optString("type") == "registered" &&
            message.optString("nodeId") == nodeId &&
            message.optInt("protocol") == 2
    }.getOrDefault(false)


/**
 * Authenticated Server → foreground Android Node delivery. No message content is
 * ever persisted; the caller must explicitly obtain approval before copying.
 */
internal data class IncomingDeviceShare(
    val requestId: String,
    val deliveryId: String,
    val sourceNodeId: String,
    val text: String,
    val expiresAtMs: Long,
)

internal fun parseIncomingDeviceShare(raw: String, nowMs: Long = System.currentTimeMillis()): IncomingDeviceShare? =
    runCatching {
        val json = JSONObject(raw)
        if (json.length() != 7 ||
            json.keys().asSequence().toSet() != setOf(
                "type", "kind", "requestId", "deliveryId", "sourceNodeId", "text", "expiresAt",
            ) ||
            json.optString("type") != "request" || json.optString("kind") != "device_share") {
            return@runCatching null
        }
        val requestId = json.opt("requestId") as? String ?: return@runCatching null
        val deliveryId = json.opt("deliveryId") as? String ?: return@runCatching null
        val sourceId = json.opt("sourceNodeId") as? String ?: return@runCatching null
        val body = json.opt("text") as? String ?: return@runCatching null
        val expiresAt = json.opt("expiresAt") as? String ?: return@runCatching null
        if (!validNodeId(requestId) || !validNodeId(deliveryId) ||
            !validNodeId(sourceId) || body.isEmpty() || body.length > MAX_SHARE_CHARACTERS) {
            return@runCatching null
        }
        val deadline = Instant.parse(expiresAt).toEpochMilli()
        // Limit any server-side expiry to one minute of local UI exposure.
        if (deadline <= nowMs || deadline > nowMs + 60_000L) return@runCatching null
        IncomingDeviceShare(requestId, deliveryId, sourceId, body, deadline)
    }.getOrNull()

internal enum class IncomingShareOutcome { ACCEPTED, DECLINED, BUSY, COPY_FAILED }

internal fun incomingDeviceShareResponse(requestId: String, outcome: IncomingShareOutcome): String {
    require(validNodeId(requestId))
    val result = JSONObject().put("type", "response").put("requestId", requestId)
    if (outcome == IncomingShareOutcome.BUSY || outcome == IncomingShareOutcome.COPY_FAILED) {
        val code = if (outcome == IncomingShareOutcome.BUSY) "SHARE_BUSY" else "SHARE_CLIPBOARD_FAILED"
        return result.put("ok", false).put("error", JSONObject()
            .put("code", code).put("message", "Receiving Node could not accept this share.")).toString()
    }
    return result.put("ok", true).put("result", JSONObject()
        .put("accepted", outcome == IncomingShareOutcome.ACCEPTED)).toString()
}

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

/** Recipients are metadata-only, strictly bounded and from an authenticated socket. */
internal data class ShareRecipient(
    val nodeId: String, val name: String, val platform: String,
    val status: String, val available: Boolean,
)

internal data class RecipientsReply(
    val requestId: String, val recipients: List<ShareRecipient>? = null,
    val errorCode: String? = null,
)

internal fun recipientDirectoryMessage(requestId: String): String {
    require(validNodeId(requestId))
    return JSONObject().put("type", "device.share.recipients")
        .put("requestId", requestId).toString()
}

internal fun parseRecipientsReply(raw: String): RecipientsReply? = runCatching {
    val json = JSONObject(raw)
    if (json.optString("type") != "response") return@runCatching null
    val requestId = json.getString("requestId")
    if (!validNodeId(requestId)) return@runCatching null
    when (json.get("ok")) {
        true -> {
            val result = json.getJSONObject("result")
            if (result.length() != 1 || !result.has("recipients")) return@runCatching null
            val items = result.getJSONArray("recipients")
            if (items.length() > 64) return@runCatching null
            val seen = mutableSetOf<String>()
            val recipients = (0 until items.length()).map { i ->
                val target = items.getJSONObject(i)
                if (target.length() != 5) return@runCatching null
                val id = target.getString("nodeId")
                val name = target.getString("name")
                val platform = target.getString("platform")
                val status = target.getString("status")
                val available = target.get("available") as? Boolean ?: return@runCatching null
                if (!validNodeId(id) || !seen.add(id.lowercase()) || name.isBlank() ||
                    name.length > 200 || platform.isBlank() || platform.length > 80 ||
                    status !in setOf("online", "offline", "unavailable") ||
                    (available && status != "online")) return@runCatching null
                ShareRecipient(id, name, platform, status, available)
            }
            RecipientsReply(requestId, recipients = recipients)
        }
        false -> {
            val code = json.getJSONObject("error").getString("code")
            if (!code.matches(Regex("[A-Z_]{1,80}"))) return@runCatching null
            RecipientsReply(requestId, errorCode = code)
        }
        else -> null
    }
}.getOrNull()

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
