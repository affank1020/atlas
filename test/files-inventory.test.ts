import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import type { Pool } from 'pg';
import { R2ObjectStore } from '../apps/server/src/server/file-storage.js';
import { auditAtlasFiles, scanR2Files, scanLocalFiles } from '../apps/server/src/server/files-inventory.js';

const key = (a: string, b: string) => 'files-' + a.repeat(32) + '-' + b.repeat(64);
const old = new Date('2026-10-01T00:00:00.000Z');
const now = new Date('2026-10-21T00:00:00.000Z');

test('Local inventory is read-only, ignores unsafe entries, and detects old unreferenced objects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-file-audit-'));
    const committed = key('a', 'b'), orphan = key('c', 'd'), recent = key('e', 'f');
    try {
        for (const name of [committed, orphan, recent]) {
            await writeFile(path.join(root, name), 'hello');
            await utimes(path.join(root, name), name === recent ? now : old, name === recent ? now : old);
        }
        await writeFile(path.join(root, 'portfolio-media.jpg'), 'not atlas files');
        await symlink(path.join(root, orphan), path.join(root, key('1', '2')));
        const sqlCalls: string[] = [];
        const pool = { query: async (sql: string, params: unknown[]) => {
            sqlCalls.push(sql);
            const values = params[0] as string[];
            return { rows: values.includes(committed) ? [{ storage_key: committed }] : [] };
        } } as unknown as Pick<Pool, 'query'>;
        const report = await auditAtlasFiles({ pool, localRoot: root, now });
        assert.equal(report.mode, 'dry-run');
        assert.equal(report.noDeletion, true);
        assert.equal(report.local.scanned, 3);
        assert.equal(report.local.referenced, 1);
        assert.equal(report.local.recentUnreferenced, 1);
        assert.equal(report.local.candidateOrphans, 1);
        assert.equal(report.local.candidateBytes, 5);
        assert.deepEqual(report.local.candidates.map(x => x.key), [orphan]);
        assert.deepEqual(report.r2, { state: 'not_configured' });
        assert.ok(sqlCalls.every(x => /^SELECT storage_key FROM atlas_files/.test(x)));
        const bounded = await scanLocalFiles(root, 1);
        assert.equal(bounded.objects.length, 1);
        assert.equal(bounded.truncated, true);
        assert.equal((await scanLocalFiles(path.join(root, 'absent'), 10)).truncated, false);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('R2 inventory signs ListObjectsV2, safely paginates and preserves opaque continuation token', async () => {
    const recorded: Array<{ url: URL; headers: Record<string, string> }> = [];
    const one = key('a', '1'), two = key('b', '2');
    const xml = (content: string, truncated: boolean, token = '') =>
        '<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        content + '<IsTruncated>' + truncated + '</IsTruncated>' +
        (token ? '<NextContinuationToken>' + token + '</NextContinuationToken>' : '') +
        '</ListBucketResult>';
    const content = (name: string) => '<Contents><Key>' + name + '</Key><Size>5</Size>' +
        '<LastModified>2026-10-01T00:00:00Z</LastModified></Contents>';
    const requester = (async (url: string | URL | Request, init?: RequestInit) => {
        const parsed = new URL(String(url));
        recorded.push({ url: parsed, headers: init?.headers as Record<string, string> });
        assert.equal(init?.method, 'GET');
        const cursor = parsed.searchParams.get('continuation-token');
        return new Response(cursor === null
            ? xml(content(one), true, 'token&amp;2')
            : xml(content(two), false), { status: 200 });
    }) as typeof fetch;
    const r2 = new R2ObjectStore({ endpoint: 'https://0123456789abcdef.r2.cloudflarestorage.com',
        bucket: 'atlas-files', accessKeyId: 'key', secretAccessKey: 'secret' }, requester);
    const inventory = await scanR2Files(r2, 4);
    assert.equal(inventory.truncated, false);
    assert.deepEqual(inventory.objects.map(x => x.key), [one, two]);
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0]?.url.pathname, '/atlas-files');
    assert.equal(recorded[0]?.url.searchParams.get('prefix'), 'files-');
    assert.equal(recorded[0]?.url.searchParams.get('list-type'), '2');
    assert.equal(recorded[1]?.url.searchParams.get('continuation-token'), 'token&2');
    assert.match(recorded[1]!.headers.authorization, /^AWS4-HMAC-SHA256 Credential=key\//);
    const firstPageOnly = await scanR2Files(r2, 1);
    assert.equal(firstPageOnly.truncated, true);
    assert.equal(firstPageOnly.objects.length, 1);
});

test('Inventory refuses unbounded scans, malformed R2 responses, and database errors', async () => {
    await assert.rejects(scanR2Files({ listFilesPage: async () => ({ objects: [], nextToken: 'same' }) }, 5001), /limit/);
    await assert.rejects(scanR2Files({ listFilesPage: async () => ({ objects: [], nextToken: 'same' }) }, 2), /repeated/);
    const store = new R2ObjectStore({ endpoint: 'https://0123456789abcdef.r2.cloudflarestorage.com',
        bucket: 'atlas-files', accessKeyId: 'key', secretAccessKey: 'secret' },
        (async () => new Response('<h1>not XML</h1>', { status: 200 })) as typeof fetch);
    await assert.rejects(store.listFilesPage(), /Unexpected R2 inventory response/);
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-file-audit-db-'));
    try {
        const name = key('a', 'b');
        await writeFile(path.join(root, name), 'abc');
        await utimes(path.join(root, name), old, old);
        const failing = { query: async () => { throw new Error('database unavailable'); } } as unknown as Pick<Pool, 'query'>;
        await assert.rejects(auditAtlasFiles({ pool: failing, localRoot: root, now }), /database unavailable/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
