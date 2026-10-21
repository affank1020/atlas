package dev.affankhan.atlas.node

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Exercises a real Android Keystore on the emulator, without touching a paired Node. */
class NodeVaultInstrumentedTest {
    @Test fun encryptedIdentitySurvivesVaultRecreationAndIsCleared() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val vault = NodeVault(context, "atlas_identity_instrumentation_only", "atlas_mobile_node_test_key")
        vault.clear()
        try {
            val identity = StoredNode(
                origin = "https://atlas.example.com",
                nodeId = "123e4567-e89b-42d3-a456-426614174000",
                credential = "a".repeat(43),
                name = "Emulator Node",
            )
            vault.save(identity)
            val reopened = NodeVault(context, "atlas_identity_instrumentation_only", "atlas_mobile_node_test_key")
            assertEquals(identity, reopened.load())
            reopened.clear()
            assertNull(vault.load())
        } finally {
            vault.clear()
        }
    }
}
