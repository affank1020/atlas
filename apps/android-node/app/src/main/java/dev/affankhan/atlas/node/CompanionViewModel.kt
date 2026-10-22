package dev.affankhan.atlas.node

import android.app.Application
import java.util.UUID
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.WebSocket
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

internal const val MAX_SHARE_CHARACTERS = 16_384
internal const val RECIPIENT_LOOKUP_TIMEOUT_MS = 10_000L
// A little beyond the gateway's 2-second cooldown avoids boundary races.
internal const val RECIPIENT_REFRESH_COOLDOWN_MS = 2_500L

internal data class ShareDelivery(val id: Long, val text: String? = null, val error: String? = null)

internal enum class Section(val label: String) {
    DEVICES("Devices"), SEND("Send"), INBOX("Inbox"), SETTINGS("Settings")
}

/** Pure reducer: distinct share intents reset drafts, but tab navigation does not. */
internal data class CompanionSession(
    val section: Section = Section.DEVICES,
    val draft: String = "",
    val error: String? = null,
    val lastDeliveryId: Long = 0,
    val deferredShare: ShareDelivery? = null,
) {
    /** Retain the sent text while the receipt is pending. */
    fun receiveShare(delivery: ShareDelivery, sending: Boolean): CompanionSession =
        if (sending) copy(section = Section.SEND, deferredShare = delivery) else importShare(delivery)

    fun loadDeferredShare(): CompanionSession {
        val waiting = deferredShare ?: return this
        return copy(deferredShare = null).importShare(waiting)
    }

    fun importShare(delivery: ShareDelivery): CompanionSession {
        if (delivery.id <= lastDeliveryId) return this
        return copy(
            section = Section.SEND,
            draft = delivery.text.orEmpty(),
            error = delivery.error,
            lastDeliveryId = delivery.id,
            deferredShare = null,
        )
    }

    fun navigate(destination: Section): CompanionSession = copy(section = destination)
    fun editDraft(value: String): CompanionSession = copy(
        draft = value.take(MAX_SHARE_CHARACTERS),
        error = null,
    )
}

/**
 * Memory-only state: a ViewModel survives tab changes and configuration changes,
 * but never serializes clipboard/share contents to SavedState, disk, or backups.
 */
internal class CompanionViewModel(application: Application) : AndroidViewModel(application) {
    private val vault = NodeVault(application)
    private val transport = AtlasTransport()
    private val handler = Handler(Looper.getMainLooper())
    private var foreground = false
    private var connectionGeneration = 0L
    private var reconnectDelayMs = 1_000L
    private var pendingRetry: Runnable? = null
    private var socket: WebSocket? = null
    private var pendingShareRequestId: String? = null
    private val directoryLookup = RecipientLookupGate(RECIPIENT_REFRESH_COOLDOWN_MS)
    private val pendingRecipientsRequestId: String? get() = directoryLookup.pendingRequestId
    private var recipientTimeoutTask: Runnable? = null
    private var recipientCooldownTask: Runnable? = null
    var recipientsCooldown by mutableStateOf(false)
        private set
    var recipients by mutableStateOf<List<ShareRecipient>>(emptyList())
        private set
    var recipientsLoading by mutableStateOf(false)
        private set
    var recipientsError by mutableStateOf<String?>(null)
        private set
    var shareTarget by mutableStateOf("")
        private set
    var shareStatus by mutableStateOf("Nothing sent yet")
        private set
    var sharePending by mutableStateOf(false)
        private set

    var pairedNode by mutableStateOf(vault.load())
        private set
    var connectionStatus by mutableStateOf(if (pairedNode == null) "Not enrolled" else "Offline")
        private set
    var pairing by mutableStateOf(false)
        private set
    var pairingError by mutableStateOf<String?>(null)
        private set
    var recoveryNodeId by mutableStateOf(vault.pendingRecoveryId())
        private set
    var unrecoverableIdentity by mutableStateOf(vault.hasUnreadableIdentity())
        private set

    fun pair(rawOrigin: String, rawName: String, rawToken: String) {
        if (pairing || pairedNode != null || recoveryNodeId != null || unrecoverableIdentity) return
        val endpoint = try { parseAtlasEndpoint(rawOrigin) } catch (error: IllegalArgumentException) {
            pairingError = error.message ?: "Invalid Atlas server URL."
            return
        }
        val name = rawName.trim()
        val token = rawToken.trim()
        if (name.isEmpty() || name.length > 200 || token.length < 32) {
            pairingError = "Enter a device name and a valid one-time enrolment ticket."
            return
        }
        pairing = true
        pairingError = null
        viewModelScope.launch {
            try {
                // Do not suspend between issuing the one-use credential and writing
                // it to Keystore-backed storage. Finish this bounded exchange even if
                // the Activity/ViewModel is destroyed midway through enrolment.
                val node = withContext(Dispatchers.IO + NonCancellable) {
                    enrolAndPersist(
                        enrol = { transport.enrol(endpoint, token, name, BuildConfig.VERSION_NAME) },
                        rememberIssued = vault::rememberIssued,
                        persist = vault::save,
                    )
                }
                pairedNode = node
                recoveryNodeId = null
                unrecoverableIdentity = false
                connectionStatus = "Offline"
                if (foreground) connect()
            } catch (error: PairingPersistenceException) {
                recoveryNodeId = error.nodeId
                pairingError = "Atlas issued a Node credential, but Android could not save it. " +
                    "In Atlas Web → Nodes, revoke Node " + error.nodeId +
                    " before generating a new pairing ticket. Do not reuse the old ticket."
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                pairingError = "Pairing could not be confirmed. If the ticket was consumed, " +
                    "check Atlas Web → Nodes for an orphaned Android Node and revoke it before retrying."
            } finally {
                pairing = false
            }
        }
    }

