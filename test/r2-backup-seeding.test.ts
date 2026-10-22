import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { ObjectNotFound, R2ObjectStore } from '../apps/server/src/server/file-storage.js';
import {
    parseR2SeedArgs, seedR2Backup, R2_SEED_CONFIRMATION,
    type SeedStore,
} from '../apps/server/src/server/r2-backup-seeding.js';

const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function file(bytes: Buffer = Buffer.from('private bytes')) {
    const id = randomUUID();
    const hash = checksum(bytes);
    return { id, storage_key: 'files-' + id.replaceAll('-', '') + '-' + hash,
        checksum: hash, byte_size: bytes.length };
}
type Row = ReturnType<typeof file>;
function database(rows: Row[]) {
    const sql: string[] = [];
    const sorted = [...rows].sort((a,b) => a.id.localeCompare(b.id));
    const db = { query: async (query: string, values: unknown[]) => {
        sql.push(query);
        assert.match(query, /^SELECT id,storage_key,checksum,byte_size FROM atlas_files /);
        assert.ok(!/archived_at|LIMIT \d|DELETE|UPDATE/i.test(query));
        const [cursor, limit] = values as [string | null, number];
        assert.ok(limit >= 2 && limit <= 11);
        return { rows: sorted.filter(row => !cursor || row.id > cursor).slice(0, limit) };
    } } as unknown as Pick<Pool, 'query'>;
    return { db, sql };
}
function store(objects: Map<string, Buffer>, calls: string[], writeCalls: string[] = []): SeedStore {
    return {
        getBounded: async (key, maxBytes) => {
            assert.equal(maxBytes, 25 * 1024 * 1024);
            calls.push(key);
            if (!objects.has(key)) throw new ObjectNotFound();
            return objects.get(key)!;
        },
        putIfAbsent: async (key, bytes, mimeType) => {
            writeCalls.push(key);
            assert.equal(mimeType, 'application/octet-stream');
            if (objects.has(key)) return false;
            objects.set(key, Buffer.from(bytes));
            return true;
        },
    };
}

test('seed CLI defaults to dry-run and requires exact independent confirmation for apply', () => {
    assert.deepEqual(parseR2SeedArgs([]), { apply: false, maxFiles: 3 });
    assert.deepEqual(parseR2SeedArgs(['--dry-run','--max-files=10']), { apply: false,maxFiles: 10 });
    const cursor = file().id;
    assert.deepEqual(parseR2SeedArgs(['--apply','--confirm=' + R2_SEED_CONFIRMATION,'--cursor=' + cursor]),
        { apply: true, maxFiles: 3, cursor });
    for (const args of [
        ['--apply'],['--apply','--confirm=YES'],['--apply','--dry-run','--confirm=' + R2_SEED_CONFIRMATION],
        ['--confirm=' + R2_SEED_CONFIRMATION],['--apply','--apply','--confirm=' + R2_SEED_CONFIRMATION],
        ['--dry-run','--dry-run'],['--dry-run','--max-files=11'],['--max-files=0'],
        ['--max-files=1.5'],['--cursor=../../../x'],['--cursor='],['--delete'],
        ['--apply','--confirm=' + R2_SEED_CONFIRMATION,'--prune'],
    ]) assert.throws(() => parseR2SeedArgs(args));
});

test('dry-run verifies existing backup bytes, checks missing source, never writes', async () => {
    const oneBytes = Buffer.from('one'), twoBytes = Buffer.from('two');
    const one = file(oneBytes), two = file(twoBytes);
    const primary = new Map([[one.storage_key, oneBytes],[two.storage_key, twoBytes]]);
    const backup = new Map([[one.storage_key, oneBytes]]);
    const writes: string[] = [], gets: string[] = [];
    const {db,sql} = database([one,two]);
    const report = await seedR2Backup({ database: db, primary: store(primary, []),
        backup: store(backup, gets, writes) });
    assert.equal(report.mode,'dry-run');
    assert.equal(report.status,'ready');
    assert.equal(report.checked,2);
    assert.equal(report.existingVerified,1);
    assert.equal(report.planned,1);
    assert.equal(report.createdVerified,0);
    assert.equal(report.writesAttempted,0);
    assert.deepEqual(writes,[]);
    assert.equal(gets.length,2);
    assert.equal(sql.length,1);
    assert.equal(backup.size,1);
});

