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

    fun activityStarted(): ConnectionOwners = copy(visibleActivities = visibleActivities + 1)
    fun activityStopped(): ConnectionOwners = copy(
        visibleActivities = (visibleActivities - 1).coerceAtLeast(0),
    )
}
