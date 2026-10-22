import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerServices } from '../../server/composition.js';
import { AtlasError } from '../../shared/errors.js';

// This Node-credential route is a one-time CONTROL-PLANE RESERVATION only.
// It does not authorize a host restart, call Node tools, or verify artifacts.
const PATH = '/node/update-intents/claim';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 2048;
const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(body));
};
async function readBounded(request: IncomingMessage): Promise<unknown> {
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BYTES))
        throw new AtlasError('Node update claim exceeds the input limit.');
    const parts: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
        total += chunk.length;
        if (total > MAX_BYTES) throw new AtlasError('Node update claim exceeds the input limit.');
        parts.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(parts, total).toString('utf8')); }
    catch { throw new AtlasError('Invalid Node update claim JSON.'); }
}

export async function serveNodeUpdateClaim(request: IncomingMessage, response: ServerResponse,
    services: Pick<ServerServices, 'identity' | 'nodes' | 'config'>): Promise<boolean> {
    if (request.url !== PATH) return false;
    // A request must never reserve an update until the root-only host
    // executor and independent approval process have been reviewed/deployed.
    if (!services.config.nodeUpdateClaims.enabled) {
        send(response, 404, { error: 'NOT_FOUND' }); return true;
    }
    if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
    }
    // No browser origin can claim Node intentions, even an allowed Web origin.
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
        if (request.headers['content-type'] !== 'application/json') {
            throw new AtlasError('Node update claims require application/json.');
        }
        const token = bearer.slice(7);
        // Authenticate before reading even the small request body.
        await services.identity.authenticate(nodeId, token);
        const input = await readBounded(request);
        if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new AtlasError('Invalid Node update claim.');
        const data = input as Record<string, unknown>;
        if (Object.keys(data).sort().join(',') !== 'expectedInstalledVersion,intentId,targetSha256' ||
            typeof data.intentId !== 'string' || !UUID.test(data.intentId) ||
            typeof data.expectedInstalledVersion !== 'string' ||
            typeof data.targetSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.targetSha256))
            throw new AtlasError('Invalid Node update claim.');
        if (!services.nodes.updateIntents) throw new AtlasError('Node update intent ledger is unavailable.', 'NODE_UNAVAILABLE');
        // The ledger re-authenticates under a transactional Node lock, then
        // consumes the request under an intent lock to race safely with cancel.
        const intent = await services.nodes.updateIntents.claim(
            nodeId, data.intentId, token, data.expectedInstalledVersion, data.targetSha256);
        send(response, 200, { intent });
    } catch (error) {
        if (response.destroyed) return true;
        const known = error instanceof AtlasError;
        const code = known ? error.code : 'NODE_UPDATE_UNAVAILABLE';
        const status = code === 'NODE_AUTH_INVALID' || code === 'NODE_REVOKED' ? 401 :
            code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' ? 409 :
            known && code !== 'NODE_UNAVAILABLE' ? 400 : 503;
        send(response, status, { error: code, message: known ? error.message : 'Node update claim unavailable.' });
    }
    return true;
}
