import type { IncomingMessage, ServerResponse } from 'node:http';
import { AtlasError } from '../../shared/errors.js';
import { MAX_DEVICE_IMAGE_BYTES } from '@atlas/protocol/device-protocol';
import type { ServerServices } from '../../server/composition.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function reply(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(body));
}
function header(request: IncomingMessage, name: string, max = 80): string {
    const value = request.headers[name];
    if (typeof value !== 'string' || !value.length || value.length > max)
        throw new AtlasError('Invalid image request metadata.', 'INVALID_REQUEST');
    return value;
}
async function readImage(request: IncomingMessage): Promise<Buffer> {
    const declared = header(request, 'content-length', 12);
    if (!/^\d+$/.test(declared) || Number(declared) < 24 ||
        Number(declared) > MAX_DEVICE_IMAGE_BYTES)
        throw new AtlasError('Invalid image size.', 'UPLOAD_TOO_LARGE');
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_DEVICE_IMAGE_BYTES || length > Number(declared))
            throw new AtlasError('Image is too large.', 'UPLOAD_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
    }
    if (length !== Number(declared))
        throw new AtlasError('Image length mismatch.', 'SHARE_INVALID');
    return Buffer.concat(chunks, length);
}
/** Native Node-only, 45-second, one-time binary image handoff. No browser
 * origins, credentials in URLs, persistent files, JSON/base64 bodies or CORS.
 */
export async function serveNodeImages(request: IncomingMessage, response: ServerResponse,
    services: Pick<ServerServices, 'imageRelay'>): Promise<boolean> {
    const upload = request.url === '/node/images/upload';
    const readId = /^\/node\/images\/([0-9a-fA-F-]{36})$/.exec(request.url ?? '')?.[1];
    if (!upload && !readId) return false;
    if (request.headers.origin !== undefined) { reply(response, 403, { error: 'ORIGIN_DENIED' }); return true; }
    if ((upload && request.method !== 'POST') || (readId && request.method !== 'GET')) {
        response.setHeader('allow', upload ? 'POST' : 'GET');
        reply(response, 405, { error: 'METHOD_NOT_ALLOWED' }); return true;
    }
    const relay = services.imageRelay;
    let release: (() => void) | undefined;
    try {
        const bearer = request.headers.authorization;
        if (typeof bearer !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,}$/.test(bearer)) {
            reply(response, 401, { error: 'NODE_AUTH_INVALID' }); return true;
        }
        const credential = bearer.slice(7);
        const nodeId = header(request, 'x-atlas-node-id', 36);
        if (!UUID.test(nodeId)) throw new AtlasError('Invalid Node ID.', 'INVALID_REQUEST');
        if (upload) {
            const targetId = header(request, 'x-atlas-target-id', 36);
            const deliveryId = header(request, 'x-atlas-delivery-id', 36);
            const mimeType = header(request, 'x-atlas-image-mime', 16);
            const sha256 = header(request, 'x-atlas-image-sha256', 64);
            if (!UUID.test(targetId) || !UUID.test(deliveryId) ||
                !/^[0-9a-f]{64}$/.test(sha256) ||
                !['image/png', 'image/jpeg'].includes(mimeType) ||
                request.headers['content-type'] !== 'application/octet-stream')
                throw new AtlasError('Invalid image metadata.', 'SHARE_INVALID');
            // Authenticate, verify live sender/receiver capabilities and grants,
            // and reserve capacity BEFORE reading any user-controlled binary.
            const admitted = await relay.admit(nodeId, targetId, credential);
            release = admitted.release;
            request.setTimeout(55_000, () => request.destroy());
            const bytes = await readImage(request);
            const receipt = await relay.deliver(admitted, {
                sourceId: nodeId, targetId, deliveryId, sha256,
                mimeType: mimeType as 'image/png' | 'image/jpeg', bytes,
            }, credential);
            reply(response, 200, receipt);
        } else {
            if (!UUID.test(readId!)) throw new AtlasError('Invalid image ID.', 'INVALID_REQUEST');
            const image = await relay.consume(readId!, nodeId, credential);
            response.writeHead(200, {
                'content-type': image.mimeType, 'content-length': image.bytes.length,
                'x-atlas-image-sha256': image.sha256, 'cache-control': 'no-store',
                'x-content-type-options': 'nosniff', 'content-disposition': 'attachment',
            });
            response.end(image.bytes);
        }
    } catch (error) {
        if (response.destroyed) return true;
        const known = error instanceof AtlasError;
        const code = known ? error.code : 'SHARE_UNAVAILABLE';
        const status = code === 'NODE_AUTH_INVALID' || code === 'NODE_REVOKED' ? 401
            : code === 'SHARE_DENIED' ? 403 : code === 'NOT_FOUND' ? 404
            : code === 'SHARE_REPLAY' || code === 'SHARE_BUSY' ? 409
            : code === 'UPLOAD_TOO_LARGE' ? 413 : known ? 400 : 503;
        reply(response, status, { error: code });
    } finally { release?.(); }
    return true;
}
