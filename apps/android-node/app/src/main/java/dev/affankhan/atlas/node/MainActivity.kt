package dev.affankhan.atlas.node

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.result.contract.ActivityResultContracts
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.BitmapFactory
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.TextButton
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Explicit text sharing UI with an optional app-scoped background receiver. */
class MainActivity : ComponentActivity() {
    private val model: CompanionViewModel get() = (application as AtlasNodeApp).model

    private val askNotifications = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) enableBackgroundReceiving()
        else model.reportBackgroundError(
            "Notifications are required for background receiving. Permission was denied.")
    }

    private fun enableBackgroundReceiving() {
        if (model.pairedNode == null) return
        if (!BackgroundReceiverService.prepareChannels(this) ||
            !BackgroundReceiverService.hasUsableNotifications(this)) {
            model.reportBackgroundError(
                "Atlas notifications or one of its channels are disabled. Review notification settings.")
            return
        }
        try {
            startForegroundService(Intent(this, BackgroundReceiverService::class.java))
        } catch (_: RuntimeException) {
            model.reportBackgroundError("Android did not allow background receiving to start.")
        }
    }

    private fun setBackgroundReceiving(enabled: Boolean) {
        if (!enabled) {
            stopService(Intent(this, BackgroundReceiverService::class.java))
            model.stopBackgroundReceiving()
            return
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            enableBackgroundReceiving()
        }
    }

    private fun openNotificationSettings() {
        try {
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            })
        } catch (_: RuntimeException) {
            model.reportBackgroundError("Open Android Settings → Apps → Atlas Node → Notifications.")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Recreated Activities must not replay their old Sharesheet Intent onto edited drafts.
        if (savedInstanceState == null) model.receive(intent)
        setContent {
            AtlasCompanion(
                session = model.session,
                node = model.pairedNode,
                connection = model.connectionStatus,
                pairing = model.pairing,
                pairingError = model.pairingError,
                recoveryNodeId = model.recoveryNodeId,
                unreadableIdentity = model.unrecoverableIdentity,
                onClearRecovery = model::clearRecoveryNotice,
                onPair = model::pair,
                onForget = model::forget,
                onNavigate = model::navigate,
                onEditDraft = model::editDraft,
                shareTarget = model.shareTarget,
                recipients = model.recipients,
                recipientsLoading = model.recipientsLoading,
                recipientsCooldown = model.recipientsCooldown,
                recipientsError = model.recipientsError,
                onSelectRecipient = model::selectRecipient,
                onRefreshRecipients = model::refreshRecipients,
                shareStatus = model.shareStatus,
                sharePending = model.sharePending,
                onSend = model::sendCurrentDraft,
                onLoadDeferredShare = model::loadDeferredShare,
                incomingShare = model.incomingShare,
                inboxStatus = model.inboxStatus,
                queuedInboxItems = model.queuedInboxItems,
                queuedInboxLoading = model.queuedInboxLoading,
                queuedInboxBusyIds = model.queuedInboxBusyIds,
                onRefreshQueuedInbox = model::refreshQueuedInbox,
                onCopyQueued = { sourceId, deliveryId ->
                    model.decideQueuedShare(sourceId, deliveryId, true) { text ->
                        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText("Atlas queued text", text))
                    }
                },
                onDeclineQueued = { sourceId, deliveryId ->
                    model.decideQueuedShare(sourceId, deliveryId, false) { }
                },
                onCopyIncoming = {
                    model.copyIncomingShare { text ->
                        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText("Atlas shared text", text))
                    }
                },
                onDeclineIncoming = model::declineIncomingShare,
                backgroundReceiving = model.backgroundReceivingRunning,
                backgroundReceiveError = model.backgroundReceiveError,
                onToggleBackgroundReceiving = ::setBackgroundReceiving,
                onOpenNotificationSettings = ::openNotificationSettings,
            )
        }
    }

    override fun onStart() {
        super.onStart()
        model.startConnection()
    }

    override fun onStop() {
        model.stopConnection()
        super.onStop()
    }

    public override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // A distinct ACTION_SEND Intent is always a distinct event, even for identical text.
        model.receive(intent)
    }
}

