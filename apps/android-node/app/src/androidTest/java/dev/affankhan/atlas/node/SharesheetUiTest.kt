package dev.affankhan.atlas.node

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Rule
import org.junit.Test

/**
 * Compose host is isolated from ActivityScenario: repeated share delivery is
 * tested as two distinct reducer events, without spawning or hijacking Activities.
 */
class SharesheetUiTest {
    @get:Rule val compose = createComposeRule()
    private var state by mutableStateOf(CompanionSession())
    private var selected by mutableStateOf("")
    private val senderNode = StoredNode("https://atlas.example.com",
        "123e4567-e89b-42d3-a456-426614174000", "a".repeat(43), "Samsung")
    private val mac = ShareRecipient("123e4567-e89b-42d3-a456-426614174002", "MacBook", "darwin", "online", true)
    private val offline = ShareRecipient("123e4567-e89b-42d3-a456-426614174003", "Offline Mac", "darwin", "offline", false)

    private fun mount(ready: Boolean = false) {
        compose.setContent {
            AtlasCompanion(
                session = state,
                node = if (ready) senderNode else null,
                connection = if (ready) "Online" else "Not enrolled",
                pairing = false,
                pairingError = null,
                recoveryNodeId = null,
                unreadableIdentity = false,
                onClearRecovery = {},
                onPair = { _, _, _ -> },
                onForget = {},
                onNavigate = { state = state.navigate(it) },
                onEditDraft = { state = state.editDraft(it) },
                shareTarget = selected,
                recipients = if (ready) listOf(mac, offline) else emptyList(),
                recipientsLoading = false,
                recipientsError = null,
                onSelectRecipient = { selected = it },
                onRefreshRecipients = {},
                shareStatus = "Nothing sent yet",
                sharePending = false,
                onSend = {},
                onLoadDeferredShare = { state = state.loadDeferredShare() },
            )
        }
    }

    @Test fun identicalShareOpensSendAgainAndOverwritesOldDraft() {
        mount()
        compose.runOnIdle { state = state.importShare(ShareDelivery(1, "https://example.com")) }
        compose.onNodeWithTag("share-draft").performTextReplacement("edited")
        compose.onNodeWithTag("tab-devices").performClick()
        compose.runOnIdle { state = state.importShare(ShareDelivery(2, "https://example.com")) }
        compose.onNodeWithTag("share-draft").assertTextContains("https://example.com")
    }

    @Test fun nextShareRemainsSeparateFromPreviousDeliveryStatus() {
        mount()
        compose.runOnIdle { state = state.receiveShare(ShareDelivery(1, "A submitted"), sending = false) }
        compose.onNodeWithTag("share-draft").assertTextContains("A submitted")
        compose.runOnIdle { state = state.receiveShare(ShareDelivery(2, "B arrived"), sending = true) }
        compose.onNodeWithTag("share-draft").assertTextContains("A submitted")
        compose.onNodeWithTag("load-next-share").performClick()
        compose.onNodeWithTag("share-draft").assertTextContains("B arrived")
    }

    @Test fun pickerShowsApprovedNamesDisablesOfflineAndRequiresSelection() {
        mount(ready = true)
        compose.runOnIdle { state = state.navigate(Section.SEND).editDraft("Send after selecting a recipient") }
        compose.onNodeWithTag("share-submit").assertIsNotEnabled()
        compose.onNodeWithTag("recipient-" + offline.nodeId).assertIsNotEnabled()
        compose.onNodeWithTag("recipient-" + mac.nodeId).performScrollTo().assertIsEnabled().performClick()
        compose.onNodeWithTag("share-submit").performScrollTo().assertIsEnabled()
    }

    @Test fun leavingSendAndReturningRetainsDraft() {
        mount()
        compose.onNodeWithTag("tab-send").performClick()
        compose.onNodeWithTag("share-draft").performTextReplacement("local draft")
        compose.onNodeWithTag("tab-settings").performClick()
        compose.onNodeWithTag("tab-send").performClick()
        compose.onNodeWithTag("share-draft").assertTextContains("local draft")
    }
}
