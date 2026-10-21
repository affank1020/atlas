package dev.affankhan.atlas.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CompanionSessionTest {
    @Test fun sameContentNewDeliveryReopensSendAndResetsEdits() {
        var session = CompanionSession().importShare(ShareDelivery(1, "https://example.com"))
        session = session.editDraft("modified").navigate(Section.DEVICES)
        session = session.importShare(ShareDelivery(2, "https://example.com"))
        assertEquals(Section.SEND, session.section)
        assertEquals("https://example.com", session.draft)
        assertEquals(2L, session.lastDeliveryId)
    }

    @Test fun navigationKeepsDraft() {
        val session = CompanionSession().editDraft("edited")
            .navigate(Section.SETTINGS).navigate(Section.SEND)
        assertEquals("edited", session.draft)
    }

    @Test fun staleEventCannotReplaceNewerDraft() {
        val session = CompanionSession().importShare(ShareDelivery(2, "original"))
            .editDraft("edited").importShare(ShareDelivery(2, "original"))
        assertEquals("edited", session.draft)
    }

    @Test fun errorsShowSendAndClearOnEditing() {
        val session = CompanionSession().importShare(ShareDelivery(1, error = "Too large"))
        assertEquals(Section.SEND, session.section)
        assertEquals("Too large", session.error)
        assertNull(session.editDraft("now valid").error)
    }

    @Test fun draftLimitIsEnforced() {
        assertEquals(MAX_SHARE_CHARACTERS,
            CompanionSession().editDraft("a".repeat(MAX_SHARE_CHARACTERS + 50)).draft.length)
    }
}
