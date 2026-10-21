/**
 * Transport primitive for future mobile and desktop capture queues. The caller
 * must persist uploadId across retries, and must only use approved local or
 * HTTPS Atlas Server addresses. This is not yet a resumable upload protocol.
 */
/** Only the HTTP status crosses the queue boundary, never private response text. */
export class NodeFileTransferError extends Error {
    constructor(readonly httpStatus: number) {
        super('Atlas Node transfer failed (HTTP ' + httpStatus + ').');
        this.name = 'NodeFileTransferError';
    }
}

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
        throw new NodeFileTransferError(response.status);
    }
    return response.json() as Promise<{ file: { id: string; checksum: string }; replayed: boolean }>;
}


/**
 * Checkpointed Node transfer for mobile/desktop capture queues. The caller
 * owns and persists the stable upload UUID and file bytes across retries.
 * A later invocation asks the server which 1-MiB chunks already arrived,
 * then sends only missing chunks. No retry timer/background task is implied.
 * This Node.js helper uses crypto; native mobile runtimes need an equivalent
 * SHA-256 adapter and durable file-backed queue.
 */
export async function uploadNodeFileResumable(input: {
    serverUrl: string; nodeId: string; credential: string; workspaceId: string;
    uploadId: string; fileName: string; mimeType: string; bytes: Uint8Array;
}, request: typeof fetch = fetch): Promise<{ fileId: string; replayed: boolean }> {
    const { createHash } = await import('node:crypto');
    const url = new URL(input.serverUrl);
    if (url.pathname !== '/node/connect' || url.search || url.hash || !['wss:', 'ws:'].includes(url.protocol))
        throw new Error('Node file upload requires the Atlas Node WebSocket address.');
    if (url.protocol === 'ws:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname))
        throw new Error('Non-local Atlas Node uploads require HTTPS.');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.uploadId))
        throw new Error('A stable upload UUID is required.');
    if (input.bytes.length < 1 || input.bytes.length > 25 * 1024 * 1024)
        throw new Error('Node file upload must be between 1 byte and 25 MiB.');
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    const headers = {
        authorization: `Bearer ${input.credential}`,
        'x-atlas-node-id': input.nodeId, 'x-atlas-workspace-id': input.workspaceId,
        'x-atlas-upload-id': input.uploadId,
    };
    async function post(action: string, payload: Record<string, unknown> | Uint8Array, extra: Record<string,string> = {}) {
        url.pathname = '/node/files/resumable/' + action;
        const binary = payload instanceof Uint8Array;
        const response = await request(url.toString(), {
            method: 'POST',
            headers: { ...headers, 'content-type': binary ? 'application/octet-stream' : 'application/json',
                ...extra },
            body: binary ? new Uint8Array(payload) : JSON.stringify(payload),
            signal: AbortSignal.timeout(120_000),
            redirect: 'error',
        });
        if (!response.ok) throw new NodeFileTransferError(response.status);
        return response.json() as Promise<any>;
    }
    const checksum = createHash('sha256').update(input.bytes).digest('hex');
    const state = await post('init',{ fileName: input.fileName, mimeType: input.mimeType,
        byteSize: input.bytes.length, checksum }) as {
            completed: boolean; fileId?: string; received: number[]; chunkBytes: number;
        };
    if (state.completed && state.fileId) return { fileId: state.fileId, replayed: true };
    if (state.chunkBytes !== 1024 * 1024 || !Array.isArray(state.received))
        throw new Error('Unsupported Atlas Node transfer checkpoint format.');
    const received = new Set(state.received);
    const count = Math.ceil(input.bytes.length / state.chunkBytes);
    for (let index = 0; index < count; index++) {
        if (received.has(index)) continue;
        const start = index * state.chunkBytes;
        const chunk = input.bytes.subarray(start,Math.min(start + state.chunkBytes,input.bytes.length));
        await post('chunk',chunk,{ 'x-atlas-part-index': String(index),
            'x-atlas-part-sha256': createHash('sha256').update(chunk).digest('hex') });
    }
    const completed = await post('complete',{});
    if (typeof completed.fileId !== 'string')
        throw new Error('Atlas Node transfer did not return a final file ID.');
    return { fileId: completed.fileId, replayed: completed.replayed === true };
}
