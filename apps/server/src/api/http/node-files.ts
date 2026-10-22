import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerServices } from '../../server/composition.js';
import { AtlasError } from '../../shared/errors.js';
import { NODE_FILE_LIMIT_BYTES } from '../../server/node-file-ingest.js';

const PATH = '/node/files/upload';
const MAX_ENCODED_NAME = 255 * 9;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function send(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(body));
}

function requiredHeader(request: IncomingMessage, name: string, max: number) {
    const value = request.headers[name];
    if (typeof value !== 'string' || value.length < 1 || value.length > max)
        throw new AtlasError('Invalid Node Files request metadata.');
    return value;
}

async function bodyBytes(request: IncomingMessage): Promise<Buffer> {
    const declared = request.headers['content-length'];
    if (declared !== undefined &&
        (!/^\d+$/.test(declared) || Number(declared) > NODE_FILE_LIMIT_BYTES))
        throw new AtlasError('Node Files upload exceeds 25 MiB.', 'UPLOAD_TOO_LARGE');
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > NODE_FILE_LIMIT_BYTES)
            throw new AtlasError('Node Files upload exceeds 25 MiB.', 'UPLOAD_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
    }
    if (length === 0) throw new AtlasError('Node Files upload cannot be empty.');
    return Buffer.concat(chunks, length);
}

/**
 * Native Nodes use their own Node-issued Bearer credential, never Caddy admin
 * credentials. The endpoint is opt-in and cannot be called from web Origins.
 * The full upload protocol will later support resumable/multipart transfers.
 */
export async function serveNodeFileUpload(request: IncomingMessage, response: ServerResponse,
    services: Pick<ServerServices, 'config' | 'nodeFileIngest'>): Promise<boolean> {
    if (request.url !== PATH) return false;
    if (!services.config.nodeFiles.enabled) { send(response, 404, { error: 'NOT_FOUND' }); return true; }
    if (request.method !== 'POST') { response.setHeader('allow', 'POST'); send(response, 405, { error: 'METHOD_NOT_ALLOWED' }); return true; }
    // Native Node requests do not send Origin. Reject browser/web-view callers
    // (including same-site Origins) instead of granting any CORS access.
    if (request.headers.origin !== undefined) { send(response, 403, { error: 'ORIGIN_DENIED' }); return true; }
    try {
        const authorization = request.headers.authorization;
        if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,}$/.test(authorization)) {
            send(response, 401, { error: 'NODE_AUTH_INVALID' }); return true;
        }
        const credential = authorization.slice(7);
        const nodeId = requiredHeader(request, 'x-atlas-node-id', 36);
        const workspaceId = requiredHeader(request, 'x-atlas-workspace-id', 36);
        const uploadId = requiredHeader(request, 'x-atlas-upload-id', 36);
        if (![nodeId, workspaceId, uploadId].every(value => UUID.test(value)))
            throw new AtlasError('Invalid Node Files identity fields.');
        if (request.headers['content-type'] !== 'application/octet-stream')
            throw new AtlasError('Node Files accepts application/octet-stream only.');
        const encodedName = requiredHeader(request, 'x-atlas-file-name', MAX_ENCODED_NAME);
        let fileName: string;
        try { fileName = decodeURIComponent(encodedName); }
        catch { throw new AtlasError('Invalid Node Files file name.'); }
        const mimeType = requiredHeader(request, 'x-atlas-file-type', 120);
        // Authenticate *before* accepting any potentially expensive body bytes.
        await services.nodeFileIngest.authorize(nodeId, credential, workspaceId);
        request.setTimeout(120_000, () => request.destroy());
        const bytes = await bodyBytes(request);
        const saved = await services.nodeFileIngest.ingest({
            nodeId, credential, workspaceId, uploadId, fileName, mimeType, bytes,
        });
        send(response, saved.replayed ? 200 : 201, saved);
    } catch (error) {
        if (response.destroyed) return true;
        const known = error instanceof AtlasError;
        const status = !known ? 500
            : error.code === 'NODE_AUTH_INVALID' || error.code === 'NODE_REVOKED' ? 401
            : error.code === 'NOT_FOUND' ? 404
            : error.code === 'CONFLICT' ? 409
            : error.code === 'QUOTA_EXCEEDED' ? 507
            : error.code === 'UPLOAD_TOO_LARGE' ? 413 : 400;
        send(response, status, { error: known ? error.code : 'NODE_FILES_UNAVAILABLE',
            message: known ? error.message : 'Node file upload failed.' });
    }
    return true;
}
