import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test, { after } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { AtlasFilesService } from '../apps/server/src/server/atlas-files.js';
import { NodeFileIngestService } from '../apps/server/src/server/node-file-ingest.js';
import { serveNodeFileUpload } from '../apps/server/src/api/http/node-files.js';
import { uploadNodeFileOnce } from '../apps/node/src/core/file-transfer.js';
import type { ServerServices } from '../apps/server/src/server/composition.js';

after(cleanupDatabases);

test('Node-native Files uploads enforce identity, Workspace ownership and idempotent retries', async () => {
    const fixture = await databaseFixture();
    const identity = new NodeIdentity(fixture.store.pool);
    const ticket = await identity.ticket();
    const node = await identity.enrol({ token: ticket.enrolmentToken, name: 'Test Mobile', platform: 'ios' });
    const another = await identity.ticket();
    const other = await identity.enrol({ token: another.enrolmentToken, name: 'Other Phone', platform: 'android' });
    const project = await fixture.catalog.createProject({ name: 'Private Screenshots' });
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const db = fixture.store.pool;
    await db.query(`INSERT INTO workspaces(id,project_id,name,root_path,kind,adapter,node_id)
        VALUES($1,$2,'Mobile','/mobile','generic',NULL,$3),($4,$2,'Other','/other','generic',NULL,$5)`,
        [workspaceId, project.id, node.nodeId, otherWorkspaceId, other.nodeId]);
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-node-files-'));
    const files = new AtlasFilesService(fixture.databaseUrl, root);
    const ingest = new NodeFileIngestService(db, identity, files);
    const services = { config: { nodeFiles: { enabled: true } }, nodeFileIngest: ingest } as ServerServices;
    const server = createServer((req, res) => { void serveNodeFileUpload(req, res, services); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/node/files/upload`;
    const uploadId = randomUUID();
    const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const headers = {
        authorization: `Bearer ${node.credential}`,
        'content-type': 'application/octet-stream',
        'x-atlas-node-id': node.nodeId,
        'x-atlas-workspace-id': workspaceId,
        'x-atlas-upload-id': uploadId,
        'x-atlas-file-name': encodeURIComponent('screenshot 🌍.png'),
        'x-atlas-file-type': 'image/png',
    };
    const post = (changes: Record<string, string> = {}, body: Buffer = screenshot) =>
        fetch(url, { method: 'POST', headers: { ...headers, ...changes }, body, signal: AbortSignal.timeout(10000) });
    try {
        const first = await post();
        assert.equal(first.status, 201);
        const firstResult = await first.json() as { file: { id: string; visibility: string; checksum: string }; replayed: boolean };
        assert.equal(firstResult.replayed, false);
        assert.equal(firstResult.file.visibility, 'private');
        assert.equal((await files.list({ kind: 'workspace', id: workspaceId })).length, 1);
        assert.deepEqual((await files.download({ kind: 'workspace', id: workspaceId }, firstResult.file.id)).bytes, screenshot);

        const replay = await post();
        assert.equal(replay.status, 200);
        assert.equal((await replay.json() as typeof firstResult).file.id, firstResult.file.id);
        assert.equal((await files.list({ kind: 'workspace', id: workspaceId })).length, 1);
        assert.equal((await post({}, Buffer.from('different'))).status, 409);
        assert.equal((await post({ 'x-atlas-workspace-id': otherWorkspaceId })).status, 404);
        assert.equal((await post({ 'x-atlas-node-id': other.nodeId })).status, 401);
        assert.equal((await post({ origin: 'https://atlas.example.test' })).status, 403);
        assert.equal((await post({ authorization: 'Bearer invalid' })).status, 401);
        assert.equal((await post({ 'x-atlas-upload-id': 'nonuuid' })).status, 400);
        assert.equal((await post({ 'x-atlas-file-name': '%broken', 'x-atlas-upload-id': randomUUID() })).status, 400);

        const disabled = { config: { nodeFiles: { enabled: false } }, nodeFileIngest: ingest } as ServerServices;
        const guardedServer = createServer((req, res) => { void serveNodeFileUpload(req, res, disabled); });
        guardedServer.listen(0, '127.0.0.1');
        await once(guardedServer, 'listening');
        try {
            const blocked = await fetch(`http://127.0.0.1:${(guardedServer.address() as AddressInfo).port}/node/files/upload`,
                { method: 'POST', headers, body: screenshot });
            assert.equal(blocked.status, 404);
        } finally {
            guardedServer.closeAllConnections();
            await new Promise<void>(resolve => guardedServer.close(() => resolve()));
        }

        // New uploads cannot be accepted after a credential rotation.
        await identity.ticket(node.nodeId, true);
        assert.equal((await post({ 'x-atlas-upload-id': randomUUID() })).status, 401);
        assert.equal((await files.list({ kind: 'workspace', id: workspaceId })).length, 1);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await files.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('Node-native Files cannot exceed a Workspace quota, including archived bytes', async () => {
    const fixture = await databaseFixture();
    const identity = new NodeIdentity(fixture.store.pool);
    const ticket = await identity.ticket();
    const node = await identity.enrol({ token: ticket.enrolmentToken, name: 'Quota Node', platform: 'test' });
    const workspaceId = randomUUID();
    await fixture.store.pool.query(`INSERT INTO workspaces(id,name,root_path,kind,adapter,node_id)
        VALUES($1,'Quota','/quota','generic',NULL,$2)`, [workspaceId, node.nodeId]);
    const fakeId = randomUUID(), fakeKey = 'files-' + fakeId.replaceAll('-', '') + '-' + 'a'.repeat(64);
    await fixture.store.pool.query(`INSERT INTO atlas_files(id,owner_kind,owner_id,storage_key,checksum,file_name,mime_type,byte_size,visibility,status,created_by)
        VALUES($1,'workspace',$2,$3,$4,'retained.bin','application/octet-stream',$5,'private','archived','test')`,
        [fakeId, workspaceId, fakeKey, 'a'.repeat(64), 1024 * 1024 * 1024]);
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-node-quota-'));
    const files = new AtlasFilesService(fixture.databaseUrl, root);
    try {
        const ingest = new NodeFileIngestService(fixture.store.pool, identity, files);
        await assert.rejects(ingest.ingest({ nodeId: node.nodeId, credential: node.credential, workspaceId,
            uploadId: randomUUID(), fileName: 'test.png', mimeType: 'image/png', bytes: Buffer.from('x') }),
            (error: any) => error.code === 'QUOTA_EXCEEDED');
        assert.equal((await files.list({ kind: 'workspace', id: workspaceId })).length, 0);
    } finally {
        await files.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('Node transfer helper sends raw bytes to HTTPS using a stable retry UUID', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        return new Response(JSON.stringify({ file: { id: randomUUID(), checksum: 'a'.repeat(64) }, replayed: false }), { status: 201 });
    }) as typeof fetch;
    const input = { serverUrl: 'wss://atlas.example.com/node/connect', nodeId: randomUUID(),
        credential: 'c'.repeat(43), workspaceId: randomUUID(), uploadId: randomUUID(),
        fileName: 'mobile 🏞.png', mimeType: 'image/png', bytes: new Uint8Array([0, 128, 255]) };
    await uploadNodeFileOnce(input, fakeFetch);
    assert.equal(calls[0]?.url, 'https://atlas.example.com/node/files/upload');
    assert.equal((calls[0]?.init.headers as Record<string, string>)['x-atlas-upload-id'], input.uploadId);
    assert.equal((calls[0]?.init.headers as Record<string, string>)['x-atlas-file-name'], encodeURIComponent(input.fileName));
    assert.deepEqual(calls[0]?.init.body, input.bytes);
    await assert.rejects(uploadNodeFileOnce({ ...input, serverUrl: 'ws://atlas.example.com/node/connect' }, fakeFetch), /HTTPS/);
    await assert.rejects(uploadNodeFileOnce({ ...input, serverUrl: 'wss://atlas.example.com/not-a-node' }, fakeFetch), /WebSocket/);
    await assert.rejects(uploadNodeFileOnce({ ...input, uploadId: 'oops' }, fakeFetch), /stable upload UUID/);
});
