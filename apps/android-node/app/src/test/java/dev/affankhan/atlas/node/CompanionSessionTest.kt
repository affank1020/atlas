package dev.affankhan.atlas.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CompanionSessionTest {
    @Test fun newSharedTextWaitsUntilPreviousDeliveryHasResolved() {
        var session = CompanionSession().receiveShare(ShareDelivery(1, "A submitted"), sending = false)
        session = session.receiveShare(ShareDelivery(2, "B arrived"), sending = true)
        assertEquals("A submitted", session.draft)
        assertEquals("B arrived", session.deferredShare?.text)
        assertEquals(1L, session.lastDeliveryId)
        session = session.loadDeferredShare()
        assertEquals("B arrived", session.draft)
        assertEquals(2L, session.lastDeliveryId)
        assertEquals(null, session.deferredShare)
    }

    @Test fun newestPendingShareIsStagedWithoutOverwritingSentDraft() {
        val session = CompanionSession()
            .receiveShare(ShareDelivery(1, "A submitted"), sending = false)
            .receiveShare(ShareDelivery(2, "B arrived"), sending = true)
            .receiveShare(ShareDelivery(3, "C arrived"), sending = true)
        assertEquals("A submitted", session.draft)
        assertEquals("C arrived", session.deferredShare?.text)
        assertEquals("C arrived", session.loadDeferredShare().draft)
    }

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
