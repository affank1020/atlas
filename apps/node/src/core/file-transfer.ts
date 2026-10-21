/**
 * Transport primitive for future mobile and desktop capture queues. The caller
 * must persist uploadId across retries, and must only use approved local or
 * HTTPS Atlas Server addresses. This is not yet a resumable upload protocol.
 */
export async function uploadNodeFileOnce(input: {
    serverUrl: string; nodeId: string; credential: string; workspaceId: string;
    uploadId: string; fileName: string; mimeType: string; bytes: Uint8Array;
}, request: typeof fetch = fetch): Promise<{ file: { id: string; checksum: string }; replayed: boolean }> {
    const address = new URL(input.serverUrl);
    if (address.pathname !== '/node/connect' || address.search || address.hash ||
        !['ws:', 'wss:'].includes(address.protocol))
        throw new Error('Node file upload requires the Atlas Node WebSocket address.');
    const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname);
    if (address.protocol !== 'wss:' && !isLocal)
        throw new Error('Non-local Atlas Node uploads require HTTPS.');
    if (!input.bytes.length || input.bytes.length > 25 * 1024 * 1024)
        throw new Error('Node file upload must be between 1 byte and 25 MiB.');
    // The caller, not this function, controls the UUID for offline replay.
    if (!/^[a-f0-9-]{36}$/i.test(input.uploadId))
        throw new Error('A stable upload UUID is required.');
    address.protocol = address.protocol === 'wss:' ? 'https:' : 'http:';
    address.pathname = '/node/files/upload';
    const response = await request(address.toString(), {
        method: 'POST',
        headers: {
            authorization: `Bearer ${input.credential}`,
            'content-type': 'application/octet-stream',
            'x-atlas-node-id': input.nodeId,
            'x-atlas-workspace-id': input.workspaceId,
            'x-atlas-upload-id': input.uploadId,
            'x-atlas-file-name': encodeURIComponent(input.fileName),
            'x-atlas-file-type': input.mimeType,
        },
        body: new Uint8Array(input.bytes),
        signal: AbortSignal.timeout(120_000),
        redirect: 'error',
    });
    if (!response.ok) {
        // Do not echo request headers, tokens or raw server errors to logs.
        throw new Error(`Atlas Node file upload failed (HTTP ${response.status}).`);
    }
    return response.json() as Promise<{ file: { id: string; checksum: string }; replayed: boolean }>;
}