test('apply writes missing copy only with atomic create-once and verifies re-read', async () => {
    const bytes=Buffer.from('copy these verified bytes'), row=file(bytes);
    const src=new Map([[row.storage_key,bytes]]);
    const dest=new Map<string,Buffer>();
    const writes:string[]=[];
    const input={ database:database([row]).db,primary:store(src,[]),backup:store(dest,[],writes),apply:true };
    const result=await seedR2Backup(input);
    assert.equal(result.status,'completed');
    assert.equal(result.createdVerified,1);
    assert.equal(result.bytesUploaded,bytes.length);
    assert.equal(result.writesAttempted,1);
    assert.deepEqual(writes,[row.storage_key]);
    assert.deepEqual(dest.get(row.storage_key),bytes);
    const repeated=await seedR2Backup(input);
    assert.equal(repeated.existingVerified,1);
    assert.equal(repeated.writesAttempted,0);
    assert.equal(writes.length,1,'rerun never overwrites the existing object');
});

test('corrupt existing backup is reported without an overwrite, even under apply', async () => {
    const bytes=Buffer.from('correct payload'), row=file(bytes);
    const backup=new Map([[row.storage_key,Buffer.from('damaged payload')]]);
    const writes:string[]=[];
    const report=await seedR2Backup({database:database([row]).db,
        primary:store(new Map([[row.storage_key,bytes]]),[]),
        backup:store(backup,[],writes),apply:true});
    assert.equal(report.status,'failed');
    assert.equal(report.backupCorrupt,1);
    assert.deepEqual(report.failureFileIds,[row.id]);
    assert.deepEqual(writes,[]);
    assert.equal(backup.get(row.storage_key)?.toString(),'damaged payload');
});

test('missing or corrupt primary source never reaches the destination', async () => {
    const one=file(Buffer.from('missing')), two=file(Buffer.from('valid expected'));
    const writes:string[]=[];
    const destination=store(new Map(),[],writes);
    const report=await seedR2Backup({database:database([one,two]).db,
        primary:store(new Map([[two.storage_key,Buffer.from('other data')]]),[]),
        backup:destination,apply:true});
    assert.equal(report.primaryMissing,1);
    assert.equal(report.primaryCorrupt,1);
    assert.equal(report.writesAttempted,0);
    assert.deepEqual(writes,[]);
    assert.equal(report.status,'failed');
});

test('conditional race returns already-present bytes only after checksum verification', async () => {
    const bytes=Buffer.from('race-safe'), row=file(bytes), writes:string[]=[];
    const primary=store(new Map([[row.storage_key,bytes]]),[]);
    const existing=new Map<string,Buffer>();
    const backup:SeedStore={
        getBounded:async key=>{
            if (!existing.has(key)) throw new ObjectNotFound();
            return existing.get(key)!;
        },
        putIfAbsent:async key=>{
            writes.push(key);
            existing.set(key,bytes);
            return false; // another writer won the conditional PUT
        },
    };
    const done=await seedR2Backup({database:database([row]).db,primary,backup,apply:true});
    assert.equal(done.status,'completed');
    assert.equal(done.racedVerified,1);
    assert.equal(done.createdVerified,0);
    assert.equal(done.bytesUploaded,0);
    assert.deepEqual(writes,[row.storage_key]);
    // An existing but wrong object after a 412 is never quietly accepted.
    existing.clear();
    backup.putIfAbsent=async key=>{
        existing.set(key,Buffer.from('bad'));
        return false;
    };
    const bad=await seedR2Backup({database:database([row]).db,primary,backup,apply:true});
    assert.equal(bad.status,'failed');
    assert.equal(bad.backupCorrupt,1);
    assert.equal(bad.createdVerified,0);
});

