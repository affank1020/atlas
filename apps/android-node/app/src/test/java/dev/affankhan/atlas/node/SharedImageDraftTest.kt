package dev.affankhan.atlas.node

import java.io.ByteArrayInputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedImageDraftTest {
    private val png = byteArrayOf(
        0x89.toByte(), 80, 78, 71, 13, 10, 26, 10,
        0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, 1, 0, 0, 0, 1,
        0, 0, 0, 0
    )
    private val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xd9.toByte())

    @Test fun acceptsPngAndPreservesExactBytes() {
        val image = readSharedImage(ByteArrayInputStream(png), "image/png")
        assertEquals("image/png", image.mimeType)
        assertEquals(png.size, image.sizeBytes)
        assertArrayEquals(png, image.bytes)
    }

    @Test fun acceptsCompleteJpegMarkers() {
        assertTrue(hasImageSignature(jpeg, "image/jpeg"))
        val image = readSharedImage(ByteArrayInputStream(jpeg), "image/jpeg")
        assertArrayEquals(jpeg, image.bytes)
    }

    @Test fun rejectsSpoofedMimeAndUnsupportedTypes() {
        assertFalse(hasImageSignature(jpeg, "image/png"))
        assertThrows(IllegalArgumentException::class.java) {
            readSharedImage(ByteArrayInputStream(jpeg), "image/png")
        }
        assertThrows(IllegalArgumentException::class.java) {
            readSharedImage(ByteArrayInputStream(png), "application/pdf")
        }
    }

    @Test fun rejectsOversizedInputBeforeUnboundedAllocation() {
        val data = ByteArray(65_537)
        assertThrows(IllegalArgumentException::class.java) {
            readSharedImage(ByteArrayInputStream(data), "image/png", 65_536)
        }
    }

    @Test fun rejectsTruncatedImagesAndEmptyBodies() {
        assertFalse(hasImageSignature(byteArrayOf(0x89.toByte(), 80, 78), "image/png"))
        assertFalse(hasImageSignature(byteArrayOf(0xff.toByte(), 0xd8.toByte()), "image/jpeg"))
        assertThrows(IllegalArgumentException::class.java) {
            readSharedImage(ByteArrayInputStream(byteArrayOf()), "image/png")
        }
    }
}
