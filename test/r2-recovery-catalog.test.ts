import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ObjectNotFound } from '../apps/server/src/server/file-storage.js';
import {
    verifyR2RecoveryCatalog, parseRecoveryCatalogArgs, R2_RECOVERY_MAX_CATALOG_RECORDS,
} from '../apps/server/src/server/r2-recovery-verification.js';

type Row = { id: string; storage_key: string; checksum: string; byte_size: number };
function file(i: number) {
    const bytes = Buffer.from('recoverable-' + i);
    const id = '00000000-0000-4000-8000-' + i.toString(16).padStart(12, '0');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    return {row: {id, storage_key: 'files-' + id.replaceAll('-', '') + '-' + checksum,
        checksum, byte_size: bytes.length}, bytes};
}
function source(rows: Row[], overrides: {overdeliver?: boolean; fail?: boolean} = {}) {
    const calls: {query: string; values: unknown[]}[] = [];
    const db = {query: async (query: string, values: unknown[]) => {
        calls.push({query, values});
        assert.equal(query,
            'SELECT id,storage_key,checksum,byte_size FROM atlas_files ORDER BY id ASC LIMIT $1');
        assert.equal(values.length, 1);
        if (overrides.fail) throw new Error('private DB credentials should be redacted by CLI');
        const upperBound = Number(values[0]);
        return {rows: rows.slice(0, upperBound + (overrides.overdeliver ? 1 : 0))};
    }} as unknown as Pick<Pool, 'query'>;
    return {db, calls};
}
function store(contents: Map<string, Buffer>) {
    const get: string[] = [];
    const backend = {
        getBounded: async (key: string, maxBytes: number) => {
            get.push(key);
            assert.equal(maxBytes, 25 * 1024 * 1024);
            const bytes = contents.get(key);
            if (bytes === undefined) throw new ObjectNotFound();
            return bytes;
        },
    };
    return {backend, get};
}

test('catalog CLI options are explicit, strictly bounded and never mutate', () => {
    assert.deepEqual(parseRecoveryCatalogArgs(['--dry-run']), {maxRecords:100});
    assert.deepEqual(parseRecoveryCatalogArgs(['--dry-run', '--max-records=200']), {maxRecords:200});
    for (const args of [
        [], ['--apply'], ['--verify'], ['--dry-run', '--apply'],
        ['--dry-run', '--dry-run'], ['--dry-run', '--max-records=0'],
        ['--dry-run', '--max-records=201'], ['--dry-run', '--max-records=-1'],
        ['--dry-run', '--max-records=2.5'], ['--dry-run', '--max-records=1','--max-records=2'],
        ['--dry-run', '--cursor=00000000-0000-4000-8000-000000000001'],
    ]) assert.throws(() => parseRecoveryCatalogArgs(args));
    assert.equal(R2_RECOVERY_MAX_CATALOG_RECORDS, 200);
});

test('one snapshot query verifies all committed backup and primary objects without writes', async () => {
    const fixtures = Array.from({length: 25}, (_,i) => file(i+1));
    const rows = fixtures.map(x=>x.row);
    const content = new Map(fixtures.map(x=>[x.row.storage_key, x.bytes]));
    const primary = store(content), backup = store(content), {db,calls} = source(rows);
    const report = await verifyR2RecoveryCatalog({
        database:db, primary:primary.backend, backup:backup.backend,
    });
    assert.equal(report.status, 'passed');
    assert.equal(report.catalogScope, 'single-statement-metadata-snapshot');
    assert.equal(report.noWrites, true);
    assert.equal(report.checked, 25);
    assert.equal(report.verifiedBoth, 25);
    assert.equal(report.truncated, false);
    assert.equal(report.failureFileIds.length, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.values,[101]);
    assert.equal(primary.get.length,25);
    assert.equal(backup.get.length,25);
    assert.ok(Number.isFinite(Date.parse(report.snapshotObservedAt)));
});

test('cap hit never yields full-catalog success, even when all scanned objects verify', async () => {
    const fixtures=Array.from({length:4},(_,i)=>file(i+1));
    const map=new Map(fixtures.map(x=>[x.row.storage_key,x.bytes]));
    const {db,calls}=source(fixtures.map(x=>x.row));
    const report=await verifyR2RecoveryCatalog({
        database:db,primary:store(map).backend,backup:store(map).backend,maxRecords:3,
    });
    assert.equal(report.status,'partial');
    assert.equal(report.truncated,true);
    assert.equal(report.checked,3);
    assert.deepEqual(calls[0]?.values,[4]);
});

test('exact cap with no sentinel row is complete, zero rows is not', async () => {
    const fixtures=[file(1),file(2),file(3)], map=new Map(fixtures.map(x=>[x.row.storage_key,x.bytes]));
    const report=await verifyR2RecoveryCatalog({
        database:source(fixtures.map(x=>x.row)).db,
        primary:store(map).backend,backup:store(map).backend,maxRecords:3,
    });
    assert.equal(report.status,'passed');
    assert.equal(report.truncated,false);
    const empty=await verifyR2RecoveryCatalog({
        database:source([]).db,primary:store(map).backend,backup:store(map).backend,
    });
    assert.equal(empty.status,'empty');
    assert.equal(empty.checked,0);
});

test('invalid metadata, absent backup and corrupt content fail without arbitrary object GET', async () => {
    const a=file(1), b=file(2), c=file(3);
    b.row.storage_key='../../untrusted';
    const primary=store(new Map([[a.row.storage_key,a.bytes],[c.row.storage_key,c.bytes]]));
    const backup=store(new Map([[c.row.storage_key,Buffer.from('corrupted')]]));
    const result=await verifyR2RecoveryCatalog({
        database:source([a.row,b.row,c.row]).db,
        primary:primary.backend,backup:backup.backend,
    });
    assert.equal(result.status,'failed');
    assert.equal(result.invalidMetadata,1);
    assert.equal(result.backupMissing,1);
    assert.equal(result.backupCorrupt,1);
    assert.equal(result.checked,3);
    assert.equal(result.verifiedPrimary,2);
    assert.equal(primary.get.length,2);
    assert.equal(backup.get.length,2);
    assert.deepEqual(new Set(result.failureFileIds),new Set([a.row.id,b.row.id,c.row.id]));
    assert.equal(primary.get.includes(b.row.storage_key),false);
});

test('bounded scan refuses overdeliver and any unclassified remote errors', async () => {
    const fixtures=Array.from({length:3},(_,i)=>file(i+1));
    const rows=fixtures.map(x=>x.row);
    const map=new Map(fixtures.map(x=>[x.row.storage_key,x.bytes]));
    await assert.rejects(verifyR2RecoveryCatalog({
        database:source(rows,{overdeliver:true}).db,
        primary:store(map).backend,backup:store(map).backend,maxRecords:2,
    }),/exceeded/);
    await assert.rejects(verifyR2RecoveryCatalog({
        database:source(rows,{fail:true}).db,
        primary:store(map).backend,backup:store(map).backend,maxRecords:2,
    }),/private DB credentials/);
    await assert.rejects(verifyR2RecoveryCatalog({
        database:source([rows[0]!]).db,primary:store(map).backend,
        backup:{getBounded:async()=>{throw new Error('403 forbidden');}},
    }),/403 forbidden/);
    for(const limit of [0,201,-2,1.5,Number.NaN,Infinity])
        await assert.rejects(verifyR2RecoveryCatalog({
            database:source([]).db, primary:store(map).backend,backup:store(map).backend,
            maxRecords:limit,
        }),/limit/);
});
