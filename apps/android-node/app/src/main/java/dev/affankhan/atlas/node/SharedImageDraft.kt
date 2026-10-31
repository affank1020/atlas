package dev.affankhan.atlas.node

import java.io.ByteArrayOutputStream
import java.io.InputStream

// This is a local, volatile draft, NOT a transfer protocol. The later binary
// transport must use a dedicated authenticated path rather than text-share JSON.
internal const val MAX_SHARED_IMAGE_BYTES = 8 * 1024 * 1024
internal const val MAX_IMAGE_DIMENSION = 16_384

internal data class SharedImageDraft(val mimeType: String, val bytes: ByteArray) {
    val sizeBytes: Int get() = bytes.size
}

/** Read a user-selected Android content URI without writing it to disk.
 * Provider-reported MIME types are untrusted; reject conflicting signatures.
 * The extra byte detects oversized streams even if a provider hides its size.
 */
internal fun readSharedImage(
    input: InputStream,
    mimeType: String,
    maxBytes: Int = MAX_SHARED_IMAGE_BYTES,
): SharedImageDraft {
    require(mimeType == "image/png" || mimeType == "image/jpeg") { "Only PNG and JPEG are supported." }
    require(maxBytes > 0 && maxBytes <= MAX_SHARED_IMAGE_BYTES)
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(64 * 1024)
    var total = 0
    while (true) {
        val count = input.read(buffer)
        if (count == -1) break
        if (count == 0) continue
        if (count > maxBytes - total)
            throw IllegalArgumentException("Image is larger than the 8 MB import limit.")
        output.write(buffer, 0, count)
        total += count
    }
    val bytes = output.toByteArray()
    require(hasImageSignature(bytes, mimeType)) { "Image contents do not match the selected format." }
    return SharedImageDraft(mimeType, bytes)
}

internal fun hasImageSignature(bytes: ByteArray, mimeType: String): Boolean {
    val u: (Int) -> Int = { i -> bytes[i].toInt() and 0xff }
    return when (mimeType) {
        "image/png" -> bytes.size >= 24 &&
            listOf(137, 80, 78, 71, 13, 10, 26, 10).indices.all {
                u(it) == listOf(137, 80, 78, 71, 13, 10, 26, 10)[it]
            } && bytes.sliceArray(12..15).contentEquals(byteArrayOf(73, 72, 68, 82)) &&
            (u(16) or u(17) or u(18) or u(19)) != 0 &&
            (u(20) or u(21) or u(22) or u(23)) != 0
        "image/jpeg" -> bytes.size >= 4 && u(0) == 0xff && u(1) == 0xd8 &&
            u(bytes.size - 2) == 0xff && u(bytes.size - 1) == 0xd9
        else -> false
    }
}
