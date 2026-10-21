package dev.affankhan.atlas.node

import android.content.Intent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel

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
internal class CompanionViewModel : ViewModel() {
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
