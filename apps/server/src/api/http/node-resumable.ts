import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerServices } from '../../server/composition.js';
import { AtlasError } from '../../shared/errors.js';
import { NODE_PART_BYTES } from '../../server/node-resumable-transfer.js';

const route = /^\/node\/files\/resumable\/(init|status|chunk|complete|abort)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(body));
};
function requiredHeader(request: IncomingMessage, name: string, max: number) {
    const value = request.headers[name];
    if (typeof value !== 'string' || value.length < 1 || value.length > max)
        throw new AtlasError('Invalid Node resumable transfer header.');
    return value;
}
async function boundedBody(request: IncomingMessage, max: number): Promise<Buffer> {
    const declared = request.headers['content-length'];
    if (declared !== undefined &&
        (!/^\d+$/.test(declared) || Number(declared) > max))
        throw new AtlasError('Node transfer request body is oversized.', 'UPLOAD_TOO_LARGE');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > max) throw new AtlasError('Node transfer request body is oversized.', 'UPLOAD_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks,size);
}

/** Feature flag and existing Node bearer auth guard every operation, including
 *  pre-body authorization for chunk writes. No CORS / admin Basic Auth. */
export async function serveNodeResumableRequest(request: IncomingMessage, response: ServerResponse,
    services: Pick<ServerServices, 'config' | 'nodeFileIngest' | 'nodeResumable'>): Promise<boolean> {
    const action = route.exec(request.url ?? '')?.[1];
    if (!action) return false;
    if (!services.config.nodeFiles.enabled) {
        send(response, 404, { error: 'NOT_FOUND' }); return true;
    }
    if (request.method !== 'POST') {
        response.setHeader('allow','POST');
        send(response,405,{ error: 'METHOD_NOT_ALLOWED' }); return true;
    }
    if (request.headers.origin !== undefined) {
        send(response,403,{ error: 'ORIGIN_DENIED' }); return true;
    }
    try {
        const auth = request.headers.authorization;
        if (typeof auth !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,}$/.test(auth)) {
            send(response,401,{ error: 'NODE_AUTH_INVALID' }); return true;
        }
        const input = {
            nodeId: requiredHeader(request,'x-atlas-node-id',36),
            workspaceId: requiredHeader(request,'x-atlas-workspace-id',36),
            uploadId: requiredHeader(request,'x-atlas-upload-id',36),
            credential: auth.slice(7),
        };
        if (![input.nodeId,input.workspaceId,input.uploadId].every(x=>UUID.test(x)))
            throw new AtlasError('Invalid Node resumable transfer identity.');
        // Verify the Node and current Workspace placement before accepting any
        // potentially large chunk bytes, including each retry.
        await services.nodeFileIngest.authorize(input.nodeId,input.credential,input.workspaceId);
        request.setTimeout(120_000,()=>request.destroy());
        if (action === 'chunk') {
            if (request.headers['content-type'] !== 'application/octet-stream')
                throw new AtlasError('Transfer chunks require application/octet-stream.');
            const indexHeader = requiredHeader(request,'x-atlas-part-index',2);
            if (!/^(0|[1-9]\d?)$/.test(indexHeader))
                throw new AtlasError('Invalid chunk index.');
            const checksum = requiredHeader(request,'x-atlas-part-sha256',64);
            const bytes = await boundedBody(request,NODE_PART_BYTES);
            const result = await services.nodeResumable.chunk({ ...input, index: Number(indexHeader), checksum, bytes });
            send(response,result.replayed ? 200 : 201,result);
        } else {
            if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(String(request.headers['content-type'] ?? '')))
                throw new AtlasError('Node transfer control requests require JSON.');
            const raw = await boundedBody(request,4096);
            let data: unknown;
            try { data=JSON.parse(raw.toString('utf8')); }
            catch { throw new AtlasError('Invalid Node transfer JSON.'); }
            if (!data || typeof data !== 'object' || Array.isArray(data))
                throw new AtlasError('Invalid Node transfer JSON.');
            if (action === 'init') {
                const value = data as Record<string,unknown>;
                if (typeof value.fileName !== 'string' || typeof value.mimeType !== 'string' ||
                    typeof value.checksum !== 'string' || typeof value.byteSize !== 'number')
                    throw new AtlasError('Invalid Node transfer initialization fields.');
                send(response,200,await services.nodeResumable.init({ ...input, fileName: value.fileName,
                    mimeType: value.mimeType,checksum:value.checksum,byteSize:value.byteSize }));
            } else if (action === 'status') {
                send(response,200,await services.nodeResumable.status(input));
            } else if (action === 'complete') {
                send(response,200,await services.nodeResumable.complete(input));
            } else {
                send(response,200,await services.nodeResumable.abort(input));
            }
        }
    } catch (error) {
        if (response.destroyed) return true;
        const known = error instanceof AtlasError;
        const status = !known ? 500 : error.code === 'NODE_AUTH_INVALID' || error.code === 'NODE_REVOKED'
            ? 401 : error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409
            : error.code === 'QUOTA_EXCEEDED' ? 507 : error.code === 'UPLOAD_TOO_LARGE' ? 413 : 400;
        send(response,status,{ error: known ? error.code : 'NODE_TRANSFER_UNAVAILABLE',
            message: known ? error.message : 'Node resumable transfer failed.' });
    }
    return true;
}
