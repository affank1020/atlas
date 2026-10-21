import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { serveFilesRequest } from '../apps/server/src/api/http/files.js';
import type { ServerServices } from '../apps/server/src/server/composition.js';
import { AtlasError } from '../apps/server/src/shared/errors.js';

const projectId = randomUUID();
const differentProject = randomUUID();
const origin = 'https://atlas.example.test';

test('private Files HTTP API is owner-scoped and denies untrusted origins', async () => {
    const entries = new Map<string, { name: string; bytes: Buffer }>();
    const requests: string[] = [];
    const appSlugs = ['portfolio'];
    const services = {
        config: { workspace: { origins: [origin] } },
        catalog: { getProject: async (id: string) => {
            requests.push('project:' + id);
            if (id !== projectId) throw new AtlasError('Project not found.', 'NOT_FOUND');
            return { id };
        } },
        workspaces: { repository: { getById: async () => { throw new AtlasError('Workspace not found.', 'NOT_FOUND'); } } },
        applications: { listAll: () => appSlugs.map(slug => ({ slug })) },
        files: {
            list: async (owner: { kind: string; id: string }) =>
                owner.id === projectId ? [...entries].map(([id, item]) => ({ id, fileName: item.name, byteSize: item.bytes.length })) : [],
            upload: async (input: { owner: { id: string }; fileName: string; bytes: Buffer; visibility: string }) => {
                assert.equal(input.visibility, 'private');
                const id = randomUUID();
                entries.set(id, { name: input.fileName, bytes: input.bytes });
                return { id, fileName: input.fileName, byteSize: input.bytes.length, visibility: input.visibility };
            },
            download: async (owner: { id: string }, id: string) => {
                const item = entries.get(id);
                if (!item || owner.id !== projectId) throw new AtlasError('Not found.', 'NOT_FOUND');
                return { file: { fileName: item.name }, bytes: item.bytes };
            },
            archive: async (owner: { id: string }, id: string) => {
                if (owner.id !== projectId || !entries.delete(id)) throw new AtlasError('Not found.', 'NOT_FOUND');
            },
        },
    } as unknown as ServerServices;
    const server = createServer((req, res) => { void serveFilesRequest(req, res, services); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (action: string, body: object, headers: Record<string, string> = {}) =>
        fetch(`${url}/api/files/${action}`, {
            method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers },
            body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
        });
    const owner = { kind: 'project', id: projectId };
    try {
        const denied = await post('list', { owner }, { origin: 'https://evil.example' });
        assert.equal(denied.status, 403);
        assert.deepEqual(await denied.json(), { error: 'ORIGIN_DENIED' });
        assert.equal((await post('list', { owner }, { origin: 'null' })).status, 403);
        assert.equal((await post('list', { owner }, { origin: '', 'sec-fetch-site': 'cross-site' })).status, 403);
        assert.equal(requests.length, 0, 'origin is rejected before querying metadata');
        assert.equal((await post('list', { owner: { kind: 'project', id: differentProject } })).status, 404);
        assert.equal((await post('list', { owner: { kind: 'workspace', id: randomUUID() } })).status, 404);
        assert.equal((await post('list', { owner: { kind: 'application', id: 'unknown' } })).status, 404);
        appSlugs.push('portfolio');
        assert.equal((await post('list', { owner: { kind: 'application', id: 'portfolio' } })).status, 404,
            'duplicate application slugs cannot share a Files owner');
        appSlugs.pop();

        // The binary path is used by Atlas Web and can later be reused by a
        // separately authenticated mobile transfer service.
        const preflight = await fetch(`${url}/api/files/upload-binary`, {
            method: 'OPTIONS',
            headers: { origin, 'access-control-request-method': 'POST',
                'access-control-request-headers': 'x-atlas-owner-kind,x-atlas-file-name,content-type' },
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
        assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /x-atlas-file-name/);
        const badPreflight = await fetch(`${url}/api/files/upload-binary`, {
            method: 'OPTIONS', headers: { origin: 'https://evil.example' },
        });
        assert.equal(badPreflight.status, 403);
        assert.equal(badPreflight.headers.get('access-control-allow-origin'), null);

        const binary = Buffer.from([0, 1, 128, 255, 3, 12]);
        const binaryHeaders = {
            origin, 'content-type': 'application/octet-stream',
            'x-atlas-owner-kind': owner.kind, 'x-atlas-owner-id': owner.id,
            'x-atlas-file-name': encodeURIComponent('photo 1.png'),
            'x-atlas-file-type': 'image/png', 'x-atlas-visibility': 'public',
        };
        const binaryUpload = await fetch(`${url}/api/files/upload-binary`, {
            method: 'POST', headers: binaryHeaders, body: binary,
        });
        assert.equal(binaryUpload.status, 201);
        const binaryFile = await binaryUpload.json() as { id: string; visibility: string };
        assert.equal(binaryFile.visibility, 'private');
        assert.deepEqual(Buffer.from(await (await post('download', { owner, fileId: binaryFile.id })).arrayBuffer()), binary);

        // Regression: valid Unicode names can expand past the old 1024-character
        // header limit, while still fitting the service's 255-character name limit.
        const unicodeName = '漢'.repeat(251) + '.png';
        assert.equal(unicodeName.length, 255);
        assert.ok(encodeURIComponent(unicodeName).length > 1024);
        const unicodeResponse = await fetch(`${url}/api/files/upload-binary`, {
            method: 'POST',
            headers: { ...binaryHeaders, 'x-atlas-file-name': encodeURIComponent(unicodeName) },
            body: binary,
        });
        assert.equal(unicodeResponse.status, 201);
        const unicodeFile = await unicodeResponse.json() as { id: string; fileName: string };
        assert.equal(unicodeFile.fileName, unicodeName);
        assert.deepEqual(Buffer.from(await (await post('download', { owner, fileId: unicodeFile.id })).arrayBuffer()), binary);
        assert.equal((await fetch(`${url}/api/files/upload-binary`, {
            method: 'POST', headers: { ...binaryHeaders, 'x-atlas-file-name': '%invalid' }, body: binary,
        })).status, 400);
        assert.equal((await fetch(`${url}/api/files/upload-binary`, {
            method: 'POST', headers: { ...binaryHeaders, 'x-atlas-owner-id': differentProject }, body: binary,
        })).status, 404);
        assert.equal((await fetch(`${url}/api/files/upload-binary`, {
            method: 'POST', headers: { ...binaryHeaders, 'content-type': 'text/plain' }, body: binary,
        })).status, 400);
        assert.equal((await fetch(`${url}/api/files/upload-binary`, {
            method: 'POST', headers: binaryHeaders, body: Buffer.alloc(0),
        })).status, 400);
        assert.equal((await fetch(`${url}/api/files/upload-binary`, {
            method: 'POST', headers: binaryHeaders, body: Buffer.alloc(25 * 1024 * 1024 + 1),
        })).status, 400);

        const content = Buffer.from('<script>not executed</script>');
        const uploaded = await post('upload', { owner, fileName: 'research.pdf', mimeType: 'application/pdf', base64: content.toString('base64'), visibility: 'public' });
        assert.equal(uploaded.status, 201);
        const file = await uploaded.json() as { id: string; visibility: string };
        assert.equal(file.visibility, 'private', 'client cannot request public visibility');
        assert.equal((await (await post('list', { owner })).json() as unknown[]).length, 3);
        const result = await post('download', { owner, fileId: file.id });
        assert.equal(result.status, 200);
        assert.equal(result.headers.get('content-type'), 'application/octet-stream');
        assert.match(result.headers.get('content-disposition') ?? '', /^attachment;/);
        assert.equal(result.headers.get('cache-control'), 'private, no-store');
        assert.deepEqual(Buffer.from(await result.arrayBuffer()), content);
        assert.equal((await post('download', { owner, fileId: randomUUID() })).status, 404);
        assert.equal((await post('upload', { owner, fileName: 'invalid', mimeType: 'text/plain', base64: '%%%'})).status, 400);
        assert.equal((await post('archive', { owner, fileId: file.id })).status, 200);
        assert.equal((await post('archive', { owner, fileId: binaryFile.id })).status, 200);
        assert.equal((await post('archive', { owner, fileId: unicodeFile.id })).status, 200);
        assert.equal((await (await post('list', { owner })).json() as unknown[]).length, 0);
        assert.equal((await post('download', { owner, fileId: file.id })).status, 404);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
