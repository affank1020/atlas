import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { R2ObjectStore } from '../apps/server/src/server/file-storage.js';
import { AtlasFilesService } from '../apps/server/src/server/atlas-files.js';
import { createDispatcher } from '../apps/server/src/server/dispatch.js';

const projectId = '54b51649-1be2-4c54-bb15-11c825939a6f';
const otherProject = 'ce09dbe0-0755-4bd8-9376-e4a3152d59f7';
const fileId = 'e0aa1111-2222-4333-8444-555555555555';
const key = 'projects/' + projectId + '/objects/' + fileId + '/v1';
const r2 = {
    endpoint: 'https://0123456789abcdef.r2.cloudflarestorage.com',
    bucket: 'atlas-files', accessKeyId: 'test-access-id', secretAccessKey: 'test-secret',
};
const authorized = { kind: 'mcp-oauth' as const, subject: 'owner', issuer: 'https://issuer.example/' };

test('short-lived R2 URL is a valid, bounded SigV4 GET capability (no byte transfer)', () => {
    const now = new Date('2026-11-09T12:34:56.000Z');
    const { url, expiresAt } = new R2ObjectStore(r2).presignGet(key, 120, now);
    const parsed = new URL(url);
    assert.equal(parsed.protocol, 'https:');
    assert.equal(parsed.pathname, '/atlas-files/' + key);
    assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(parsed.searchParams.get('X-Amz-Date'), '20261109T123456Z');
    assert.equal(parsed.searchParams.get('X-Amz-Expires'), '120');
    assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
    assert.equal(expiresAt, '2026-11-09T12:36:56.000Z');
    assert.doesNotMatch(url, /test-secret|Authorization/i);

    // Verify the signature independently from the R2 adapter's implementation.
    const params = new URLSearchParams(parsed.search);
    const sig = params.get('X-Amz-Signature');
    assert.match(sig ?? '', /^[a-f0-9]{64}$/);
    params.delete('X-Amz-Signature');
    const canonicalQuery = [...params.entries()].sort(([a],[b]) => a.localeCompare(b))
        .map(([a,b]) => encodeURIComponent(a) + '=' + encodeURIComponent(b)).join('&');
    const digest = (x: string) => createHash('sha256').update(x).digest('hex');
    const canonical = ['GET', parsed.pathname, canonicalQuery, 'host:' + parsed.host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const scope = '20261109/auto/s3/aws4_request';
    const toSign = ['AWS4-HMAC-SHA256', '20261109T123456Z', scope, digest(canonical)].join('\n');
    const hmac = (k: string | Buffer, v: string) => createHmac('sha256', k).update(v).digest();
    const signingKey = hmac(hmac(hmac(hmac('AWS4' + r2.secretAccessKey, '20261109'), 'auto'), 's3'), 'aws4_request');
    assert.equal(sig, createHmac('sha256', signingKey).update(toSign).digest('hex'));
});

test('R2 signing rejects unsafe keys, invalid expiry and invalid dates', () => {
    const signer = new R2ObjectStore(r2);
    assert.throws(() => signer.presignGet('../secrets'), /Invalid Atlas media object key/);
    assert.throws(() => signer.presignGet(key, 0), /expiry/);
    assert.throws(() => signer.presignGet(key, 301), /expiry/);
    assert.throws(() => signer.presignGet(key, 10, new Date(NaN)), /expiry/);
});

test('private file MCP dispatch rejects unauthenticated and Relay callers', async () => {
    let touched = false;
    const dispatch = createDispatcher({
        catalog: { getProject: async () => { touched = true; } },
        files: { listProjectPage: async () => { touched = true; }, projectDownloadLink: async () => { touched = true; } },
        diagnostics: { record: () => undefined },
    } as unknown as Parameters<typeof createDispatcher>[0]);
    for (const action of ['list_project_files', 'get_project_file']) {
        for (const caller of [undefined, { kind: 'relay' }]) {
            await assert.rejects(dispatch(action, { projectId, fileId }, 'atlas-mcp', caller as never), /Owner OAuth/);
            assert.equal(touched, false);
        }
    }
});

test('private file MCP dispatch checks active Project before looking up files', async () => {
    const calls: string[] = [];
    const services = {
        catalog: { getProject: async (id: string) => { calls.push('project:' + id); if (id === otherProject) throw Error('Project archived'); } },
        files: {
            listProjectPage: async (p: string, folder?: string, limit?: number, offset?: number) => {
                calls.push('list:' + p + ':' + folder + ':' + limit + ':' + offset);
                return { files: [], hasMore: false };
            },
            projectDownloadLink: async (p: string, f: string) => {
                calls.push('link:' + p + ':' + f);
                return { file: { id: f }, downloadUrl: 'https://example.invalid/signed', expiresAt: 'now' };
            },
        },
        diagnostics: { record: () => undefined },
    };
    const dispatch = createDispatcher(services as unknown as Parameters<typeof createDispatcher>[0]);
    assert.deepEqual(await dispatch('list_project_files', { projectId, limit: 25, offset: 5 }, 'atlas-mcp', authorized), { files: [], hasMore: false });
    assert.equal((await dispatch('get_project_file', { projectId, fileId }, 'atlas-mcp', authorized) as { file: { id: string } }).file.id, fileId);
    assert.deepEqual(calls, ['project:' + projectId, 'list:' + projectId + ':undefined:25:5', 'project:' + projectId, 'link:' + projectId + ':' + fileId]);
    await assert.rejects(dispatch('get_project_file', { projectId: otherProject, fileId }, 'atlas-mcp', authorized), /archived/);
    assert.equal(calls.at(-1), 'project:' + otherProject);
});

test('Project file lookup binds both file ID and Project ID and never returns R2 keys', async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const now = new Date('2026-11-09T00:00:00Z');
    const row = {
        id: fileId, owner_kind: 'project', owner_id: projectId, storage_key: key,
        file_name: 'notes.pdf', mime_type: 'application/pdf', byte_size: 1234,
        checksum: 'a'.repeat(64), visibility: 'private', status: 'active',
        folder_id: null, created_at: now, updated_at: now,
    };
    const svc = Object.create(AtlasFilesService.prototype) as AtlasFilesService & { pool: unknown; r2Signer: unknown };
    (svc as any).pool = { query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return { rows: params.includes(projectId) && params.includes(fileId) ? [row] : [] };
    } };
    (svc as any).r2Signer = new R2ObjectStore(r2);
    const linked = await svc.projectDownloadLink(projectId, fileId);
    assert.equal(linked.file.fileName, 'notes.pdf');
    assert.equal(linked.availability, 'r2');
    assert.equal(new URL(linked.downloadUrl!).pathname, '/atlas-files/' + key);
    assert.equal(JSON.stringify(linked).includes('storage_key'), false);
    assert.match(queries[0]!.sql, /owner_kind='project'.*owner_id=\$2.*status='active'/);
    assert.deepEqual(queries[0]!.params, [fileId, projectId]);
    await assert.rejects(svc.projectDownloadLink(otherProject, fileId), /not found/);
    assert.rejects(svc.projectDownloadLink(projectId, '../bad'), /identity/);
});

test('Project listing uses bounded SQL pagination and folder-scoped parameters', async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const svc = Object.create(AtlasFilesService.prototype) as AtlasFilesService;
    (svc as any).pool = { query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [] };
    } };
    const root = await svc.listProjectPage(projectId, null, 20, 40);
    assert.deepEqual(root, { files: [], hasMore: false });
    assert.match(queries[0]!.sql, /folder_id IS NOT DISTINCT FROM \$2::uuid/);
    assert.match(queries[0]!.sql, /LIMIT \$3 OFFSET \$4/);
    assert.deepEqual(queries[0]!.params, [projectId, null, 21, 40]);
    await svc.listProjectPage(projectId);
    assert.match(queries[1]!.sql, /LIMIT \$2 OFFSET \$3/);
    assert.deepEqual(queries[1]!.params, [projectId, 51, 0]);
    await assert.rejects(svc.listProjectPage(projectId, undefined, 101), /Invalid Project file listing/);
    await assert.rejects(svc.listProjectPage('not-a-project'), /Invalid Project file listing/);
});
