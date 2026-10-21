package dev.affankhan.atlas.node

import android.content.Intent
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Rule
import org.junit.Test

class SharesheetUiTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun deliver(value: String) {
        compose.runOnUiThread {
            compose.activity.startActivity(Intent(compose.activity, MainActivity::class.java).apply {
                action = Intent.ACTION_SEND
                type = "text/plain"
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                putExtra(Intent.EXTRA_TEXT, value)
            })
        }
        compose.waitForIdle()
    }

    @Test fun identicalShareOpensSendAgainAndOverwritesOldDraft() {
        deliver("https://example.com")
        compose.onNodeWithTag("share-draft").performTextReplacement("edited")
        compose.onNodeWithTag("tab-devices").performClick()
        deliver("https://example.com")
        compose.onNodeWithTag("share-draft").assertTextContains("https://example.com")
    }

    @Test fun leavingSendAndReturningRetainsDraft() {
        compose.onNodeWithTag("tab-send").performClick()
        compose.onNodeWithTag("share-draft").performTextReplacement("local draft")
        compose.onNodeWithTag("tab-settings").performClick()
        compose.onNodeWithTag("tab-send").performClick()
        compose.onNodeWithTag("share-draft").assertTextContains("local draft")
    }
}