    fun startConnection() {
        foreground = true
        if (pairedNode != null && socket == null) connect()
    }

    fun stopConnection() {
        foreground = false
        connectionGeneration++
        pendingRetry?.let(handler::removeCallbacks)
        pendingRetry = null
        cancelBackgroundSocket(socket)
        socket = null
        clearRecipientLookup()
        if (pendingShareRequestId != null) {
            pendingShareRequestId = null
            sharePending = false
            shareStatus = "Connection closed; delivery was not confirmed."
        }
        connectionStatus = if (pairedNode == null) "Not enrolled" else "Offline · app in background"
    }

    private fun connect() {
        val node = pairedNode ?: return
        if (!foreground || socket != null) return
        val generation = ++connectionGeneration
        connectionStatus = "Connecting"
        socket = try {
            transport.connect(node, BuildConfig.VERSION_NAME, { event ->
                handler.post {
                    if (!foreground || generation != connectionGeneration) return@post
                    when (event) {
                        ConnectionEvent.Online -> {
                            reconnectDelayMs = 1_000
                            connectionStatus = "Online"
                            refreshRecipients()
                        }
                        is ConnectionEvent.Offline -> {
                            connectionStatus = event.detail
                            clearRecipientLookup()
                            if (pendingShareRequestId != null) {
                                pendingShareRequestId = null
                                sharePending = false
                                shareStatus = "Connection lost; delivery was not confirmed."
                            }
                            // Close stale WebSockets before attempting a new connection.
                            socket?.cancel()
                            socket = null
                            scheduleRetry()
                        }
                    }
                }
            }, { reply ->
                handler.post {
                    if (!foreground || generation != connectionGeneration) return@post
                    if (reply.requestId != pendingShareRequestId) return@post
                    pendingShareRequestId = null
                    sharePending = false
                    shareStatus = when {
                        reply.errorCode != null -> when (reply.errorCode) {
                            "SHARE_DENIED" -> "This receiving Node is not approved in Atlas."
                            "SHARE_TARGET_UNAVAILABLE" -> "Receiving Node is offline or not ready."
                            "SHARE_RATE_LIMIT", "SHARE_BUSY" -> "Too many shares; try again later."
                            "NODE_TIMEOUT" -> "Recipient did not confirm the share in time."
                            "SHARE_CLIPBOARD_FAILED" -> "Mac accepted the share but could not write to its clipboard."
                            else -> "Share was not accepted by Atlas."
                        }
                        reply.accepted == true -> "Recipient accepted and copied the text."
                        else -> "Recipient declined the share."
                    }
                }
            }, { reply ->
                handler.post {
                    if (!foreground || generation != connectionGeneration ||
                        !directoryLookup.finish(reply.requestId)) return@post
                    recipientTimeoutTask?.let(handler::removeCallbacks)
                    recipientTimeoutTask = null
                    recipientsLoading = false
                    if (reply.recipients != null) {
                        recipients = reply.recipients
                        recipientsError = null
                        if (recipients.none { it.nodeId.equals(shareTarget, ignoreCase = true) && it.available })
                            shareTarget = ""
                    } else {
                        recipients = emptyList()
                        shareTarget = ""
                        recipientsError = if (reply.errorCode == "SHARE_RATE_LIMIT")
                            "Device refresh is too frequent. Try again shortly."
                        else "Approved devices could not be loaded."
                    }
                }
            })
        } catch (_: Exception) {
            connectionStatus = "Could not connect to Atlas."
            scheduleRetry()
            null
        }
    }

    private fun scheduleRetry() {
        if (!foreground || pairedNode == null || pendingRetry != null) return
        val retry = Runnable {
            pendingRetry = null
            if (foreground && socket == null && pairedNode != null) connect()
        }
        pendingRetry = retry
        handler.postDelayed(retry, reconnectDelayMs)
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(30_000)
    }

    fun loadDeferredShare() {
        if (sharePending || session.deferredShare == null) return
        session = session.loadDeferredShare()
        shareStatus = "New draft loaded. It has not been sent."
    }

    private fun clearRecipientLookup() {
        recipientTimeoutTask?.let(handler::removeCallbacks)
        recipientTimeoutTask = null
        recipientCooldownTask?.let(handler::removeCallbacks)
        recipientCooldownTask = null
        directoryLookup.reset()
        recipientsCooldown = false
        recipientsLoading = false
        recipients = emptyList()
        recipientsError = null
        shareTarget = ""
    }

