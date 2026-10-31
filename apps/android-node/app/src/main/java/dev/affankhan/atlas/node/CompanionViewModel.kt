package dev.affankhan.atlas.node

import android.app.Application
import java.util.UUID
import android.content.Intent
import android.net.Uri
import android.graphics.BitmapFactory
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

internal data class ShareDelivery(
    val id: Long,
    val text: String? = null,
    val error: String? = null,
    val image: SharedImageDraft? = null,
    val importingImage: Boolean = false,
)

internal enum class Section(val label: String) {
    DEVICES("Devices"), SEND("Send"), INBOX("Inbox"), SETTINGS("Settings")
}

/** Pure reducer: distinct share intents reset drafts, but tab navigation does not. */
internal data class CompanionSession(
    val section: Section = Section.DEVICES,
    val draft: String = "",
    val image: SharedImageDraft? = null,
    val importingImage: Boolean = false,
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
            image = delivery.image,
            importingImage = delivery.importingImage,
            error = delivery.error,
            lastDeliveryId = delivery.id,
            deferredShare = null,
        )
    }

    /** Only an unfinished image placeholder can be completed. Editing the
     * active draft must not invalidate a separate deferred import, and a
     * completed/edited draft must never be resurrected by a late provider read.
     */
    fun completeImageImport(delivery: ShareDelivery): CompanionSession = when {
        deferredShare?.id == delivery.id && deferredShare.importingImage ->
            copy(deferredShare = delivery)
        lastDeliveryId == delivery.id && importingImage ->
            copy(image = delivery.image, error = delivery.error, importingImage = false)
        else -> this
    }

    fun navigate(destination: Section): CompanionSession = copy(section = destination)
    fun editDraft(value: String): CompanionSession = copy(
        draft = value.take(MAX_SHARE_CHARACTERS),
        image = null,
        importingImage = false,
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
    private var owners = ConnectionOwners()
    var pushEnabled by mutableStateOf(AtlasPush.enabled(application))
        private set
    var backgroundReceivingRunning by mutableStateOf(false)
        private set
    var backgroundReceiveError by mutableStateOf<String?>(null)
        private set

    fun reportBackgroundError(message: String?) {
        backgroundReceiveError = message
    }
    private var importSequence = 0L
    private var connectionGeneration = 0L
    private var reconnectDelayMs = 1_000L
    private var pendingRetry: Runnable? = null
    private var socket: WebSocket? = null
    private data class PendingPushCommand(
        val requestId: String, val register: Boolean, val token: String?,
    )
    private val pushRetryPolicy = PushRetryPolicy()
    private var pendingPush: PendingPushCommand? = null
    private var pushTimeoutTask: Runnable? = null
    private var pushRetryTask: Runnable? = null
    private var pushToken: String? = null
    var pushRegistrationStatus by mutableStateOf(
        if (pushEnabled) "Push registration pending connection." else "Push disabled."
    )
        private set
    private val recentIncoming = RecentIncomingShares()
    private var pendingIncomingResponse: ((IncomingShareOutcome) -> Unit)? = null
    private var incomingTimeoutTask: Runnable? = null
    private var incomingDeadlineElapsedMs = 0L
    var incomingShare by mutableStateOf<IncomingDeviceShare?>(null)
        private set
    var inboxStatus by mutableStateOf("No incoming shares yet.")
        private set
    var queuedInboxItems by mutableStateOf<List<PendingInboxItem>>(emptyList())
        private set
    var queuedInboxPreview by mutableStateOf<InboxReply.Content?>(null)
        private set
    var queuedInboxBusy by mutableStateOf(false)
        private set
    private var inboxPendingRequestId: String? = null
    private var inboxPendingAction: String? = null
    private var inboxPendingDeliveryId: String? = null
    private var inboxTimeoutTask: Runnable? = null
    private var lastInboxCommandAt = 0L
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
                if (owners.connected) connect()
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

    /** Explicit user intent takes priority over a pending earlier request.
     * The gateway applies the sent commands in order; stale replies are ignored. */
    fun updatePushConsent(enabled: Boolean) {
        cancelPushTimers()
        pendingPush = null
        pushRetryPolicy.reset()
        AtlasPush.setEnabled(getApplication(), enabled)
        pushEnabled = enabled
        if (!enabled) sendPushUnregister() else refreshPushRegistration()
    }

    fun onPushTokenChanged(token: String) {
        if (!pushEnabled || !AtlasPush.enabled(getApplication())) return
        if (pushToken != token) {
            pushToken = token
            pushRetryPolicy.reset()
        }
        sendPushRegister(token)
    }

    private fun refreshPushRegistration() {
        if (!AtlasPush.configured(getApplication())) {
            pushRegistrationStatus = "Firebase is not configured in this APK. Manual Inbox remains available."
            return
        }
        AtlasPush.currentToken(getApplication()) { token ->
            handler.post { onPushTokenChanged(token) }
        }
    }

    private fun cancelPushTimers() {
        pushRetryTask?.let(handler::removeCallbacks)
        pushRetryTask = null
        pushTimeoutTask?.let(handler::removeCallbacks)
        pushTimeoutTask = null
    }

    private fun sendPushRegister(token: String) {
        if (!pushEnabled || !AtlasPush.enabled(getApplication())) return
        sendPushCommand(register = true, token = token)
    }

    private fun sendPushUnregister() {
        sendPushCommand(register = false, token = null)
    }

    private fun sendPushCommand(register: Boolean, token: String?) {
        cancelPushTimers()
        val ws = socket
        if (ws == null || connectionStatus != "Online") {
            pushRegistrationStatus = if (register)
                "Push registration pending connection."
            else "Notifications disabled locally; server token removal pending reconnect."
            return
        }
        val requestId = UUID.randomUUID().toString()
        val command = PendingPushCommand(requestId, register, token)
        pendingPush = command
        pushRegistrationStatus = if (register)
            "Registering push notifications…" else "Removing push registration…"
        val generation = connectionGeneration
        val timeout = Runnable {
            if (generation == connectionGeneration && pendingPush?.requestId == requestId) {
                pendingPush = null
                pushTimeoutTask = null
                schedulePushRetry(command, "SHARE_UNAVAILABLE", generation)
            }
        }
        pushTimeoutTask = timeout
        handler.postDelayed(timeout, 12_000L)
        val payload = if (register) AtlasPush.registerRequest(requestId, requireNotNull(token))
            else AtlasPush.unregisterRequest(requestId)
        if (!ws.send(payload)) {
            handler.removeCallbacks(timeout)
            pushTimeoutTask = null
            pendingPush = null
            schedulePushRetry(command, "SHARE_UNAVAILABLE", generation)
        }
    }

    private fun onPushReply(reply: PushRegistrationReply, generation: Long) {
        if (generation != connectionGeneration) return
        val command = pendingPush ?: return
        if (command.requestId != reply.requestId) return
        pushTimeoutTask?.let(handler::removeCallbacks)
        pushTimeoutTask = null
        pendingPush = null
        if (reply.errorCode == null && reply.registered == command.register) {
            pushRetryPolicy.reset()
            pushRegistrationStatus = if (command.register)
                "Push registered. Delivery is best effort."
            else "Push disabled; server token removed."
        } else {
            schedulePushRetry(command, reply.errorCode ?: "SHARE_UNAVAILABLE", generation)
        }
    }

    private fun schedulePushRetry(command: PendingPushCommand, errorCode: String, generation: Long) {
        if (command.register != pushEnabled || generation != connectionGeneration) return
        val delay = pushRetryPolicy.nextDelay(errorCode)
        if (delay == null) {
            pushRegistrationStatus = if (errorCode in setOf(
                    "SHARE_DENIED", "NODE_AUTH_INVALID", "INVALID_REQUEST", "NODE_DISCONNECTED", "SHARE_REPLAY"))
                "Push request rejected ($errorCode). Check Atlas Server permissions/configuration."
            else "Push request not confirmed after retries. Reopen Settings to try again."
            return
        }
        pushRegistrationStatus = if (command.register)
            "Push registration unavailable ($errorCode); retrying…"
        else "Push opt-out awaiting server confirmation ($errorCode); retrying…"
        val task = Runnable {
            if (generation == connectionGeneration && command.register == pushEnabled) {
                pushRetryTask = null
                if (command.register) sendPushRegister(pushToken ?: command.token ?: return@Runnable)
                else sendPushUnregister()
            }
        }
        pushRetryTask = task
        handler.postDelayed(task, delay)
    }

    fun startConnection() {
        owners = owners.activityStarted()
        if (backgroundReceivingRunning &&
            !BackgroundReceiverService.hasUsableNotifications(getApplication())) {
            disableUndeliverableBackgroundReceiving()
        }
        BackgroundReceiverService.cancelIncoming(getApplication())
        if (pairedNode != null && socket == null) connect()
    }

    fun stopConnection() {
        owners = owners.activityStopped()
        // Never retain decrypted preview text when the last visible Activity
        // is backgrounded. The server remains the durable encrypted source.
        if (!owners.activityVisible) queuedInboxPreview = null
        if (owners.connected) {
            // A different Activity may still be visible. Only issue a
            // background notification once the final visible Activity stops.
            if (!owners.activityVisible && incomingShare != null) {
                val remaining = incomingDeadlineElapsedMs - SystemClock.elapsedRealtime()
                if (!BackgroundReceiverService.notifyIncoming(getApplication(), remaining)) {
                    finishIncomingShare(IncomingShareOutcome.DECLINED)
                    disableUndeliverableBackgroundReceiving()
                }
            }
            return
        }
        disconnect()
    }

    fun startBackgroundReceiving() {
        owners = owners.copy(serviceRunning = true)
        backgroundReceivingRunning = true
        backgroundReceiveError = null
        if (pairedNode != null && socket == null) connect()
    }

    fun stopBackgroundReceiving() {
        owners = owners.copy(serviceRunning = false)
        backgroundReceivingRunning = false
        if (!owners.connected) disconnect()
    }

    private fun disableUndeliverableBackgroundReceiving() {
        // Permission and channel settings can change without the foreground
        // service receiving a callback. Decline undeliverable shares, then
        // remove the service owner so Atlas cannot claim to be available.
        backgroundReceiveError =
            "Atlas notifications are blocked. Enable notifications and both Atlas channels in Android Settings."
        getApplication<Application>().stopService(Intent(
            getApplication(), BackgroundReceiverService::class.java))
        stopBackgroundReceiving()
    }

    private fun disconnect() {
        connectionGeneration++
        pendingRetry?.let(handler::removeCallbacks)
        pendingRetry = null
        clearIncomingShare(decline = true)
        cancelBackgroundSocket(socket)
        socket = null
        clearRecipientLookup()
        clearQueuedInbox()
        cancelPushTimers()
        pendingPush = null
        pushRetryPolicy.reset()
        pushRegistrationStatus = if (pushEnabled) "Push registration pending reconnect."
            else "Push disabled locally; server removal will retry after reconnect."
        if (pendingShareRequestId != null) {
            pendingShareRequestId = null
            sharePending = false
            shareStatus = "Connection closed; delivery was not confirmed."
        }
        connectionStatus = if (pairedNode == null) "Not enrolled" else "Offline · no active receiver"
    }

    private fun connect() {
        val node = pairedNode ?: return
        if (!owners.connected || socket != null) return
        val generation = ++connectionGeneration
        connectionStatus = "Connecting"
        socket = try {
            transport.connect(node, BuildConfig.VERSION_NAME, { event ->
                handler.post {
                    if (!owners.connected || generation != connectionGeneration) return@post
                    when (event) {
                        ConnectionEvent.Online -> {
                            reconnectDelayMs = 1_000
                            connectionStatus = "Online"
                            refreshRecipients()
                            if (AtlasPush.enabled(getApplication())) refreshPushRegistration()
                            else sendPushUnregister()
                            if (session.section == Section.INBOX) refreshQueuedInbox()
                        }
                        is ConnectionEvent.Offline -> {
                            connectionStatus = event.detail
                            clearRecipientLookup()
                            clearIncomingShare()
                            clearQueuedInbox()
                            cancelPushTimers()
                            pendingPush = null
                            pushRetryPolicy.reset()
                            pushRegistrationStatus = if (pushEnabled)
                                "Push registration pending reconnect."
                            else "Push disabled locally; server removal will retry after reconnect."
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
                    if (!owners.connected || generation != connectionGeneration) return@post
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
                    if (!owners.connected || generation != connectionGeneration ||
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
            }, { reply ->
                handler.post {
                    if (!owners.connected || generation != connectionGeneration ||
                        reply.requestId != inboxPendingRequestId) return@post
                    inboxTimeoutTask?.let(handler::removeCallbacks)
                    inboxTimeoutTask=null
                    inboxPendingRequestId=null
                    val action=inboxPendingAction
                    val expectedDelivery=inboxPendingDeliveryId
                    inboxPendingAction=null
                    inboxPendingDeliveryId=null
                    queuedInboxBusy=false
                    when(reply) {
                        is InboxReply.Items -> if(action=="list") {
                            queuedInboxItems=reply.items
                            queuedInboxPreview=null
                            inboxStatus=if(reply.items.isEmpty()) "No queued text." else
                                "Queued text available for review."
                        }
                        is InboxReply.Content -> if(action=="read" &&
                            reply.deliveryId==expectedDelivery &&
                            session.section==Section.INBOX &&
                            queuedInboxItems.any { it.deliveryId==reply.deliveryId &&
                                it.sourceNodeId==reply.sourceNodeId } &&
                            owners.activityVisible) {
                            queuedInboxPreview=reply
                            inboxStatus="Review and choose Copy or Decline."
                        }
                        is InboxReply.Decision -> if(action=="decide" &&
                            reply.deliveryId==expectedDelivery) {
                            queuedInboxPreview=null
                            queuedInboxItems=queuedInboxItems.filterNot { it.deliveryId==reply.deliveryId }
                            inboxStatus=if(reply.status=="user_copied")
                                "Copied on this device; Atlas receipt recorded."
                            else "Queued text declined."
                        }
                        is InboxReply.Failure -> {
                            if(action=="read") queuedInboxPreview=null
                            inboxStatus="Atlas inbox request rejected ("+reply.code+"). Refresh to retry."
                        }
                    }
                }
            }, { pushReply ->
                handler.post { onPushReply(pushReply, generation) }
            }, { incoming, respond ->
                // Capture receipt time on the socket thread so main-thread delays
                // cannot extend the 15-second decision window.
                val receivedAtElapsedMs = SystemClock.elapsedRealtime()
                handler.post {
                    if (!owners.connected || generation != connectionGeneration ||
                        connectionStatus != "Online") {
                        respond(IncomingShareOutcome.DECLINED)
                        return@post
                    }
                    if (incomingShare != null) {
                        respond(IncomingShareOutcome.BUSY)
                        return@post
                    }
                    recentIncoming.lookup(incoming)?.let { decision ->
                        respond(decision)
                        return@post
                    }
                    // The server already checked the delivery expiry. Local
                    // wall-clock offsets must not shorten/extend this approval.
                    val deadlineElapsedMs = receivedAtElapsedMs + 15_000L
                    val remaining = deadlineElapsedMs - SystemClock.elapsedRealtime()
                    if (remaining <= 0L) {
                        respond(IncomingShareOutcome.EXPIRED)
                        return@post
                    }
                    // Foreground-only, single active dialog and no implicit acceptance.
                    incomingShare = incoming
                    incomingDeadlineElapsedMs = deadlineElapsedMs
                    pendingIncomingResponse = respond
                    val expires = Runnable {
                        if (incomingShare?.requestId == incoming.requestId) {
                            finishIncomingShare(IncomingShareOutcome.DECLINED)
                        }
                    }
                    incomingTimeoutTask = expires
                    handler.postDelayed(expires, remaining)
                    if (!owners.activityVisible &&
                        !BackgroundReceiverService.notifyIncoming(getApplication(), remaining)) {
                        finishIncomingShare(IncomingShareOutcome.DECLINED)
                        disableUndeliverableBackgroundReceiving()
                    }
                }
            })
        } catch (_: Exception) {
            connectionStatus = "Could not connect to Atlas."
            scheduleRetry()
            null
        }
    }


    /** A share counts as accepted only after a human clicks Copy and Android writes it. */
    fun copyIncomingShare(copyText: (String) -> Unit) {
        val share = incomingShare ?: return
        if (!owners.canApproveClipboard || connectionStatus != "Online" ||
            SystemClock.elapsedRealtime() >= incomingDeadlineElapsedMs) {
            finishIncomingShare(IncomingShareOutcome.DECLINED)
            return
        }
        val outcome = try {
            copyText(share.text)
            IncomingShareOutcome.ACCEPTED
        } catch (_: Exception) {
            IncomingShareOutcome.COPY_FAILED
        }
        finishIncomingShare(outcome)
    }

    fun declineIncomingShare() {
        finishIncomingShare(IncomingShareOutcome.DECLINED)
    }

    private fun finishIncomingShare(outcome: IncomingShareOutcome) {
        val reply = pendingIncomingResponse ?: return
        val share = incomingShare ?: return
        recentIncoming.remember(share, outcome)
        clearIncomingShare()
        inboxStatus = when (outcome) {
            IncomingShareOutcome.ACCEPTED -> "Incoming text copied to clipboard."
            IncomingShareOutcome.DECLINED -> "Incoming text declined or expired."
            IncomingShareOutcome.COPY_FAILED -> "Could not copy incoming text."
            IncomingShareOutcome.BUSY, IncomingShareOutcome.REPLAY -> "Incoming text was not accepted."
            IncomingShareOutcome.EXPIRED -> "Incoming text expired before approval."
        }
        reply(outcome)
    }

    private fun clearIncomingShare(decline: Boolean = false) {
        incomingTimeoutTask?.let(handler::removeCallbacks)
        incomingTimeoutTask = null
        incomingDeadlineElapsedMs = 0L
        val reply = pendingIncomingResponse
        pendingIncomingResponse = null
        incomingShare = null // No inbox disk storage or retained message content.
        BackgroundReceiverService.cancelIncoming(getApplication())
        if (decline) reply?.invoke(IncomingShareOutcome.DECLINED)
    }

    private fun scheduleRetry() {
        if (!owners.connected || pairedNode == null || pendingRetry != null) return
        val retry = Runnable {
            pendingRetry = null
            if (owners.connected && socket == null && pairedNode != null) connect()
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

    /** All decrypted inbox content stays volatile; never persist in SavedState. */
    private fun clearQueuedInbox() {
        inboxTimeoutTask?.let(handler::removeCallbacks)
        inboxTimeoutTask=null
        inboxPendingRequestId=null
        inboxPendingAction=null
        inboxPendingDeliveryId=null
        queuedInboxBusy=false
        queuedInboxItems=emptyList()
        queuedInboxPreview=null
    }

    /** One bounded authenticated inbox operation at a time, rate-limited to the
     * Server's 500ms floor. No unattended polling or background clipboard writes.
     */
    private fun requestInbox(action:String, payload:(String)->String,
        deliveryId:String?=null):Boolean {
        val ws=socket ?: return false
        if (!owners.activityVisible || pairedNode==null || connectionStatus!="Online" ||
            queuedInboxBusy || SystemClock.elapsedRealtime()-lastInboxCommandAt<650L) {
            return false
        }
        val id=UUID.randomUUID().toString()
        val generation=connectionGeneration
        lastInboxCommandAt=SystemClock.elapsedRealtime()
        queuedInboxBusy=true
        inboxPendingRequestId=id
        inboxPendingAction=action
        inboxPendingDeliveryId=deliveryId
        val timeout=Runnable {
            if(generation==connectionGeneration && inboxPendingRequestId==id) {
                inboxPendingRequestId=null
                inboxPendingAction=null
                inboxPendingDeliveryId=null
                inboxTimeoutTask=null
                queuedInboxBusy=false
                queuedInboxPreview=null
                inboxStatus="Inbox request unconfirmed. Refresh before another action."
            }
        }
        inboxTimeoutTask=timeout
        handler.postDelayed(timeout,12_000L)
        if (!ws.send(payload(id))) {
            handler.removeCallbacks(timeout)
            inboxTimeoutTask=null
            inboxPendingRequestId=null
            inboxPendingAction=null
            inboxPendingDeliveryId=null
            queuedInboxBusy=false
            inboxStatus="Could not reach Atlas inbox."
            return false
        }
        return true
    }

    fun refreshQueuedInbox() {
        if (!requestInbox("list",::inboxListRequest)) {
            if (!queuedInboxBusy) inboxStatus="Reconnect or retry inbox refresh."
        } else {
            queuedInboxPreview=null
            inboxStatus="Checking queued text…"
        }
    }

    fun openQueuedInboxItem(deliveryId:String) {
        if(queuedInboxItems.none {it.deliveryId==deliveryId} || queuedInboxBusy) return
        if (requestInbox("read",{id->inboxReadRequest(id,deliveryId)},deliveryId)) {
            queuedInboxPreview=null
            inboxStatus="Loading queued text for review…"
        }
    }

    /** Clipboard changes only after a visible user's Copy tap. A network
     * failure after the write is reported as an unconfirmed server receipt;
     * never claim that the server committed the decision before replying.
     */
    fun decideQueuedInboxItem(copied:Boolean, copy:(String)->Unit) {
        val preview=queuedInboxPreview ?: return
        if(!owners.activityVisible || queuedInboxBusy || connectionStatus!="Online") return
        // The Server limits inbox operations to one per 500ms. If a user
        // presses Copy immediately after the read response, do not write to
        // clipboard before the corresponding decision can be dispatched.
        val elapsed=SystemClock.elapsedRealtime()-lastInboxCommandAt
        if(elapsed<650L) {
            queuedInboxBusy=true
            val generation=connectionGeneration
            val selectedId=preview.deliveryId
            handler.postDelayed({
                queuedInboxBusy=false
                if(generation==connectionGeneration && owners.activityVisible &&
                    queuedInboxPreview?.deliveryId==selectedId)
                    decideQueuedInboxItem(copied,copy)
            },650L-elapsed)
            return
        }
        if(copied) {
            try { copy(preview.text) } catch (_:Exception) {
                inboxStatus="Clipboard write failed. Nothing confirmed."
                return
            }
        }
        queuedInboxPreview=null
        if(requestInbox("decide",{id->inboxDecideRequest(id,preview.deliveryId,copied)},
            preview.deliveryId)) {
            inboxStatus=if(copied) "Copied locally; awaiting Atlas receipt…" else
                "Decline requested; awaiting Atlas receipt…"
        } else {
            inboxStatus=if(copied) "Copied locally; server receipt unconfirmed. Refresh inbox." else
                "Decline not confirmed. Refresh inbox."
        }
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
        if (!owners.connected || connectionStatus != "Online" || sharePending || recipientsLoading) return
        val ws = socket ?: return
        val requestId = UUID.randomUUID().toString()
        // Reject premature refresh *before* modifying a valid directory or selection.
        if (!directoryLookup.start(requestId, SystemClock.elapsedRealtime())) return
        val generation = connectionGeneration

        recipientsCooldown = true
        recipientCooldownTask?.let(handler::removeCallbacks)
        val cooldownTask = Runnable {
            if (owners.connected && generation == connectionGeneration) {
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
            if (!owners.connected || generation != connectionGeneration ||
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
        if (session.image != null) {
            shareStatus = "The image is imported locally; binary delivery is not available yet."
            return
        }
        val target = shareTarget.trim()
        val text = session.draft
        val ws = socket
        if (!owners.connected || connectionStatus != "Online" || pairedNode == null ||
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
        updatePushConsent(false)
        val visibleActivities = owners.visibleActivities
        // Stop the independently running receiver before deleting its identity.
        getApplication<AtlasNodeApp>().stopService(Intent(
            getApplication(), BackgroundReceiverService::class.java))
        owners = ConnectionOwners()
        backgroundReceivingRunning = false
        disconnect()
        vault.clear()
        pairedNode = null
        pairingError = null
        unrecoverableIdentity = false
        connectionStatus = "Not enrolled"
        shareTarget = ""
        clearRecipientLookup()
        sharePending = false
        shareStatus = "Nothing sent yet"
        inboxStatus = "No incoming shares yet."
        importSequence++
        session = CompanionSession()
        // Forgetting while the Activity is open must not prevent a new pair
        // from opening its socket immediately after enrolment.
        owners = ConnectionOwners(visibleActivities = visibleActivities)
    }

    fun clearRecoveryNotice() {
        // User explicitly acknowledged revoking the old server credential.
        if (unrecoverableIdentity) vault.clear()
        vault.clearRecoveryNotice()
        recoveryNodeId = null
        unrecoverableIdentity = false
    }

    override fun onCleared() {
        owners = ConnectionOwners()
        disconnect()
        transport.close()
        super.onCleared()
    }

    var session by mutableStateOf(CompanionSession())
        private set

    fun navigate(destination: Section) {
        if(destination!=Section.INBOX) queuedInboxPreview=null
        session = session.navigate(destination)
    }
    fun editDraft(value: String) {
        // The reducer cancels a loading *active* image. A separate deferred
        // screenshot keeps loading while the user edits the sent text draft.
        session = session.editDraft(value)
        if (!sharePending) shareStatus = "Nothing sent yet"
    }

    fun receive(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val type = intent.type ?: return
        if (type != "text/plain" && !type.startsWith("image/")) return
        val nextId = ++importSequence
        if (!sharePending) shareStatus = "Nothing sent yet"
        if (type.startsWith("image/")) {
            @Suppress("DEPRECATION")
            val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                ?: intent.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri
            if (uri?.scheme != "content") {
                session = session.receiveShare(
                    ShareDelivery(nextId, error = "The shared image must use a readable content URI."),
                    sending = sharePending,
                )
                return
            }
            session = session.receiveShare(
                ShareDelivery(nextId, error = "Opening shared image…", importingImage = true),
                sending = sharePending,
            )
            viewModelScope.launch {
                val delivery = try {
                    val image = withContext(Dispatchers.IO) {
                        // MIME/provider queries may perform I/O; keep them off the UI thread.
                        val resolver = getApplication<Application>().contentResolver
                        val providerType = runCatching { resolver.getType(uri) }.getOrNull()
                        // Some Sharesheet producers use image/* instead of the actual subtype.
                        val specificType = when {
                            type == "image/png" || type == "image/jpeg" -> type
                            type == "image/jpg" -> "image/jpeg"
                            providerType == "image/png" -> "image/png"
                            providerType == "image/jpeg" || providerType == "image/jpg" -> "image/jpeg"
                            else -> throw IllegalArgumentException("Unsupported image format.")
                        }
                        val imported = resolver.openInputStream(uri)?.use {
                            readSharedImage(it, specificType)
                        } ?: throw IllegalArgumentException("The image could not be opened.")
                        // Validate dimensions without allocating a full bitmap.
                        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        BitmapFactory.decodeByteArray(imported.bytes, 0, imported.bytes.size, bounds)
                        require(bounds.outWidth in 1..MAX_IMAGE_DIMENSION &&
                            bounds.outHeight in 1..MAX_IMAGE_DIMENSION &&
                            bounds.outWidth.toLong() * bounds.outHeight.toLong() <= 64_000_000L) {
                            "The shared image has invalid or excessive dimensions."
                        }
                        imported
                    }
                    ShareDelivery(nextId, image = image)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    ShareDelivery(nextId, error = "Could not read this image (PNG/JPEG, maximum 8 MB).")
                }
                // New Sharesheet events supersede older imports. The reducer
                // independently rejects a late completion after text edits or
                // after the pending placeholder has been replaced/loaded.
                if (nextId != importSequence) return@launch
                val completed = session.completeImageImport(delivery)
                if (completed === session) return@launch
                session = completed
                if (!sharePending && completed.lastDeliveryId == nextId) {
                    shareStatus = if (delivery.image != null)
                        "Image imported locally; sending images is not yet supported."
                    else "Image import failed; nothing was sent."
                }
            }
            return
        }
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
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
