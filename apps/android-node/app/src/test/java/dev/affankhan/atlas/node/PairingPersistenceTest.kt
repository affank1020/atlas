package dev.affankhan.atlas.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PairingPersistenceTest {
    private val node = StoredNode("https://atlas.example.com",
        "123e4567-e89b-42d3-a456-426614174000", "a".repeat(43), "Android")

    @Test fun successfulPairingRecordsThenPersistsIssuedIdentity() {
        val trace = mutableListOf<String>()
        val result = enrolAndPersist(
            enrol = { trace.add("enrol"); node },
            rememberIssued = { trace.add("issued:" + it) },
            persist = { trace.add("persist:" + it.nodeId) },
        )
        assertEquals(node, result)
        assertEquals(listOf("enrol", "issued:" + node.nodeId, "persist:" + node.nodeId), trace)
    }

    @Test fun failedKeystorePersistenceReturnsNonSecretRecoveryNodeId() {
        val saved = assertThrows(PairingPersistenceException::class.java) {
            enrolAndPersist(enrol = { node }, rememberIssued = {}, persist = {
                throw IllegalStateException("storage failure")
            })
        }
        assertEquals(node.nodeId, saved.nodeId)
        check(!saved.message.orEmpty().contains(node.credential))
    }

    @Test fun failedRecoveryNoteIsReportedAsPostEnrolmentFailure() {
        val error = assertThrows(PairingPersistenceException::class.java) {
            enrolAndPersist(enrol = { node }, rememberIssued = { throw IllegalStateException("IO") },
                persist = { error("must never execute") })
        }
        assertEquals(node.nodeId, error.nodeId)
    }

    @Test fun failedEnrolmentDoesNotClaimNodeWasIssued() {
        assertThrows(IllegalArgumentException::class.java) {
            enrolAndPersist(enrol = { throw IllegalArgumentException("ticket invalid") },
                rememberIssued = { error("not issued") }, persist = { error("not issued") })
        }
    }
}
