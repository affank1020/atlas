import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerServices } from '../../server/composition.js';
import { AtlasError } from '../../shared/errors.js';

// Native Node-credential observations are NEVER host-root attestations.
// This route cannot change, resolve or unblock a claimed update.
const PATH = '/node/update-intents/report';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(body));
};
async function boundedJson(request: IncomingMessage) {
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > 2048))
        throw new AtlasError('Update observation too large.', 'INVALID_INPUT');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 2048) throw new AtlasError('Update observation too large.', 'INVALID_INPUT');
        chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { throw new AtlasError('Invalid update observation JSON.', 'INVALID_INPUT'); }
}
export async function serveNodeUpdateReport(request: IncomingMessage, response: ServerResponse,
    services: Pick<ServerServices, 'identity' | 'nodes' | 'config'>): Promise<boolean> {
    if (request.url !== PATH) return false;
    if (!services.config.nodeUpdateClaims.enabled) {
        send(response, 404, { error: 'NOT_FOUND' }); return true;
    }
    if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        send(response, 405, { error: 'METHOD_NOT_ALLOWED' }); return true;
    }
    if (request.headers.origin !== undefined) {
        send(response, 403, { error: 'ORIGIN_DENIED' }); return true;
    }
    try {
        const bearer = request.headers.authorization;
        const nodeId = request.headers['x-atlas-node-id'];
        if (typeof bearer !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,}$/.test(bearer) ||
            typeof nodeId !== 'string' || !UUID.test(nodeId)) {
            send(response, 401, { error: 'NODE_AUTH_INVALID' }); return true;
        }
        if (request.headers['content-type'] !== 'application/json')
            throw new AtlasError('Update observations require application/json.', 'INVALID_INPUT');
        const token = bearer.slice(7);
        await services.identity.authenticate(nodeId, token);
        const data = await boundedJson(request);
        if (!data || typeof data !== 'object' || Array.isArray(data))
            throw new AtlasError('Invalid update observation.', 'INVALID_INPUT');
        const input = data as Record<string, unknown>;
        if (Object.keys(input).sort().join(',') !== 'intentId,reportedState,targetSha256' ||
            typeof input.intentId !== 'string' || !UUID.test(input.intentId) ||
            typeof input.targetSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.targetSha256) ||
            (input.reportedState !== 'activated' && input.reportedState !== 'requires_reconciliation'))
            throw new AtlasError('Invalid update observation.', 'INVALID_INPUT');
        const ledger = services.nodes.updateIntents;
        if (!ledger) throw new AtlasError('Node update intent ledger unavailable.', 'NODE_UNAVAILABLE');
        const report = await ledger.report(nodeId, input.intentId, token,
            input.targetSha256, input.reportedState);
        send(response, 200, { report });
    } catch (error) {
        if (response.destroyed) return true;
        const known = error instanceof AtlasError;
        const code = known ? error.code : 'NODE_UPDATE_UNAVAILABLE';
        const status = code === 'NODE_AUTH_INVALID' || code === 'NODE_REVOKED' ? 401 :
            code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' ? 409 :
            known && code !== 'NODE_UNAVAILABLE' ? 400 : 503;
        send(response, status, { error: code, message: known ? error.message : 'Node update observation unavailable.' });
    }
    return true;
}
