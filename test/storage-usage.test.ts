import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { readPostgresStorage, readR2Analytics, StorageUsageService } from '../apps/server/src/server/storage-usage.js';

const pool = { query: async (sql: string) => sql.includes('pg_database_size')
    ? { rows: [{ bytes: '51200' }] }
    : { rows: [
        { schema: 'public', name: 'records', tableBytes: '9000', indexBytes: '1000', totalBytes: '10000' },
        { schema: 'public', name: 'stores', tableBytes: '4000', indexBytes: '2000', totalBytes: '6000' },
    ] },
} as unknown as Pick<Pool, 'query'>;

test('Postgres usage derives exact sizes and largest physical tables', async () => {
    const result = await readPostgresStorage(pool);
    assert.equal(result.state, 'ready');
    assert.equal(result.databaseBytes, 51200);
    assert.equal(result.tableBytes, 13000);
    assert.equal(result.indexBytes, 3000);
    assert.equal(result.tableCount, 2);
    assert.deepEqual(result.tables?.map(table => table.name), ['records', 'stores']);
});

test('Cloudflare usage differentiates account operations from bucket storage', async () => {
    let captured: { query: string; variables: Record<string, string> } | undefined;
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(String(url), 'https://api.cloudflare.com/client/v4/graphql');
        captured = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ data: { viewer: { accounts: [{
            storage: [{ max: { payloadSize: 5000, objectCount: 3 }, dimensions: { datetime: '2026-10-20T12:00:00Z' } }],
            operations: [
                { dimensions: { actionType: 'PutObject' }, sum: { requests: 14 } },
                { dimensions: { actionType: 'GetObject' }, sum: { requests: 40 } },
                { dimensions: { actionType: 'DeleteObject' }, sum: { requests: 7 } },
            ],
        }] } } }), { status: 200 });
    }) as typeof fetch;
    const result = await readR2Analytics({
        accountId: 'a'.repeat(32), analyticsToken: 'secret-for-test', bucket: 'atlas-files',
    }, fetcher, new Date('2026-10-20T20:00:00Z'));
    assert.equal(result.state, 'ready');
    assert.equal(result.storageBytes, 5000);
    assert.equal(result.objectCount, 3);
    assert.equal(result.classA, 14);
    assert.equal(result.classB, 40);
    assert.equal(result.otherOperations, 7);
    assert.equal(result.accountWideOperations, true);
    assert.equal(captured?.variables.monthStart, '2026-10-01T00:00:00.000Z');
    assert.equal(captured?.variables.bucketName, 'atlas-files');
});

test('Unconfigured analytics does not invent Cloudflare usage and does not block Postgres', async () => {
    const result = await new StorageUsageService(pool, {}).get();
    assert.equal(result.postgres.state, 'ready');
    assert.equal(result.r2.state, 'not_configured');
    assert.equal(result.r2.storageBytes, undefined);
});

test('Cloudflare analytics errors do not expose tokens or fabricate zeros', async () => {
    const result = await readR2Analytics({
        accountId: 'a'.repeat(32), analyticsToken: 'sensitive-secret', bucket: 'atlas-files',
    }, (async () => new Response('Forbidden', { status: 403 })) as typeof fetch);
    assert.equal(result.state, 'unavailable');
    assert.equal(result.storageBytes, undefined);
    assert.equal(JSON.stringify(result).includes('sensitive-secret'), false);
});

test('Cloudflare usage is cached until a forced refresh', async () => {
    let calls = 0;
    const reader = async () => {
        calls++;
        return { state: 'ready' as const, ...{ storageAllowanceBytes: 10_000_000_000, classAAllowance: 1_000_000, classBAllowance: 10_000_000 }, storageBytes: calls };
    };
    const service = new StorageUsageService(pool, {}, reader);
    assert.equal((await service.get()).r2.storageBytes, 1);
    assert.equal((await service.get()).r2.storageBytes, 1);
    assert.equal((await service.get(true)).r2.storageBytes, 2);
    assert.equal(calls, 2);
});
