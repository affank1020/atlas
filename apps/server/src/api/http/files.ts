import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerServices } from '../../server/composition.js';
import type { FileOwner } from '../../server/atlas-files.js';
import { AtlasError } from '../../shared/errors.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 35 * 1024 * 1024;
const fileActions = new Set(['list', 'upload', 'upload-binary', 'download', 'archive']);
const BINARY_HEADERS = 'content-type,x-atlas-owner-kind,x-atlas-owner-id,x-atlas-file-name,x-atlas-file-type';

function sendJson(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(value));
}

async function parseJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
    if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? '')))
        throw new AtlasError('Files requests must use application/json.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBytes) throw new AtlasError('Files request exceeds the upload limit.');
        chunks.push(Buffer.from(chunk));
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AtlasError('Invalid Files JSON request.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new AtlasError('Invalid Files JSON request.');
    return parsed as Record<string, unknown>;
}

async function readBinaryUpload(request: IncomingMessage): Promise<{ owner: FileOwner; fileName: string; mimeType: string; bytes: Buffer }> {
    if (request.headers['content-type'] !== 'application/octet-stream')
        throw new AtlasError('Binary uploads must use application/octet-stream.');
    const header = (name: string, maxLength: number) => {
        const value = request.headers[name];
        if (typeof value !== 'string' || value.length === 0 || value.length > maxLength)
            throw new AtlasError('Invalid binary upload metadata.');
        return value;
    };
    const owner = readOwner({ kind: header('x-atlas-owner-kind', 20), id: header('x-atlas-owner-id', 120) });
    let fileName: string;
    try { fileName = decodeURIComponent(header('x-atlas-file-name', 1024)); }
    catch { throw new AtlasError('Invalid binary upload file name.'); }
    const mimeType = header('x-atlas-file-type', 120);
    const length = request.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_FILE_BYTES))
        throw new AtlasError('Files request exceeds the upload limit.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) throw new AtlasError('Files request exceeds the upload limit.');
        chunks.push(Buffer.from(chunk));
    }
    if (!size) throw new AtlasError('Binary upload cannot be empty.');
    return { owner, fileName, mimeType, bytes: Buffer.concat(chunks, size) };
}

function readOwner(input: unknown): FileOwner {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new AtlasError('A Files owner is required.');
    const value = input as Record<string, unknown>;
    if (!['project', 'workspace', 'application'].includes(String(value.kind)) || typeof value.id !== 'string')
        throw new AtlasError('Invalid Files owner.');
    return { kind: value.kind as FileOwner['kind'], id: value.id };
}

async function requireActiveOwner(owner: FileOwner, services: ServerServices) {
    if (owner.kind === 'project') {
        await services.catalog.getProject(owner.id);
    } else if (owner.kind === 'workspace') {
        const workspace = await services.workspaces.repository.getById(owner.id);
        if (workspace.status !== 'active') throw new AtlasError('Files owner not found.', 'NOT_FOUND');
    } else {
        // The v1 Files schema stores an application slug as the owner ID.
        // Fail closed if multiple projects register the same slug; otherwise
        // their bytes could become indistinguishable in the same owner scope.
        const matches = services.applications.listAll().filter(app => app.slug === owner.id);
        if (matches.length !== 1) throw new AtlasError('Files owner not found.', 'NOT_FOUND');
        if (matches[0]!.projectId) await services.catalog.getProject(matches[0]!.projectId);
    }
}

function safeFileId(input: unknown): string {
    if (typeof input !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input))
        throw new AtlasError('Invalid File ID.');
    return input;
}

/**
 * Private admin HTTP API, deliberately NOT available as MCP tools or under the
 * public Portfolio media URLs. Production /api/files/* is protected by
 * Caddy Basic Auth; Server binds only on VPS loopback/container networking.
 * Requests from a foreign web Origin are rejected to prevent Basic Auth CSRF.
 */
export async function serveFilesRequest(request: IncomingMessage, response: ServerResponse, services: ServerServices): Promise<boolean> {
    const action = /^\/api\/files\/([a-z-]+)$/.exec(request.url ?? '')?.[1];
    if (!action || !fileActions.has(action)) return false;

    const origin = request.headers.origin;
    const allowedOrigin = !!origin && services.config.workspace.origins.includes(origin);
    if (origin === 'null' || (origin && !allowedOrigin) ||
        (request.headers['sec-fetch-site'] === 'cross-site' && !allowedOrigin)) {
        sendJson(response, 403, { error: 'ORIGIN_DENIED' });
        return true;
    }
    // Browser-based localhost development can use an explicitly allowlisted
    // Vite origin. Never use a wildcard on private Files responses.
    if (allowedOrigin) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
        if (allowedOrigin) {
            response.setHeader('access-control-allow-methods', 'POST,OPTIONS');
            response.setHeader('access-control-allow-headers', BINARY_HEADERS);
        }
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
        return true;
    }
    if (request.method !== 'POST') {
        response.setHeader('allow', 'POST, OPTIONS');
        sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
    }
    try {
        if (action === 'upload-binary') {
            const input = await readBinaryUpload(request);
            await requireActiveOwner(input.owner, services);
            sendJson(response, 201, await services.files.upload({ ...input, visibility: 'private', client: 'Atlas Web' }));
            return true;
        }
        const body = await parseJson(request, action === 'upload' ? MAX_UPLOAD_BODY_BYTES : 4096);
        const owner = readOwner(body.owner);
        // Validate the owner exists before any storage lookup or upload.
        await requireActiveOwner(owner, services);
        if (action === 'list') {
            sendJson(response, 200, await services.files.list(owner));
        } else if (action === 'upload') {
            const encoded = body.base64;
            if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
                throw new AtlasError('Invalid or oversized Base64 file payload.');
            const bytes = Buffer.from(encoded, 'base64');
            if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== encoded)
                throw new AtlasError('Invalid or oversized Base64 file payload.');
            if (typeof body.fileName !== 'string' || typeof body.mimeType !== 'string')
                throw new AtlasError('File name and MIME type are required.');
            // The UI creates only private files; keep public exposure in a
            // separately reviewed publishing workflow.
            sendJson(response, 201, await services.files.upload({
                owner, fileName: body.fileName, mimeType: body.mimeType, bytes, visibility: 'private',
                client: 'Atlas Web',
            }));
        } else if (action === 'download') {
            const { file, bytes } = await services.files.download(owner, safeFileId(body.fileId));
            // Download is always an attachment: never render attacker-controlled
            // HTML/SVG/PDF with Atlas privileges.
            const asciiName = file.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'file';
            response.writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
                'content-length': bytes.length,
                'cache-control': 'private, no-store',
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'; sandbox",
                'referrer-policy': 'no-referrer',
            });
            response.end(bytes);
        } else {
            await services.files.archive(owner, safeFileId(body.fileId));
            sendJson(response, 200, { archived: true });
        }
    } catch (error) {
        const known = error instanceof AtlasError;
        sendJson(response, known ? (error.code === 'NOT_FOUND' ? 404 : 400) : 500, {
            error: known ? error.code : 'FILES_UNAVAILABLE',
            message: known ? error.message : 'Files operation failed.',
        });
    }
    return true;
}
