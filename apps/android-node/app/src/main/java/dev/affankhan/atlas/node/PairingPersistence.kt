package dev.affankhan.atlas.node

/** Redacted recovery exception: never include an issued credential or pairing ticket. */
internal class PairingPersistenceException(val nodeId: String, cause: Throwable) :
    Exception("Issued credential could not be stored; revoke Node " + nodeId + " in Atlas Web.", cause)

/**
 * Synchronous critical section: called inside one bounded NonCancellable IO block.
 * Record the (non-secret) issued UUID first, then persist the encrypted credential
 * before resuming the caller. This makes retries/recovery explicit on app restart.
 */
internal fun enrolAndPersist(
    enrol: () -> StoredNode,
    rememberIssued: (String) -> Unit,
    persist: (StoredNode) -> Unit,
): StoredNode {
    val node = enrol()
    try {
        rememberIssued(node.nodeId)
        persist(node)
    } catch (error: Exception) {
        throw PairingPersistenceException(node.nodeId, error)
    }
    return node
}
