package dev.affankhan.atlas.node

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class StoredNode(
    val origin: String,
    val nodeId: String,
    val credential: String,
    val name: String,
)

/**
 * Android Keystore AES-GCM key encrypts Node credentials before private app storage.
 * Credentials are not in backups, SavedState, APK, URLs, or logs.
 */
internal class NodeVault(private val context: Context) {
    private val preferences get() = context.getSharedPreferences("atlas_node_identity", Context.MODE_PRIVATE)
    private val alias = "atlas_mobile_node_aes_v1"
    private val aad = "atlas.mobile.node.identity.v1".toByteArray(Charsets.UTF_8)

    private fun key(create: Boolean): SecretKey? {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        if (!create) return null
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
            generateKey()
        }
    }

    fun save(node: StoredNode) {
        parseAtlasEndpoint(node.origin)
        require(node.credential.length >= 32 && node.nodeId.isNotBlank())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, requireNotNull(key(true)))
        cipher.updateAAD(aad)
        val json = JSONObject()
            .put("origin", node.origin)
            .put("nodeId", node.nodeId)
            .put("credential", node.credential)
            .put("name", node.name)
        val ciphertext = cipher.doFinal(json.toString().toByteArray(Charsets.UTF_8))
        val encoded = Base64.encodeToString(cipher.iv + ciphertext, Base64.NO_WRAP)
        check(preferences.edit().putString("sealed_identity", encoded).commit()) {
            "Could not securely save this Node identity."
        }
    }

    fun load(): StoredNode? {
        val encoded = preferences.getString("sealed_identity", null) ?: return null
        return runCatching {
            val raw = Base64.decode(encoded, Base64.NO_WRAP)
            require(raw.size > 12 + 16)
            val secret = requireNotNull(key(false))
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, raw.copyOfRange(0, 12)))
            cipher.updateAAD(aad)
            val json = JSONObject(String(cipher.doFinal(raw.copyOfRange(12, raw.size)), Charsets.UTF_8))
            val node = StoredNode(json.getString("origin"), json.getString("nodeId"),
                json.getString("credential"), json.getString("name"))
            parseAtlasEndpoint(node.origin)
            require(node.credential.length >= 32)
            node
        }.getOrNull() // If the Keystore key is gone, never fall back to plaintext.
    }

    fun clear() {
        check(preferences.edit().remove("sealed_identity").commit())
    }
}
