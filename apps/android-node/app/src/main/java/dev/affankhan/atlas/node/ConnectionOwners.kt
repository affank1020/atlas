package dev.affankhan.atlas.node

/**
 * One connection can be retained by the visible Activity, by the opted-in
 * foreground service, or both. An Activity stop must not close the service's
 * WebSocket; stopping the service must not close a visible Activity's socket.
 */
internal data class ConnectionOwners(
    val visibleActivities: Int = 0,
    val serviceRunning: Boolean = false,
) {
    val activityVisible: Boolean get() = visibleActivities > 0
    val connected: Boolean get() = activityVisible || serviceRunning
    val canApproveClipboard: Boolean get() = activityVisible

    /** A pending authenticated opt-out temporarily owns the Node socket. */
    fun mayReleaseSocket(revocationPending: Boolean): Boolean = !connected && !revocationPending

    fun activityStarted(): ConnectionOwners = copy(visibleActivities = visibleActivities + 1)
    fun activityStopped(): ConnectionOwners = copy(
        visibleActivities = (visibleActivities - 1).coerceAtLeast(0),
    )
}


/**
 * Resolves overlapping Stop/Start intents while a prior FCM revocation is
 * in flight. A callback from an older Stop must never tear down a newer Start.
 * The newest Start can be queued until server revocation/deleteToken finishes.
 * Main-thread confined, matching the CompanionViewModel/service lifecycle.
 */
internal class BackgroundReceiveIntentGate {
    private var revision = 0L
    private var deferredStart: (() -> Unit)? = null
    var desiredEnabled: Boolean = false
        private set

    fun start(revocationInProgress: Boolean, action: () -> Unit) {
        val current = ++revision
        desiredEnabled = true
        val guarded = {
            if (current == revision && desiredEnabled) action()
        }
        if (revocationInProgress) deferredStart = guarded else {
            deferredStart = null
            guarded()
        }
    }

    /** Returns a completion callback safe to invoke after an async unregister. */
    fun stop(action: () -> Unit): () -> Unit {
        val current = ++revision
        desiredEnabled = false
        deferredStart = null
        return {
            if (current == revision && !desiredEnabled) action()
        }
    }

    fun completeRevocation() {
        val next = deferredStart
        deferredStart = null
        next?.invoke()
    }
}