    fun refreshRecipients() {
        if (!foreground || connectionStatus != "Online" || sharePending || recipientsLoading) return
        val ws = socket ?: return
        val requestId = UUID.randomUUID().toString()
        // Reject premature refresh *before* modifying a valid directory or selection.
        if (!directoryLookup.start(requestId, SystemClock.elapsedRealtime())) return
        val generation = connectionGeneration

        recipientsCooldown = true
        recipientCooldownTask?.let(handler::removeCallbacks)
        val cooldownTask = Runnable {
            if (foreground && generation == connectionGeneration) {
                recipientsCooldown = false
                recipientCooldownTask = null
            }
        }
        recipientCooldownTask = cooldownTask
        handler.postDelayed(cooldownTask, RECIPIENT_REFRESH_COOLDOWN_MS)

        recipientsLoading = true
        recipientsError = null
        recipients = emptyList()
        shareTarget = ""

        recipientTimeoutTask?.let(handler::removeCallbacks)
        val timeoutTask = Runnable {
            // Ignore a late timer from an earlier socket or a completed request.
            if (!foreground || generation != connectionGeneration ||
                !directoryLookup.finish(requestId)) return@Runnable
            recipientTimeoutTask = null
            recipientsLoading = false
            recipients = emptyList()
            shareTarget = ""
            recipientsError = "Approved device lookup timed out. Refresh devices to try again."
        }
        recipientTimeoutTask = timeoutTask
        handler.postDelayed(timeoutTask, RECIPIENT_LOOKUP_TIMEOUT_MS)

        if (!ws.send(recipientDirectoryMessage(requestId))) {
            directoryLookup.finish(requestId)
            handler.removeCallbacks(timeoutTask)
            recipientTimeoutTask = null
            recipientsLoading = false
            recipientsError = "Approved devices could not be loaded."
        }
    }

    fun selectRecipient(nodeId: String) {
        if (!sharePending && !recipientsLoading && recipientsError == null &&
            recipients.any { it.nodeId.equals(nodeId, ignoreCase = true) && it.available }) {
            shareTarget = nodeId
        }
    }

    fun sendCurrentDraft() {
        val target = shareTarget.trim()
        val text = session.draft
        val ws = socket
        if (!foreground || connectionStatus != "Online" || pairedNode == null ||
            pendingShareRequestId != null || pendingRecipientsRequestId != null ||
            recipientsLoading || recipientsError != null ||
            recipients.none { it.nodeId.equals(target, ignoreCase = true) && it.available } ||
            !validNodeId(target) || text.isBlank() ||
            text.length > MAX_SHARE_CHARACTERS || target.equals(pairedNode?.nodeId, ignoreCase = true)) {
            shareStatus = "Connect and choose an available approved receiving device."
            return
        }
        val requestId = UUID.randomUUID().toString()
        val deliveryId = UUID.randomUUID().toString()
        val payload = shareMessage(requestId, deliveryId, target, text)
        pendingShareRequestId = requestId
        sharePending = true
        shareStatus = "Waiting for the receiving Node's approval…"
        if (ws?.send(payload) != true) {
            pendingShareRequestId = null
            sharePending = false
            shareStatus = "Could not send; delivery was not confirmed."
        }
    }

    fun forget() {
        val wasForeground = foreground
        stopConnection()
        vault.clear()
        pairedNode = null
        pairingError = null
        unrecoverableIdentity = false
        connectionStatus = "Not enrolled"
        shareTarget = ""
        clearRecipientLookup()
        sharePending = false
        shareStatus = "Nothing sent yet"
        // Forgetting while the Activity is open must not prevent a new pair
        // from opening its socket immediately after enrolment.
        foreground = wasForeground
    }

    fun clearRecoveryNotice() {
        // User explicitly acknowledged revoking the old server credential.
        if (unrecoverableIdentity) vault.clear()
        vault.clearRecoveryNotice()
        recoveryNodeId = null
        unrecoverableIdentity = false
    }

    override fun onCleared() {
        stopConnection()
        transport.close()
        super.onCleared()
    }

    var session by mutableStateOf(CompanionSession())
        private set

    fun navigate(destination: Section) { session = session.navigate(destination) }
    fun editDraft(value: String) {
        session = session.editDraft(value)
        if (!sharePending) shareStatus = "Nothing sent yet"
    }

    fun receive(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND || intent.type != "text/plain") return
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
        val nextId = maxOf(session.lastDeliveryId, session.deferredShare?.id ?: 0) + 1
        val delivery = when {
            text.isBlank() -> ShareDelivery(nextId, error = "The shared item did not contain text.")
            text.length > MAX_SHARE_CHARACTERS -> ShareDelivery(
                nextId, error = "This text exceeds the 16,384-character draft limit.",
            )
            else -> ShareDelivery(nextId, text = text)
        }
        session = session.receiveShare(delivery, sending = sharePending)
        if (!sharePending) shareStatus = "Nothing sent yet"
    }
}
