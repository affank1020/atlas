package dev.affankhan.atlas.node

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
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

    private fun mount() {
        compose.setContent {
            AtlasCompanion(
                session = state,
                node = null,
                connection = "Not enrolled",
                pairing = false,
                pairingError = null,
                recoveryNodeId = null,
                unreadableIdentity = false,
                onClearRecovery = {},
                onPair = { _, _, _ -> },
                onForget = {},
                onNavigate = { state = state.navigate(it) },
                onEditDraft = { state = state.editDraft(it) },
                shareTarget = "",
                onEditShareTarget = {},
                shareStatus = "Nothing sent yet",
                sharePending = false,
                onSend = {},
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

    @Test fun leavingSendAndReturningRetainsDraft() {
        mount()
        compose.onNodeWithTag("tab-send").performClick()
        compose.onNodeWithTag("share-draft").performTextReplacement("local draft")
        compose.onNodeWithTag("tab-settings").performClick()
        compose.onNodeWithTag("tab-send").performClick()
        compose.onNodeWithTag("share-draft").assertTextContains("local draft")
    }
}
