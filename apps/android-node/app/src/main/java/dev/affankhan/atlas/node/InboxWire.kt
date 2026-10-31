package dev.affankhan.atlas.node

import org.json.JSONObject
import org.json.JSONArray
import java.time.Instant

/**
 * Android never persists inbox plaintext. The Server's bounded encrypted
 * mailbox is authoritative; the UI holds at most one decrypted item in RAM.
 * Messages only carry opaque identifiers until the user opens an item.
 */
internal data class PendingInboxItem(
    val deliveryId: String,
    val sourceNodeId: String,
    val expiresAt: String,
    val createdAt: String,
)

internal sealed interface InboxReply {
    val requestId: String
    data class Items(override val requestId: String, val items: List<PendingInboxItem>) : InboxReply
    data class Content(override val requestId: String, val deliveryId: String,
        val sourceNodeId: String, val text: String) : InboxReply
    data class Decision(override val requestId: String, val deliveryId: String,
        val status: String) : InboxReply
    data class Failure(override val requestId: String, val code: String) : InboxReply
}

internal fun inboxListRequest(requestId: String): String {
    require(validNodeId(requestId))
    return JSONObject().put("type","device.inbox.list").put("requestId",requestId).toString()
}
internal fun inboxReadRequest(requestId: String, deliveryId: String): String {
    require(validNodeId(requestId) && validNodeId(deliveryId))
    return JSONObject().put("type","device.inbox.read").put("requestId",requestId)
        .put("deliveryId",deliveryId).toString()
}
internal fun inboxDecideRequest(requestId: String, deliveryId: String, copied: Boolean): String {
    require(validNodeId(requestId) && validNodeId(deliveryId))
    return JSONObject().put("type","device.inbox.decide").put("requestId",requestId)
        .put("deliveryId",deliveryId)
        .put("decision",if(copied) "user_copied" else "declined").toString()
}

/** Parse only small, strictly shaped response envelopes; never log content. */
internal fun parseInboxReply(raw: String): InboxReply? = runCatching {
    val envelope=JSONObject(raw)
    if (envelope.optString("type") != "response" ||
        envelope.length() != 4) return@runCatching null
    val requestId=envelope.getString("requestId")
    if (!validNodeId(requestId)) return@runCatching null
    when(envelope.get("ok")) {
        false -> {
            if (!envelope.has("error")) return@runCatching null
            val error=envelope.getJSONObject("error")
            val code=error.getString("code")
            if (!code.matches(Regex("[A-Z_]{1,80}"))) return@runCatching null
            InboxReply.Failure(requestId,code)
        }
        true -> {
            val result=envelope.getJSONObject("result")
            when {
                result.has("items") && result.length()==1 -> {
                    val items=result.getJSONArray("items")
                    if (items.length()>50) return@runCatching null
                    val seen=mutableSetOf<String>()
                    val entries=(0 until items.length()).map { index ->
                        val obj=items.getJSONObject(index)
                        if(obj.length()!=4) return@runCatching null
                        val id=obj.getString("deliveryId")
                        val from=obj.getString("sourceNodeId")
                        val expires=obj.getString("expiresAt")
                        val created=obj.getString("createdAt")
                        if(!validNodeId(id) || !validNodeId(from) ||
                            !seen.add(id.lowercase()) || expires.length>64 || created.length>64)
                            return@runCatching null
                        Instant.parse(expires)
                        Instant.parse(created)
                        PendingInboxItem(id,from,expires,created)
                    }
                    InboxReply.Items(requestId,entries)
                }
                result.has("text") && result.length()==3 -> {
                    val id=result.getString("deliveryId")
                    val from=result.getString("sourceNodeId")
                    val text=result.getString("text")
                    if(!validNodeId(id) || !validNodeId(from) ||
                        text.isEmpty() || text.length>MAX_SHARE_CHARACTERS ||
                        text.toByteArray(Charsets.UTF_8).size>32_768)
                        return@runCatching null
                    InboxReply.Content(requestId,id,from,text)
                }
                result.has("status") && result.length()==2 -> {
                    val id=result.getString("deliveryId")
                    val state=result.getString("status")
                    if(!validNodeId(id) || state !in setOf("user_copied","declined"))
                        return@runCatching null
                    InboxReply.Decision(requestId,id,state)
                }
                else -> null
            }
        }
        else -> null
    }
}.getOrNull()
