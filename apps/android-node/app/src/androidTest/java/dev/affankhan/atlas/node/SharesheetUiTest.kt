package dev.affankhan.atlas.node

import android.graphics.Bitmap
import java.io.ByteArrayOutputStream
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
    private var refreshCooldown by mutableStateOf(false)
    private var backgroundRunning by mutableStateOf(false)
    private var backgroundError by mutableStateOf<String?>(null)
    private var notificationSettingsOpened = false
    private var incoming by mutableStateOf<IncomingDeviceShare?>(null)
    private var inboxItems by mutableStateOf<List<PendingInboxItem>>(emptyList())
    private var inboxPreview by mutableStateOf<InboxReply.Content?>(null)
    private var inboxRefreshed = false
    private var inboxReviewed = false
    private var inboxCopied = false
    private var inboxDeclined = false
    private var copied = false
    private var declined = false
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
                recipientsCooldown = refreshCooldown,
                recipientsError = null,
                onSelectRecipient = { selected = it },
                onRefreshRecipients = {},
                shareStatus = "Nothing sent yet",
                sharePending = false,
                onSend = {},
                onLoadDeferredShare = { state = state.loadDeferredShare() },
                incomingShare = incoming,
                queuedInboxItems = inboxItems,
                queuedInboxPreview = inboxPreview,
                onRefreshQueuedInbox = { inboxRefreshed = true },
                onOpenQueuedInboxItem = { inboxReviewed = true },
                onCopyQueuedInbox = { inboxCopied = true; inboxPreview=null },
                onDeclineQueuedInbox = { inboxDeclined = true; inboxPreview=null },
                onCopyIncoming = { copied = true; incoming = null },
                onDeclineIncoming = { declined = true; incoming = null },
                backgroundReceiving = backgroundRunning,
                backgroundReceiveError = backgroundError,
                onToggleBackgroundReceiving = { backgroundRunning = it },
                onOpenNotificationSettings = { notificationSettingsOpened = true },
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

    @Test fun immediateManualRefreshIsDisabledWithoutLosingSelectedReadyRecipient() {
        mount(ready = true)
        compose.runOnIdle {
            state = state.navigate(Section.SEND).editDraft("Ready to send")
            selected = mac.nodeId
            refreshCooldown = true
        }
        compose.onNodeWithTag("refresh-recipients").assertIsNotEnabled()
        compose.onNodeWithTag("share-submit").performScrollTo().assertIsEnabled()
        compose.runOnIdle { refreshCooldown = false }
        compose.onNodeWithTag("refresh-recipients").performScrollTo().assertIsEnabled()
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

    @Test fun imageShareShowsPreviewButCannotSubmitThroughTextRelay() {
        mount(ready = true)
        val png = ByteArrayOutputStream().use { output ->
            val bitmap = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
            try {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
                output.toByteArray()
            } finally {
                bitmap.recycle()
            }
        }
        compose.runOnIdle {
            state = state.importShare(ShareDelivery(1,
                image = SharedImageDraft("image/png", png)))
            selected = mac.nodeId
        }
        compose.onNodeWithTag("shared-image-preview").assertExists()
        compose.onNodeWithTag("share-submit").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("share-draft").performTextReplacement("send text instead")
        compose.onNodeWithTag("share-submit").performScrollTo().assertIsEnabled()
    }

    @Test fun backgroundReceivingIsExplicitAndDisabledUntilPaired() {
        mount(ready = true)
        compose.onNodeWithTag("tab-settings").performClick()
        compose.onNodeWithTag("background-receiving-toggle").assertIsEnabled().performClick()
        compose.runOnIdle { org.junit.Assert.assertTrue(backgroundRunning) }
        compose.onNodeWithTag("background-receiving-toggle").performClick()
        compose.runOnIdle { org.junit.Assert.assertFalse(backgroundRunning) }
    }

    @Test fun blockedNotificationsOfferSystemSettingsShortcut() {
        notificationSettingsOpened = false
        mount(ready = true)
        compose.runOnIdle {
            state = state.navigate(Section.SETTINGS)
            backgroundError = "Atlas notification channels are disabled."
        }
        compose.onNodeWithTag("open-notification-settings")
            .performScrollTo().assertIsEnabled().performClick()
        compose.runOnIdle { org.junit.Assert.assertTrue(notificationSettingsOpened) }
        compose.runOnIdle { backgroundError = null }
    }

    @Test fun queuedInboxRequiresReviewAndExplicitCopyOrDecline() {
        inboxRefreshed=false; inboxReviewed=false; inboxCopied=false; inboxDeclined=false
        mount(ready=true)
        val id="123e4567-e89b-42d3-a456-426614174012"
        val source="123e4567-e89b-42d3-a456-426614174013"
        compose.onNodeWithTag("tab-inbox").performClick()
        compose.onNodeWithTag("queued-inbox-refresh").assertIsEnabled().performClick()
        compose.runOnIdle {
            org.junit.Assert.assertTrue(inboxRefreshed)
            inboxItems=listOf(PendingInboxItem(id,source,"2026-11-02T00:00:00Z","2026-10-31T00:00:00Z"))
        }
        compose.onNodeWithTag("queued-inbox-open-"+id).performScrollTo().performClick()
        compose.runOnIdle {
            org.junit.Assert.assertTrue(inboxReviewed)
            org.junit.Assert.assertFalse(inboxCopied)
            inboxPreview=InboxReply.Content(id,id,source,"Unicode 🎉 notes")
        }
        compose.onNodeWithTag("queued-inbox-decline").assertIsEnabled().performClick()
        compose.runOnIdle {
            org.junit.Assert.assertTrue(inboxDeclined)
            org.junit.Assert.assertFalse(inboxCopied)
            inboxPreview=InboxReply.Content(id,id,source,"Another note")
        }
        compose.onNodeWithTag("queued-inbox-copy").assertIsEnabled().performClick()
        compose.runOnIdle { org.junit.Assert.assertTrue(inboxCopied) }
    }

    @Test fun incomingCopyRequiresExplicitConsentAndDeclineDoesNotCopy() {
        copied = false
        declined = false
        mount(ready = true)
        val incomingItem = IncomingDeviceShare(
            "123e4567-e89b-42d3-a456-426614174009",
            "123e4567-e89b-42d3-a456-426614174010",
            "123e4567-e89b-42d3-a456-426614174011",
            "Test text from Mac", System.currentTimeMillis() + 15_000L,
        )
        compose.runOnIdle { incoming = incomingItem }
        compose.onNodeWithTag("incoming-decline").assertIsEnabled().performClick()
        compose.runOnIdle {
            org.junit.Assert.assertFalse(copied)
            org.junit.Assert.assertTrue(declined)
            incoming = incomingItem
        }
        compose.onNodeWithTag("incoming-copy").assertIsEnabled().performClick()
        compose.runOnIdle { org.junit.Assert.assertTrue(copied) }
    }
}