test('invalid metadata is counted, cursor visits later rows, no arbitrary key is used',async()=>{
    const invalid=file(Buffer.from('broken'));
    invalid.id='00000000-0000-4000-8000-000000000001';
    invalid.storage_key='../../untrusted';
    const goodBytes=Buffer.from('good'),good=file(goodBytes);
    const src=new Map([[good.storage_key,goodBytes]]);
    const dst=new Map<string,Buffer>();
    const writes:string[]=[];
    const input={database:database([invalid,good]).db,
        primary:store(src,[]),backup:store(dst,[],writes),apply:true,maxFiles:1};
    const first=await seedR2Backup(input);
    assert.equal(first.checked,1);
    assert.equal(first.invalidMetadata,1);
    assert.equal(first.status,'failed');
    assert.equal(first.remaining,true);
    assert.equal(first.nextCursor,invalid.id);
    assert.deepEqual(writes,[]);
    const second=await seedR2Backup({...input,cursor:first.nextCursor});
    assert.equal(second.createdVerified,1);
    assert.equal(second.remaining,false);
    assert.equal(second.entireCatalogChecked,false);
    assert.equal(second.status,'partial','cursor windows cannot claim full catalogue coverage');
    assert.deepEqual(writes,[good.storage_key]);
});

test('empty catalog and permission outages cannot masquerade as successful backup seeding',async()=>{
    const empty=await seedR2Backup({database:database([]).db,primary:store(new Map(),[]),
        backup:store(new Map(),[])});
    assert.equal(empty.status,'empty');
    const row=file();
    await assert.rejects(seedR2Backup({database:database([row]).db,
        primary:store(new Map(),[]),backup:{getBounded:async()=>{throw new Error('403 denied');}}}),
    /403 denied/);
    await assert.rejects(seedR2Backup({database:database([row]).db,
        primary:store(new Map(),[]),backup:{getBounded:async()=>null as unknown as Buffer},apply:true}),
    /atomic create-only/);
    const bytes=Buffer.from('source'), valid=file(bytes);
    const failure:SeedStore={
        getBounded:async()=>{throw new ObjectNotFound();},
        putIfAbsent:async()=>{throw new Error('unknown PUT outcome');},
    };
    await assert.rejects(seedR2Backup({database:database([valid]).db,
        primary:store(new Map([[valid.storage_key,bytes]]),[]),backup:failure,apply:true}),
    /unknown PUT outcome/);
});

test('signed R2 conditional PUT sends If-None-Match as a signed header and respects 412',async()=>{
    const row=file(Buffer.from('test bytes'));
    const config={endpoint:'https://0123456789abcdef.r2.cloudflarestorage.com/',
        bucket:'atlas-backup',accessKeyId:'backup-id',secretAccessKey:'backup-secret'};
    let status=200;
    const requests:{method:string;headers:Record<string,string>;body:unknown;path:string}[]=[];
    const client=new R2ObjectStore(config,(async(url,init)=>{
        requests.push({method:String(init?.method),headers:init?.headers as Record<string,string>,
            body:init?.body,path:new URL(String(url)).pathname});
        return new Response(status===200?'': 'precondition failed',{status});
    }) as typeof fetch);
    assert.equal(await client.putIfAbsent(row.storage_key,Buffer.from('test bytes'),'application/octet-stream'),true);
    assert.equal(requests[0]?.method,'PUT');
    assert.equal(requests[0]?.path,'/atlas-backup/'+row.storage_key);
    assert.equal(requests[0]?.headers['if-none-match'],'*');
    assert.match(requests[0]!.headers.authorization,/SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date/);
    assert.equal(requests[0]?.headers['x-amz-content-sha256'],checksum(Buffer.from('test bytes')));
    status=412;
    assert.equal(await client.putIfAbsent(row.storage_key,Buffer.from('test bytes'),'application/octet-stream'),false);
    status=403;
    await assert.rejects(client.putIfAbsent(row.storage_key,Buffer.from('test bytes'),'application/octet-stream'),/HTTP 403/);
    await assert.rejects(client.putIfAbsent('unsafe/key',Buffer.from('test bytes'),'application/octet-stream'),/Invalid Atlas media object key/);
    await assert.rejects(client.putIfAbsent(row.storage_key,Buffer.alloc(0),'application/octet-stream'),/Invalid bounded/);
    assert.equal(requests.length,3,'invalid writes must not reach the network');
});
