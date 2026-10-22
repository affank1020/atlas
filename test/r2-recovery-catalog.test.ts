import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Pool } from 'pg';
import { LocalObjectStore, ObjectNotFound } from '../apps/server/src/server/file-storage.js';
import { createR2SeedPrimarySource, seedR2Backup } from '../apps/server/src/server/r2-backup-seeding.js';
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
    const fixtures=Array.from({length:4},(_,i)=>file(i+1));
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

test('legacy local-only File is seeded then catalog-verified without primary R2', async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'atlas-r2-catalog-legacy-'));
    t.after(async () => { await rm(dir, { recursive: true, force: true }); });
    const legacy = file(50);
    await writeFile(path.join(dir, legacy.row.storage_key), legacy.bytes);
    let remoteReads = 0;
    const primary = createR2SeedPrimarySource({
        getBounded: async () => { remoteReads++; throw new ObjectNotFound(); },
    }, new LocalObjectStore(dir));
    const recovered = new Map<string, Buffer>();
    let writes = 0;
    const backup = {
        getBounded: async (key: string, maxBytes: number) => {
            assert.ok(maxBytes <= 25 * 1024 * 1024);
            const bytes = recovered.get(key);
            if (bytes === undefined) throw new ObjectNotFound();
            return bytes;
        },
        putIfAbsent: async (key: string, bytes: Buffer) => {
            writes++;
            assert.equal(recovered.has(key), false);
            recovered.set(key, Buffer.from(bytes));
            return true;
        },
    };
    // This is the same bounded source actually used by the seeder and new
    // catalog CLI; the catalog uses a different query, on the same metadata.
    const seedDb = { query: async () => ({ rows: [legacy.row] }) } as unknown as Pick<Pool, 'query'>;
    const seed = await seedR2Backup({
        database: seedDb, primary, backup, apply: true,
    });
    assert.equal(seed.status, 'completed');
    assert.equal(seed.createdVerified, 1);
    assert.equal(writes, 1);
    assert.deepEqual(recovered.get(legacy.row.storage_key), legacy.bytes);

    const report = await verifyR2RecoveryCatalog({
        database: source([legacy.row]).db, primary, backup,
    });
    assert.equal(report.status, 'passed');
    assert.equal(report.primarySource, 'effective-atlas-files');
    assert.equal(report.checked, 1);
    assert.equal(report.verifiedBoth, 1);
    assert.equal(report.verifiedPrimaryViaLegacyLocal, 1);
    assert.equal(report.primaryMissing, 0);
    assert.equal(report.noWrites, true);
    assert.equal(writes, 1, 'catalog verification must never upload');
    assert.equal(remoteReads, 2, 'only classified R2 object absence permits local fallback');
});

test('catalog refuses unsafe remote error, corrupt legacy bytes or unmounted local root', async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'atlas-r2-catalog-errors-'));
    t.after(async () => { await rm(dir, { recursive: true, force: true }); });
    const legacy = file(51);
    await writeFile(path.join(dir, legacy.row.storage_key), legacy.bytes);
    const backup = store(new Map([[legacy.row.storage_key, legacy.bytes]])).backend;
    const remoteError = createR2SeedPrimarySource({
        getBounded: async () => { throw new Error('primary R2 HTTP 403'); },
    }, new LocalObjectStore(dir));
    await assert.rejects(verifyR2RecoveryCatalog({
        database: source([legacy.row]).db, primary: remoteError, backup,
    }), /primary R2 HTTP 403/, 'never hide auth, network or bucket errors behind local data');

    await writeFile(path.join(dir, legacy.row.storage_key), Buffer.from('tampered'));
    const remoteMissing = {getBounded: async (): Promise<Buffer> => { throw new ObjectNotFound(); }};
    const corrupt = await verifyR2RecoveryCatalog({
        database: source([legacy.row]).db,
        primary: createR2SeedPrimarySource(remoteMissing, new LocalObjectStore(dir)),
        backup,
    });
    assert.equal(corrupt.status, 'failed');
    assert.equal(corrupt.primaryCorrupt, 1);
    assert.equal(corrupt.verifiedPrimaryViaLegacyLocal, 0,
        'only intact local fallback objects can count as verified');

    await rm(dir, { recursive: true, force: true });
    await assert.rejects(verifyR2RecoveryCatalog({
        database: source([legacy.row]).db,
        primary: createR2SeedPrimarySource(remoteMissing, new LocalObjectStore(dir)),
        backup,
    }), /ENOENT/, 'a missing legacy mount must be inconclusive, not misclassified as a missing File');
});
