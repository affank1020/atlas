package dev.affankhan.atlas.node

import android.app.Application
import android.content.Intent
import android.os.Handler
import android.os.Looper
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
) {
    fun importShare(delivery: ShareDelivery): CompanionSession {
        if (delivery.id <= lastDeliveryId) return this
        return copy(
            section = Section.SEND,
            draft = delivery.text.orEmpty(),
            error = delivery.error,
            lastDeliveryId = delivery.id,
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
        connectionStatus = if (pairedNode == null) "Not enrolled" else "Offline · app in background"
    }

    private fun connect() {
        val node = pairedNode ?: return
        if (!foreground || socket != null) return
        val generation = ++connectionGeneration
        connectionStatus = "Connecting"
        socket = try {
            transport.connect(node, BuildConfig.VERSION_NAME) { event ->
                handler.post {
                    if (!foreground || generation != connectionGeneration) return@post
                    when (event) {
                        ConnectionEvent.Online -> {
                            reconnectDelayMs = 1_000
                            connectionStatus = "Online"
                        }
                        is ConnectionEvent.Offline -> {
                            connectionStatus = event.detail
                            // Close stale WebSockets before attempting a new connection.
                            socket?.cancel()
                            socket = null
                            scheduleRetry()
                        }
                    }
                }
            }
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

    fun forget() {
        val wasForeground = foreground
        stopConnection()
        vault.clear()
        pairedNode = null
        pairingError = null
        unrecoverableIdentity = false
        connectionStatus = "Not enrolled"
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
    fun editDraft(value: String) { session = session.editDraft(value) }

    fun receive(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND || intent.type != "text/plain") return
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
        val nextId = session.lastDeliveryId + 1
        val delivery = when {
            text.isBlank() -> ShareDelivery(nextId, error = "The shared item did not contain text.")
            text.length > MAX_SHARE_CHARACTERS -> ShareDelivery(
                nextId, error = "This text exceeds the 16,384-character draft limit.",
            )
            else -> ShareDelivery(nextId, text = text)
        }
        session = session.importShare(delivery)
    }
}
