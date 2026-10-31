package dev.affankhan.atlas.node

/**
 * One connection can be retained by the visible Activity, by the opted-in
 * foreground service, or both. An Activity stop must not close the service's
 * WebSocket; stopping the service must not close a visible Activity's socket.
 */
internal data class ConnectionOwners(
    val activityVisible: Boolean = false,
    val serviceRunning: Boolean = false,
) {
    val connected: Boolean get() = activityVisible || serviceRunning
    val canApproveClipboard: Boolean get() = activityVisible
}