private val atlasScheme = darkColorScheme(
    primary = Color(0xFFB899FF),
    background = Color(0xFF101015),
    surface = Color(0xFF191920),
    onBackground = Color(0xFFF4F2F7),
    onSurface = Color(0xFFF4F2F7),
)

@Composable
internal fun AtlasCompanion(
    session: CompanionSession,
    node: StoredNode?,
    connection: String,
    pairing: Boolean,
    pairingError: String?,
    recoveryNodeId: String?,
    unreadableIdentity: Boolean,
    onClearRecovery: () -> Unit,
    onPair: (String, String, String) -> Unit,
    onForget: () -> Unit,
    onNavigate: (Section) -> Unit,
    onEditDraft: (String) -> Unit,
    shareTarget: String,
    recipients: List<ShareRecipient>,
    recipientsLoading: Boolean,
    recipientsCooldown: Boolean,
    recipientsError: String?,
    onSelectRecipient: (String) -> Unit,
    onRefreshRecipients: () -> Unit,
    shareStatus: String,
    sharePending: Boolean,
    onSend: () -> Unit,
    onLoadDeferredShare: () -> Unit,
    incomingShare: IncomingDeviceShare? = null,
    inboxStatus: String = "No incoming shares yet.",
    queuedInboxItems: List<QueuedShareItem> = emptyList(),
    queuedInboxLoading: Boolean = false,
    queuedInboxBusyIds: Set<String> = emptySet(),
    onRefreshQueuedInbox: () -> Unit = {},
    onCopyQueued: (String, String) -> Unit = { _, _ -> },
    onDeclineQueued: (String, String) -> Unit = { _, _ -> },
    onCopyIncoming: () -> Unit = {},
    onDeclineIncoming: () -> Unit = {},
    backgroundReceiving: Boolean = false,
    backgroundReceiveError: String? = null,
    onToggleBackgroundReceiving: (Boolean) -> Unit = {},
    onOpenNotificationSettings: () -> Unit = {},
) {
    MaterialTheme(colorScheme = atlasScheme) {
        Surface(modifier = Modifier.fillMaxSize()) {
            BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
                if (maxWidth >= 700.dp) {
                    Row {
                        NavigationRail {
                            Section.entries.forEach { item ->
                                NavigationRailItem(
                                    selected = item == session.section,
                                    onClick = { onNavigate(item) },
                                    modifier = Modifier.testTag("tab-" + item.name.lowercase()),
                                    icon = { Text("•") },
                                    label = { Text(item.label) },
                                )
                            }
                        }
                        CompanionContent(
                            session = session,
                            node = node,
                            connection = connection,
                            pairing = pairing,
                            pairingError = pairingError,
                            recoveryNodeId = recoveryNodeId,
                            unreadableIdentity = unreadableIdentity,
                            onClearRecovery = onClearRecovery,
                            onPair = onPair,
                            onForget = onForget,
                            onEditDraft = onEditDraft,
                            shareTarget = shareTarget,
                            recipients = recipients,
                            recipientsLoading = recipientsLoading,
                            recipientsCooldown = recipientsCooldown,
                            recipientsError = recipientsError,
                            onSelectRecipient = onSelectRecipient,
                            onRefreshRecipients = onRefreshRecipients,
                            shareStatus = shareStatus,
                            sharePending = sharePending,
                            onSend = onSend,
                            onLoadDeferredShare = onLoadDeferredShare,
                            inboxStatus = inboxStatus,
                            queuedInboxItems = queuedInboxItems,
                            queuedInboxLoading = queuedInboxLoading,
                            queuedInboxBusyIds = queuedInboxBusyIds,
                            onRefreshQueuedInbox = onRefreshQueuedInbox,
                            onCopyQueued = onCopyQueued,
                            onDeclineQueued = onDeclineQueued,
                            backgroundReceiving = backgroundReceiving,
                            backgroundReceiveError = backgroundReceiveError,
                            onToggleBackgroundReceiving = onToggleBackgroundReceiving,
                            onOpenNotificationSettings = onOpenNotificationSettings,
                            modifier = Modifier.weight(1f),
                        )
                    }
                } else {
                    Column {
                        CompanionContent(
                            session = session,
                            node = node,
                            connection = connection,
                            pairing = pairing,
                            pairingError = pairingError,
                            recoveryNodeId = recoveryNodeId,
                            unreadableIdentity = unreadableIdentity,
                            onClearRecovery = onClearRecovery,
                            onPair = onPair,
                            onForget = onForget,
                            onEditDraft = onEditDraft,
                            shareTarget = shareTarget,
                            recipients = recipients,
                            recipientsLoading = recipientsLoading,
                            recipientsCooldown = recipientsCooldown,
                            recipientsError = recipientsError,
                            onSelectRecipient = onSelectRecipient,
                            onRefreshRecipients = onRefreshRecipients,
                            shareStatus = shareStatus,
                            sharePending = sharePending,
                            onSend = onSend,
                            onLoadDeferredShare = onLoadDeferredShare,
                            inboxStatus = inboxStatus,
                            queuedInboxItems = queuedInboxItems,
                            queuedInboxLoading = queuedInboxLoading,
                            queuedInboxBusyIds = queuedInboxBusyIds,
                            onRefreshQueuedInbox = onRefreshQueuedInbox,
                            onCopyQueued = onCopyQueued,
                            onDeclineQueued = onDeclineQueued,
                            backgroundReceiving = backgroundReceiving,
                            backgroundReceiveError = backgroundReceiveError,
                            onToggleBackgroundReceiving = onToggleBackgroundReceiving,
                            onOpenNotificationSettings = onOpenNotificationSettings,
                            modifier = Modifier.weight(1f),
                        )
                        NavigationBar {
                            Section.entries.forEach { item ->
                                NavigationBarItem(
                                    selected = item == session.section,
                                    onClick = { onNavigate(item) },
                                    modifier = Modifier.testTag("tab-" + item.name.lowercase()),
                                    icon = { Text("•") },
                                    label = { Text(item.label) },
                                )
                            }
                        }
                    }
                }
            }
            if (incomingShare != null) {
                AlertDialog(
                    onDismissRequest = onDeclineIncoming,
                    title = { Text("Atlas incoming text") },
                    text = {
                        Text("From Node " + incomingShare.sourceNodeId.take(8) +
                            "\n\n" + incomingShare.text.take(180)
                                .replace(Regex("[\\u0000-\\u001f\\u007f]"), " ") +
                            (if (incomingShare.text.length > 180) "…" else "") +
                            "\n\nCopying requires your approval. Incoming text is not saved.")
                    },
                    confirmButton = {
                        TextButton(onClick = onCopyIncoming, modifier = Modifier.testTag("incoming-copy")) {
                            Text("Copy")
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = onDeclineIncoming, modifier = Modifier.testTag("incoming-decline")) {
                            Text("Decline")
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun CompanionContent(
    session: CompanionSession,
    node: StoredNode?,
    connection: String,
    pairing: Boolean,
    pairingError: String?,
    recoveryNodeId: String?,
    unreadableIdentity: Boolean,
    onClearRecovery: () -> Unit,
    onPair: (String, String, String) -> Unit,
    onForget: () -> Unit,
    onEditDraft: (String) -> Unit,
    shareTarget: String,
    recipients: List<ShareRecipient>,
    recipientsLoading: Boolean,
    recipientsCooldown: Boolean,
    recipientsError: String?,
    onSelectRecipient: (String) -> Unit,
    onRefreshRecipients: () -> Unit,
    shareStatus: String,
    sharePending: Boolean,
    onSend: () -> Unit,
    onLoadDeferredShare: () -> Unit,
    inboxStatus: String = "No incoming shares yet.",
    queuedInboxItems: List<QueuedShareItem> = emptyList(),
    queuedInboxLoading: Boolean = false,
    queuedInboxBusyIds: Set<String> = emptySet(),
    onRefreshQueuedInbox: () -> Unit = {},
    onCopyQueued: (String) -> Unit = {},
    onDeclineQueued: (String) -> Unit = {},
    backgroundReceiving: Boolean = false,
    backgroundReceiveError: String? = null,
    onToggleBackgroundReceiving: (Boolean) -> Unit = {},
    onOpenNotificationSettings: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Text("atlas.", color = MaterialTheme.colorScheme.primary, fontSize = 28.sp)
        Text(session.section.label, style = MaterialTheme.typography.headlineMedium)
        when (session.section) {
            Section.DEVICES -> DevicePairing(
                node, connection, pairing, pairingError, recoveryNodeId,
                unreadableIdentity, onClearRecovery, onPair,
            )
            Section.SEND -> SendContent(session, node, connection, onEditDraft,
                shareTarget, recipients, recipientsLoading, recipientsCooldown, recipientsError, onSelectRecipient,
                onRefreshRecipients, shareStatus, sharePending, onSend, onLoadDeferredShare)
            Section.INBOX -> {
                InfoCard("Delivery status", inboxStatus)
                Button(onClick = onRefreshQueuedInbox,
                    enabled = node != null && connection == "Online" &&
                        !queuedInboxLoading && queuedInboxBusyIds.isEmpty(),
                    modifier = Modifier.testTag("inbox-refresh"),
                ) { Text(if (queuedInboxLoading) "Loading…" else "Refresh inbox") }
                if (queuedInboxItems.isEmpty()) {
                    Text("No queued transfers. Incoming live shares still require immediate approval.",
                        style = MaterialTheme.typography.bodySmall)
                }
                queuedInboxItems.forEach { item ->
                    Card(modifier = Modifier.fillMaxWidth()
                        .testTag("queued-inbox-" + item.sourceNodeId + "-" + item.deliveryId)) {
                        Column(modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("From Node " + item.sourceNodeId.take(8))
                            Text(item.text.take(180).replace(Regex("[\\u0000-\\u001f\\u007f]"), " ") +
                                (if (item.text.length > 180) "…" else ""))
                            Text("Expires " + java.time.Instant.ofEpochMilli(item.expiresAtMs).toString(),
                                style = MaterialTheme.typography.bodySmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Button(
                                    onClick = { onCopyQueued(item.sourceNodeId, item.deliveryId) },
                                    enabled = connection == "Online" &&
                                        (item.sourceNodeId.lowercase() + ":" + item.deliveryId.lowercase()) !in queuedInboxBusyIds,
                                    modifier = Modifier.testTag("queued-copy-" + item.sourceNodeId + "-" + item.deliveryId),
                                ) { Text("Copy") }
                                TextButton(
                                    onClick = { onDeclineQueued(item.sourceNodeId, item.deliveryId) },
                                    enabled = connection == "Online" &&
                                        item.deliveryId !in queuedInboxBusyIds,
                                    modifier = Modifier.testTag("queued-decline-" + item.sourceNodeId + "-" + item.deliveryId),
                                ) { Text("Decline") }
                            }
                        }
                    }
                }
                Text("Queued text is held encrypted on Atlas Server for up to 24 hours. " +
                    "Nothing is copied automatically. This inbox downloads content only when connected; " +
                    "notifications cannot wake a sleeping tablet yet.",
                    style = MaterialTheme.typography.bodySmall)
            }
            Section.SETTINGS -> {
                InfoCard("App version", BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")")
                InfoCard("Node protocol", "Atlas Node protocol v2 — directional text sharing")
                Text("Background receiving")
                Switch(
                    checked = backgroundReceiving,
                    onCheckedChange = onToggleBackgroundReceiving,
                    enabled = node != null,
                    modifier = Modifier.testTag("background-receiving-toggle"),
                )
                Text(
                    if (backgroundReceiving)
                        "A persistent notification keeps the Node connection active while using other apps. " +
                            "Open an incoming notification to approve Copy within 15 seconds."
                    else "Off. Turn on to receive while using other apps. " +
                        "Screen-off delivery is not guaranteed; there is no offline inbox or push yet.",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (backgroundReceiveError != null) {
                    InfoCard("Background receiving unavailable", backgroundReceiveError)
                    Button(
                        onClick = onOpenNotificationSettings,
                        modifier = Modifier.testTag("open-notification-settings"),
                    ) { Text("Open notification settings") }
                }
                if (node != null) {
                    InfoCard("Credentials", "Node credentials are encrypted using Android Keystore.")
                    Button(onClick = onForget) { Text("Forget this Node on device") }
                    Text("This only deletes local credentials. Revoke the Node separately in Atlas Web.",
                        style = MaterialTheme.typography.bodySmall)
                } else {
                    InfoCard("Credentials", "No Node identity stored on this device.")
                }
            }
        }
    }
}

@Composable
private fun SendContent(
    session: CompanionSession,
    node: StoredNode?,
    connection: String,
    onEditDraft: (String) -> Unit,
    shareTarget: String,
    recipients: List<ShareRecipient>,
    recipientsLoading: Boolean,
    recipientsCooldown: Boolean,
    recipientsError: String?,
    onSelectRecipient: (String) -> Unit,
    onRefreshRecipients: () -> Unit,
    shareStatus: String,
    sharePending: Boolean,
    onSend: () -> Unit,
    onLoadDeferredShare: () -> Unit,
) {
    if (session.deferredShare != null) {
        InfoCard("Another share is waiting",
            "The latest incoming item is held until the current share is resolved. The draft below is still the one being sent.")
        Button(onClick = onLoadDeferredShare, enabled = !sharePending,
            modifier = Modifier.testTag("load-next-share")) { Text("Load newest shared item") }
    }
    if (session.error != null) InfoCard(
        if (session.error == "Opening shared image…") "Importing image" else "Share not imported",
        session.error,
    )
    if (session.image != null) {
        val image = session.image
        val thumbnail = remember(image) { thumbnailForShare(image.bytes) }
        InfoCard("Image imported", image.mimeType + " · " + (image.sizeBytes / 1024) +
            " KiB. Image delivery is not enabled yet; this image has NOT been sent.")
        if (thumbnail != null) {
            Image(
                bitmap = thumbnail,
                contentDescription = "Preview of shared image",
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxWidth().heightIn(max = 240.dp)
                    .testTag("shared-image-preview"),
            )
        }
        Text("Editing the text below will discard this temporary image. Atlas does not save image drafts.")
    }
    InfoCard("Share to Atlas", "Text, links and PNG/JPEG screenshots from Android's Share menu appear here.")
    OutlinedTextField(
        value = session.draft,
        onValueChange = onEditDraft,
        enabled = !sharePending,
        label = { Text("Text or link") },
        modifier = Modifier.fillMaxWidth().testTag("share-draft"),
        minLines = 3,
        maxLines = 8,
    )
    Text("Approved receiving devices", style = MaterialTheme.typography.titleMedium)
    Button(
        onClick = onRefreshRecipients,
        enabled = node != null && connection == "Online" && !sharePending &&
            !recipientsLoading && !recipientsCooldown,
        modifier = Modifier.testTag("refresh-recipients"),
    ) { Text(if (recipientsLoading) "Refreshing…" else if (recipientsCooldown) "Refresh available shortly" else "Refresh devices") }
    when {
        node == null || connection != "Online" -> Text("Connect to Atlas to discover approved devices.")
        recipientsLoading -> Text("Loading approved devices…")
        recipientsError != null -> Text(recipientsError, modifier = Modifier.testTag("recipients-error"))
        recipients.isEmpty() -> Text("No approved receiving devices. Grant access in Atlas Web → Nodes.")
        else -> recipients.forEach { recipient ->
            val selected = shareTarget.equals(recipient.nodeId, ignoreCase = true)
            Button(
                onClick = { onSelectRecipient(recipient.nodeId) },
                enabled = !sharePending && recipient.available,
                modifier = Modifier.fillMaxWidth().testTag("recipient-" + recipient.nodeId),
            ) {
                Text((if (selected) "✓ " else "") + recipient.name + " · " + recipient.platform +
                    " · " + if (recipient.available) "Ready" else "Offline or receiving disabled")
            }
        }
    }
    Button(
        onClick = onSend,
        enabled = node != null && connection == "Online" &&
            !recipientsLoading && recipientsError == null &&
            recipients.any { it.available && it.nodeId.equals(shareTarget, ignoreCase = true) } &&
            validNodeId(shareTarget) && !shareTarget.equals(node.nodeId, ignoreCase = true) &&
            session.image == null && session.draft.isNotBlank() && !sharePending,
        modifier = Modifier.testTag("share-submit"),
    ) { Text(if (sharePending) "Waiting for approval…" else "Send to selected Node") }
    InfoCard("Delivery status", shareStatus)
    Text(
        "Only recipients approved for this Android Node appear above. Select a ready device and confirm Send; the recipient must still accept the share. The list is refreshed on connection and on request.",
        style = MaterialTheme.typography.bodySmall,
    )
}

@Composable
private fun InfoCard(title: String, details: String) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(details, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun DevicePairing(
    node: StoredNode?,
    connection: String,
    pairing: Boolean,
    pairingError: String?,
    recoveryNodeId: String?,
    unreadableIdentity: Boolean,
    onClearRecovery: () -> Unit,
    onPair: (String, String, String) -> Unit,
) {
    if (node != null) {
        InfoCard("Paired Node", node.name + " · " + node.nodeId)
        InfoCard("Connection", connection)
        InfoCard("Capabilities", "Text sending and opt-in background text receiving. Every incoming share requires explicit Copy approval.")
        return
    }
    InfoCard("Not enrolled", "Create a one-time Node enrolment ticket in Atlas Web, then enter it here.")
    if (unreadableIdentity) {
        InfoCard("Previous pairing cannot be opened",
            "Android cannot decrypt a previously stored Node credential. Revoke that Android Node in Atlas Web before pairing again.")
    }
    if (recoveryNodeId != null) {
        InfoCard("Unfinished pairing",
            "Atlas issued credentials for Node " + recoveryNodeId +
            ". Revoke this Node in Atlas Web → Nodes before retrying.")
    }
    // Enrolment ticket is memory-only and is discarded when this form leaves composition.
    if (recoveryNodeId != null || unreadableIdentity) {
        Button(onClick = onClearRecovery) { Text("I revoked the previous Node") }
    }
    var server by remember { mutableStateOf("https://atlas.affankhan.dev") }
    var deviceName by remember { mutableStateOf("Android Node") }
    var ticket by remember { mutableStateOf("") }
    OutlinedTextField(
        value = server, onValueChange = { server = it.take(400) },
        label = { Text("Atlas server HTTPS address") },
        modifier = Modifier.fillMaxWidth().testTag("pair-server"),
        singleLine = true,
    )
    OutlinedTextField(
        value = deviceName, onValueChange = { deviceName = it.take(200) },
        label = { Text("Device name") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    OutlinedTextField(
        value = ticket, onValueChange = { ticket = it.take(256) },
        label = { Text("One-time pairing ticket") },
        modifier = Modifier.fillMaxWidth().testTag("pair-ticket"),
        visualTransformation = PasswordVisualTransformation(),
        singleLine = true,
    )
    Button(onClick = { onPair(server, deviceName, ticket); ticket = "" },
        enabled = !pairing && ticket.isNotBlank() && deviceName.isNotBlank() &&
            recoveryNodeId == null && !unreadableIdentity) {
        Text(if (pairing) "Pairing…" else "Pair with Atlas")
    }
    if (pairingError != null) InfoCard("Pairing failed", pairingError)
    Text("Requires valid HTTPS/WSS. The pairing ticket is never saved; the issued Node credential is protected using Android Keystore.",
        style = MaterialTheme.typography.bodySmall)
}


// Decode a *sampled* preview only: never allocate a full-resolution bitmap
// for an untrusted image provider. The full original stays in volatile memory.
private fun thumbnailForShare(bytes: ByteArray): ImageBitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0 ||
        bounds.outWidth > MAX_IMAGE_DIMENSION || bounds.outHeight > MAX_IMAGE_DIMENSION ||
        bounds.outWidth.toLong() * bounds.outHeight.toLong() > 64_000_000L) {
        return@runCatching null
    }
    var sample = 1
    while (bounds.outWidth / sample > 1024 || bounds.outHeight / sample > 1024) sample *= 2
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size,
        BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}.getOrNull()
