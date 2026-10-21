package dev.affankhan.atlas.node

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** No Node pairing or data transmission in this initial app foundation. */
class MainActivity : ComponentActivity() {
    private val model: CompanionViewModel by viewModels()

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
                onEditShareTarget = model::editShareTarget,
                shareStatus = model.shareStatus,
                sharePending = model.shareStatus.startsWith("Waiting for"),
                onSend = model::sendCurrentDraft,
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
    onEditShareTarget: (String) -> Unit,
    shareStatus: String,
    sharePending: Boolean,
    onSend: () -> Unit,
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
                            onEditShareTarget = onEditShareTarget,
                            shareStatus = shareStatus,
                            sharePending = sharePending,
                            onSend = onSend,
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
                            onEditShareTarget = onEditShareTarget,
                            shareStatus = shareStatus,
                            sharePending = sharePending,
                            onSend = onSend,
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
    onEditShareTarget: (String) -> Unit,
    shareStatus: String,
    sharePending: Boolean,
    onSend: () -> Unit,
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
                shareTarget, onEditShareTarget, shareStatus, sharePending, onSend)
            Section.INBOX -> InfoCard(
                "No incoming items",
                "The receiving inbox will become available after device capability routing is implemented.",
            )
            Section.SETTINGS -> {
                InfoCard("App version", BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")")
                InfoCard("Node protocol", "Atlas Node protocol v2 — outbound text sharing")
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
    onEditShareTarget: (String) -> Unit,
    shareStatus: String,
    sharePending: Boolean,
    onSend: () -> Unit,
) {
    if (session.error != null) InfoCard("Share not imported", session.error)
    InfoCard("Share to Atlas", "Text and links from Android's Share menu appear here.")
    OutlinedTextField(
        value = session.draft,
        onValueChange = onEditDraft,
        label = { Text("Text or link") },
        modifier = Modifier.fillMaxWidth().testTag("share-draft"),
        minLines = 3,
        maxLines = 8,
    )
    OutlinedTextField(
        value = shareTarget,
        onValueChange = onEditShareTarget,
        label = { Text("Receiving Node ID") },
        modifier = Modifier.fillMaxWidth().testTag("share-target"),
        singleLine = true,
    )
    Button(
        onClick = onSend,
        enabled = node != null && connection == "Online" &&
            validNodeId(shareTarget) && !shareTarget.equals(node.nodeId, ignoreCase = true) &&
            session.draft.isNotBlank() && !sharePending,
        modifier = Modifier.testTag("share-submit"),
    ) { Text(if (sharePending) "Waiting for approval…" else "Send to selected Node") }
    InfoCard("Delivery status", shareStatus)
    Text(
        "The recipient must be approved in Atlas Server and online. No share is delivered until the receiving user accepts it. Target selection is manual in this first version.",
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
        InfoCard("Capabilities", "Outbound text sharing. Recipient approval is required.")
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
