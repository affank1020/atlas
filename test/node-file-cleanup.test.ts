import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { AtlasFilesService } from '../apps/server/src/server/atlas-files.js';
import { NodeFileIngestService } from '../apps/server/src/server/node-file-ingest.js';
import { R2ObjectStore } from '../apps/server/src/server/file-storage.js';

after(cleanupDatabases);

test('Failed receipt insert reclaims object after rollback and stable retry succeeds', async () => {
    const fixture = await databaseFixture();
    const db = fixture.store.pool;
    const identity = new NodeIdentity(db);
    const ticket = await identity.ticket();
    const node = await identity.enrol({ token: ticket.enrolmentToken, name: 'Failure Node', platform: 'test' });
    const workspaceId = randomUUID();
    await db.query("INSERT INTO logical_workspaces(id,name) VALUES($1,'Upload Recovery')", [workspaceId]);
    await db.query(`INSERT INTO workspaces(id,name,root_path,kind,adapter,node_id,logical_workspace_id)
        VALUES($1,'Upload Recovery','/recovery','generic',NULL,$2,$1)`, [workspaceId, node.nodeId]);
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-node-cleanup-'));
    const files = new AtlasFilesService(fixture.databaseUrl, root);
    const ingest = new NodeFileIngestService(db, identity, files);
    const input = { nodeId: node.nodeId, credential: node.credential, workspaceId,
        uploadId: randomUUID(), fileName: 'capture.png', mimeType: 'image/png', bytes: Buffer.from('png bytes') };
    try {
        await db.query(`CREATE FUNCTION reject_node_receipt() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt error'; END $$`);
        await db.query(`CREATE TRIGGER fail_receipt BEFORE INSERT ON node_file_upload_receipts
            FOR EACH ROW EXECUTE FUNCTION reject_node_receipt()`);
        await assert.rejects(ingest.ingest(input), /injected receipt error/);
        assert.deepEqual(await files.list({ kind: 'workspace', id: workspaceId }), []);
        assert.deepEqual(await readdir(root), [], 'rolled-back file bytes must be removed');

        await db.query('DROP TRIGGER fail_receipt ON node_file_upload_receipts');
        const saved = await ingest.ingest(input);
        assert.equal(saved.replayed, false);
        assert.equal((await readdir(root)).length, 1);
        const replay = await ingest.ingest(input);
        assert.equal(replay.replayed, true);
        assert.equal(replay.file.id, saved.file.id);
        assert.equal((await readdir(root)).length, 1);
    } finally { await files.close(); await rm(root, { recursive: true, force: true }); }
});

test('Failed Files metadata insert removes object even before a Node receipt exists', async () => {
    const fixture = await databaseFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-files-insert-failure-'));
    const files = new AtlasFilesService(fixture.databaseUrl, root);
    try {
        await fixture.store.pool.query(`CREATE FUNCTION reject_file_metadata() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected metadata error'; END $$`);
        await fixture.store.pool.query(`CREATE TRIGGER fail_file_metadata BEFORE INSERT ON atlas_files
            FOR EACH ROW EXECUTE FUNCTION reject_file_metadata()`);
        await assert.rejects(files.upload({ owner: { kind: 'application', id: 'portfolio' },
            fileName: 'capture.png', mimeType: 'image/png', bytes: Buffer.from('png bytes') }),
            /injected metadata error/);
        assert.deepEqual(await readdir(root), [], 'failed metadata write must not leak object bytes');
    } finally { await files.close(); await rm(root, { recursive: true, force: true }); }
});

test('R2 cleanup signs DELETE requests against the same server-generated object key', async () => {
    const seen: Array<{ url: string; method?: string; headers?: HeadersInit }> = [];
    const store = new R2ObjectStore({
        endpoint: 'https://0123456789abcdef.r2.cloudflarestorage.com',
        bucket: 'atlas-files', accessKeyId: 'test-access', secretAccessKey: 'test-secret',
    }, (async (url, init) => {
        seen.push({ url: String(url), method: init?.method, headers: init?.headers });
        return new Response(null, { status: 204 });
    }) as typeof fetch);
    const key = 'files-' + 'a'.repeat(32) + '-' + 'b'.repeat(64);
    await store.delete(key);
    assert.equal(seen[0]?.method, 'DELETE');
    assert.match(seen[0]?.url ?? '', /\/atlas-files\/files-a{32}-b{64}$/);
    assert.match((seen[0]?.headers as Record<string, string>)?.authorization ?? '',
        /^AWS4-HMAC-SHA256 Credential=test-access\//);
    assert.ok(!JSON.stringify(seen).includes('test-secret'));
    await assert.rejects(store.delete('../not-valid'), /Invalid Atlas media object key/);
});
