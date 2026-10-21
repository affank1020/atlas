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
                onNavigate = model::navigate,
                onEditDraft = model::editDraft,
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
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
private fun AtlasCompanion(
    session: CompanionSession,
    onNavigate: (Section) -> Unit,
    onEditDraft: (String) -> Unit,
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
                            onEditDraft = onEditDraft,
                            modifier = Modifier.weight(1f),
                        )
                    }
                } else {
                    Column {
                        CompanionContent(
                            session = session,
                            onEditDraft = onEditDraft,
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
    onEditDraft: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Text("atlas.", color = MaterialTheme.colorScheme.primary, fontSize = 28.sp)
        Text(session.section.label, style = MaterialTheme.typography.headlineMedium)
        when (session.section) {
            Section.DEVICES -> {
                InfoCard("Not enrolled", "This device has not been paired with Atlas Server.")
                InfoCard("Connection", "Offline · no Node identity or capabilities advertised yet.")
            }
            Section.SEND -> SendContent(session, onEditDraft)
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
private fun SendContent(session: CompanionSession, onEditDraft: (String) -> Unit) {
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
