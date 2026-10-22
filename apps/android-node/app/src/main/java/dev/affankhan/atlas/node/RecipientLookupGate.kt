package dev.affankhan.atlas.node

/**
 * Small Android-independent recipient directory request state machine.
 * Monotonic elapsed-time values are supplied by the caller, making timeout,
 * stale-response and immediate-refresh behaviour deterministic in JVM tests.
 */
internal class RecipientLookupGate(private val minimumSpacingMs: Long) {
    var pendingRequestId: String? = null
        private set
    private var lastRequestStartedAt: Long? = null

    fun start(id: String, nowMs: Long): Boolean {
        if (pendingRequestId != null || (lastRequestStartedAt?.let { nowMs - it < minimumSpacingMs } == true))
            return false
        pendingRequestId = id
        lastRequestStartedAt = nowMs
        return true
    }

    /** Used by both matching replies and the bounded timeout watchdog. */
    fun finish(id: String): Boolean {
        if (pendingRequestId != id) return false
        pendingRequestId = null
        return true
    }

    fun reset() {
        pendingRequestId = null
        lastRequestStartedAt = null
    }
}
