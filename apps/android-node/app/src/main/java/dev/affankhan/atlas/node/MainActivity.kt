package dev.affankhan.atlas.node

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * First-stage offline UI. Deliberately does not enrol a Node or claim a delivery.
 * Incoming Android Sharesheet text is memory-only and is never logged or uploaded.
 */
class MainActivity : ComponentActivity() {
    private var incoming by mutableStateOf(ShareInput())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        incoming = readShare(intent)
        setContent { AtlasCompanion(incoming) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        incoming = readShare(intent)
    }

    private fun readShare(intent: Intent?): ShareInput {
        if (intent?.action != Intent.ACTION_SEND || intent.type != "text/plain") {
            return ShareInput()
        }
        val value = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
        if (value.isBlank()) return ShareInput(error = "The shared item did not contain text.")
        if (value.length > 16_384) {
            return ShareInput(error = "This text exceeds the 16,384-character draft limit.")
        }
        return ShareInput(text = value)
    }
}

private data class ShareInput(val text: String? = null, val error: String? = null)

private enum class Section(val label: String) {
    DEVICES("Devices"), SEND("Send"), INBOX("Inbox"), SETTINGS("Settings")
}

private val atlasScheme = darkColorScheme(
    primary = Color(0xFFB899FF),
    background = Color(0xFF101015),
    surface = Color(0xFF191920),
    onBackground = Color(0xFFF4F2F7),
    onSurface = Color(0xFFF4F2F7),
)

@Composable
private fun AtlasCompanion(incoming: ShareInput) {
    var section by rememberSaveable { mutableStateOf(Section.DEVICES) }
    LaunchedEffect(incoming) {
        if (incoming.text != null || incoming.error != null) section = Section.SEND
    }

    MaterialTheme(colorScheme = atlasScheme) {
        Surface(modifier = Modifier.fillMaxSize()) {
            BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
                if (maxWidth >= 700.dp) {
                    Row {
                        NavigationRail {
                            Section.entries.forEach { item ->
                                NavigationRailItem(
                                    selected = item == section,
                                    onClick = { section = item },
                                    icon = { Text("•") },
                                    label = { Text(item.label) },
                                )
                            }
                        }
                        CompanionContent(
                            section = section,
                            incoming = incoming,
                            modifier = Modifier.weight(1f),
                        )
                    }
                } else {
                    Column {
                        CompanionContent(
                            section = section,
                            incoming = incoming,
                            modifier = Modifier.weight(1f),
                        )
                        NavigationBar {
                            Section.entries.forEach { item ->
                                NavigationBarItem(
                                    selected = item == section,
                                    onClick = { section = item },
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
private fun CompanionContent(section: Section, incoming: ShareInput, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Text("atlas.", color = MaterialTheme.colorScheme.primary, fontSize = 28.sp)
        Text(section.label, style = MaterialTheme.typography.headlineMedium)
        when (section) {
            Section.DEVICES -> {
                InfoCard("Not enrolled", "This device has not been paired with Atlas Server.")
                InfoCard("Connection", "Offline · no Node identity or capabilities advertised yet.")
            }
            Section.SEND -> SendContent(incoming)
            Section.INBOX -> InfoCard(
                "No incoming items",
                "The receiving inbox will become available after device capability routing is implemented.",
            )
            Section.SETTINGS -> {
                InfoCard("App version", BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")")
                InfoCard("Node protocol", "Atlas Node protocol v2 — integration pending")
                InfoCard("Credentials", "None stored. Pairing and Android Keystore storage are next.")
            }
        }
    }
}

@Composable
private fun SendContent(incoming: ShareInput) {
    // Never save share content across processes, or into SavedState / Android backups.
    var draft by remember(incoming) { mutableStateOf(incoming.text.orEmpty()) }
    if (incoming.error != null) {
        InfoCard("Share not imported", incoming.error)
    }
    InfoCard("Share to Atlas", "Text and links from Android's Share menu appear here.")
    OutlinedTextField(
        value = draft,
        onValueChange = { draft = it.take(16_384) },
        label = { Text("Text or link") },
        modifier = Modifier.fillMaxWidth(),
        minLines = 3,
        maxLines = 8,
    )
    Button(onClick = {}, enabled = false) {
        Text("Send — pairing required")
    }
    Text(
        "Draft only. No content is transmitted or queued until the secure device protocol is ready.",
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
