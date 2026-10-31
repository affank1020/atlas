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

    @Test fun imageImportReplacesTextAndClearsOnEdit() {
        val image = SharedImageDraft("image/png", byteArrayOf(1, 2))
        var session = CompanionSession().importShare(ShareDelivery(1, text = "previous"))
        session = session.importShare(ShareDelivery(2, image = image))
        assertEquals("", session.draft)
        assertEquals(image, session.image)
        session = session.editDraft("now text")
        assertNull(session.image)
        assertEquals("now text", session.draft)
    }

    @Test fun asynchronousImageCompletionDoesNotClobberNewerShare() {
        val image = SharedImageDraft("image/png", byteArrayOf(1, 2))
        val pending = CompanionSession().importShare(
            ShareDelivery(1, error = "Opening shared image…", importingImage = true))
        val newer = pending.importShare(ShareDelivery(2, text = "new text"))
        val stale = newer.completeImageImport(ShareDelivery(1, image = image))
        assertEquals("new text", stale.draft)
        assertNull(stale.image)
        assertEquals(2L, stale.lastDeliveryId)
    }

    @Test fun imageImportCompletesDeferredShareWithoutReplacingSentText() {
        val image = SharedImageDraft("image/png", byteArrayOf(1, 2))
        var session = CompanionSession().importShare(ShareDelivery(1, text = "sending"))
            .receiveShare(ShareDelivery(2, error = "Opening shared image…", importingImage = true),
                sending = true)
        session = session.completeImageImport(ShareDelivery(2, image = image))
        assertEquals("sending", session.draft)
        assertEquals(image, session.deferredShare?.image)
        assertEquals(image, session.loadDeferredShare().image)
    }

    @Test fun deferredScreenshotCompletesAfterTextReceiptAndDraftEdit() {
        // Text send is awaiting a Mac receipt when a screenshot arrives.
        val image = SharedImageDraft("image/png", byteArrayOf(1, 2, 3))
        var session = CompanionSession().importShare(ShareDelivery(1, text = "sent text"))
            .receiveShare(
                ShareDelivery(2, error = "Opening shared image…", importingImage = true),
                sending = true,
            )
        // Text receipt resolves (sending=false); user edits the previous draft
        // while the deferred screenshot is still reading its content URI.
        session = session.editDraft("edited after receipt")
        assertEquals("edited after receipt", session.draft)
        assertEquals(true, session.deferredShare?.importingImage)
        session = session.completeImageImport(ShareDelivery(2, image = image))
        assertEquals("edited after receipt", session.draft)
        assertEquals(image, session.deferredShare?.image)
        assertEquals(false, session.deferredShare?.importingImage)
        session = session.loadDeferredShare()
        assertEquals(image, session.image)
        assertEquals(2L, session.lastDeliveryId)
        assertNull(session.deferredShare)
    }

    @Test fun textEditCancelsOnlyTheActiveImagePlaceholder() {
        val image = SharedImageDraft("image/png", byteArrayOf(1, 2, 3))
        val loading = CompanionSession().importShare(
            ShareDelivery(1, error = "Opening shared image…", importingImage = true))
        val edited = loading.editDraft("manually entered text")
        val lateCompletion = edited.completeImageImport(ShareDelivery(1, image = image))
        assertEquals("manually entered text", lateCompletion.draft)
        assertNull(lateCompletion.image)
        assertEquals(false, lateCompletion.importingImage)
        assertEquals(edited, lateCompletion)
    }

    @Test fun editingLoadedDeferredScreenshotCancelsItsLateCompletion() {
        val image = SharedImageDraft("image/jpeg", byteArrayOf(3, 2, 1))
        val loaded = CompanionSession().importShare(ShareDelivery(1, text = "sending"))
            .receiveShare(
                ShareDelivery(2, error = "Opening shared image…", importingImage = true),
                sending = true,
            ).loadDeferredShare()
        val edited = loaded.editDraft("user replaced pending screenshot")
        val lateCompletion = edited.completeImageImport(ShareDelivery(2, image = image))
        assertNull(lateCompletion.image)
        assertEquals("user replaced pending screenshot", lateCompletion.draft)
        assertEquals(edited, lateCompletion)
    }

    @Test fun draftLimitIsEnforced() {
        assertEquals(MAX_SHARE_CHARACTERS,
            CompanionSession().editDraft("a".repeat(MAX_SHARE_CHARACTERS + 50)).draft.length)
    }
}
