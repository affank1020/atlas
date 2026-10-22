import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test,{after} from 'node:test';
import type {Pool} from 'pg';
import {ObjectAlreadyExists,ObjectNotFound,R2ObjectStore} from '../apps/server/src/server/file-storage.js';
import {
    parseR2BackupSeedArgs,previewR2BackupSeed,seedIndependentR2Backup,
    R2_BACKUP_SEED_CONFIRMATION,
} from '../apps/server/src/server/r2-backup-seeding.js';
import {databaseFixture,cleanupDatabases} from './database.js';

after(cleanupDatabases);
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function entry(bytes:Buffer,id=randomUUID()) {
    const checksum=hash(bytes);
    return {id,storage_key:'files-'+id.replaceAll('-','')+'-'+checksum,
        checksum,byte_size:bytes.length,mime_type:'application/octet-stream'};
}
type Row=ReturnType<typeof entry>;
function fakeDatabase(rows:Row[]) {
    const calls:{sql:string;parameters:unknown[]}[]=[];
    const ordered=[...rows].sort((a,b)=>a.id.localeCompare(b.id));
    const database={query:async (sql:string,parameters:unknown[])=>{
        calls.push({sql,parameters});
        assert.match(sql,/^SELECT id,storage_key,checksum,byte_size,mime_type FROM atlas_files /);
        assert.match(sql,/WHERE \(\$1::uuid IS NULL OR id > \$1::uuid\) ORDER BY id ASC LIMIT \$2/);
        const [cursor,limit]=parameters as [string|null,number];
        assert.ok(limit>=2 && limit<=6,'read must include at most one bounded lookahead row');
        return {rows:ordered.filter(x=>cursor===null || x.id>cursor).slice(0,limit)};
    }} as unknown as Pick<Pool,'query'>;
    return {database,calls};
}
function stores(source:Map<string,Buffer>,recovery:Map<string,Buffer>) {
    const calls={sourceGets:0,backupGets:0,created:0,deletes:0};
    const primary={getBounded:async(key:string,max:number)=>{
        calls.sourceGets++;assert.equal(max,25*1024*1024);
        const data=source.get(key);if(!data)throw new ObjectNotFound();
        return Buffer.from(data);
    }};
    const backup={getBounded:async(key:string,max:number)=>{
        calls.backupGets++;assert.equal(max,25*1024*1024);
        const data=recovery.get(key);if(!data)throw new ObjectNotFound();
        return Buffer.from(data);
    },putIfAbsent:async(key:string,data:Buffer,mime:string)=>{
        calls.created++;
        assert.equal(mime,'application/octet-stream');
        if(recovery.has(key))throw new ObjectAlreadyExists();
        recovery.set(key,Buffer.from(data));
    }};
    return {calls,primary,backup};
}

test('operator CLI defaults to no writes and rejects all unconfirmed mutation paths',()=>{
    assert.deepEqual(parseR2BackupSeedArgs([]),{apply:false,maxFiles:2});
    assert.deepEqual(parseR2BackupSeedArgs(['--dry-run','--max-files=5']),{apply:false,maxFiles:5});
    assert.deepEqual(parseR2BackupSeedArgs(['--apply','--confirm='+R2_BACKUP_SEED_CONFIRMATION]),
        {apply:true,maxFiles:2});
    const id=randomUUID();
    assert.deepEqual(parseR2BackupSeedArgs(['--cursor='+id]),{apply:false,maxFiles:2,cursor:id});
    for(const bad of [
        ['--apply'],['--confirm='+R2_BACKUP_SEED_CONFIRMATION],
        ['--apply','--dry-run','--confirm='+R2_BACKUP_SEED_CONFIRMATION],
        ['--apply','--confirm=YES'],['--max-files=0'],['--max-files=6'],
        ['--max-files=2.5'],['--max-files=foo'],['--max-files=1','--max-files=2'],
        ['--cursor=broken-key'],['--cursor='],['--apply','--apply',
            '--confirm='+R2_BACKUP_SEED_CONFIRMATION],
    ])assert.throws(()=>parseR2BackupSeedArgs(bad));
});

test('dry-run reports bounded candidates and invalid metadata without any S3 object calls',async()=>{
    const a=entry(Buffer.from('one'),'00000000-0000-4000-8000-000000000001');
    const b=entry(Buffer.from('two'),'00000000-0000-4000-8000-000000000002');
    b.storage_key='corrupt/import';
    const c=entry(Buffer.from('three'),'00000000-0000-4000-8000-000000000003');
    const {database,calls}=fakeDatabase([a,b,c]);
    const first=await previewR2BackupSeed(database,{maxFiles:2});
    assert.deepEqual({mode:first.mode,planned:first.planned,invalid:first.invalidMetadata},
        {mode:'dry-run',planned:2,invalid:1});
    assert.equal(first.noWrites,true);
    assert.equal(first.noObjectRequests,true);
    assert.equal(first.remaining,true);
    assert.equal(first.nextCursor,b.id);
    assert.equal(calls.length,1);
    const second=await previewR2BackupSeed(database,{maxFiles:2,cursor:first.nextCursor});
    assert.equal(second.planned,1);
    assert.equal(second.invalidMetadata,0);
    assert.equal(second.remaining,false);
});

test('apply copies only missing verified bytes and independently rereads destination',async()=>{
    const oneBytes=Buffer.from('private backup one'),twoBytes=Buffer.from('private backup two');
    const a=entry(oneBytes),b=entry(twoBytes);
    const {database}=fakeDatabase([a,b]);
    const source=new Map([[a.storage_key,oneBytes],[b.storage_key,twoBytes]]);
    const recovery=new Map([[b.storage_key,Buffer.from(twoBytes)]]);
    const {primary,backup,calls}=stores(source,recovery);
    const report=await seedIndependentR2Backup({database,primary,destination:backup});
    assert.equal(report.mode,'apply');
    assert.equal(report.checked,2);
    assert.equal(report.created,1);
    assert.equal(report.verifiedExisting,1);
    assert.equal(report.noDeletes,true);
    assert.equal(report.appendOnly,true);
    assert.equal(calls.created,1);
    assert.equal(calls.sourceGets,2);
    assert.equal(calls.backupGets,3,'missing then reread created; existing checked');
    assert.deepEqual(recovery.get(a.storage_key),oneBytes);
    const again=await seedIndependentR2Backup({database,primary,destination:backup});
    assert.equal(again.created,0);
    assert.equal(again.verifiedExisting,2);
    assert.equal(calls.created,1,'second run must never overwrite');
});

test('corrupt source, corrupt backup, or invalid metadata stop without any writes',async()=>{
    const data=Buffer.from('original');
    const row=entry(data),db=fakeDatabase([row]).database;
    for(const [sourceBytes,backupBytes] of [
        [Buffer.from('tampered'),undefined],
        [data,Buffer.from('tampered')],
    ] as const) {
        const source=new Map([[row.storage_key,Buffer.from(sourceBytes)]]);
        const recovery=new Map<string,Buffer>();
        if(backupBytes) recovery.set(row.storage_key,Buffer.from(backupBytes));
        const {primary,backup,calls}=stores(source,recovery);
        await assert.rejects(seedIndependentR2Backup({database:db,primary,destination:backup}),/mismatching/);
        assert.equal(calls.created,0,'must not repair/overwrite corrupt backups');
    }
    const invalid=entry(data);
    invalid.storage_key='broken-key';
    const {primary,backup,calls}=stores(new Map(),new Map());
    await assert.rejects(seedIndependentR2Backup({
        database:fakeDatabase([invalid,row]).database,primary,destination:backup,
    }),/invalid metadata/);
    assert.equal(calls.sourceGets,0,'all selected metadata checked before first remote GET');
    assert.equal(calls.created,0);
});

test('conditional-PUT race is checksum-verified, not retried as overwriting PUT',async()=>{
    const data=Buffer.from('racing backup upload');
    const row=entry(data);
    const {primary,backup,calls}=stores(new Map([[row.storage_key,data]]),new Map());
    backup.putIfAbsent=async(key,contents)=>{
        calls.created++;
        assert.deepEqual(contents,data);
        const target=backup as typeof backup & {already:boolean};
        target.already=true;
        // Another writer installed the same immutable content before ours.
        await Promise.resolve();
        throw new ObjectAlreadyExists();
    };
    const original=backup.getBounded;
    let gets=0;
    backup.getBounded=async(key,max)=>{
        gets++;
        if(gets===1)throw new ObjectNotFound();
        assert.equal(key,row.storage_key);assert.equal(max,25*1024*1024);
        return Buffer.from(data);
    };
    const result=await seedIndependentR2Backup({
        database:fakeDatabase([row]).database,primary,destination:backup,
    });
    assert.equal(result.created,0);
    assert.equal(result.verifiedExisting,1);
    assert.equal(calls.created,1);
    backup.getBounded=original;
});

test('ambiguous network failure after a committed PUT is safely retried without overwrite',async()=>{
    const data=Buffer.from('ambiguous success');
    const row=entry(data),recovery=new Map<string,Buffer>();
    const {primary,backup,calls}=stores(new Map([[row.storage_key,data]]),recovery);
    const original=backup.putIfAbsent;
    backup.putIfAbsent=async(...args)=>{
        await original(...args);
        throw new Error('lost acknowledgement');
    };
    const input={database:fakeDatabase([row]).database,primary,destination:backup};
    await assert.rejects(seedIndependentR2Backup(input),/lost acknowledgement/);
    assert.equal(recovery.has(row.storage_key),true);
    backup.putIfAbsent=original;
    const result=await seedIndependentR2Backup(input);
    assert.equal(result.created,0);
    assert.equal(result.verifiedExisting,1);
    assert.equal(calls.created,1,'retry verifies previously stored bytes');
});

test('bounded pagination uses UUIDs and excludes any malformed storage key as cursor',async()=>{
    const rows=Array.from({length:7},(_,i)=>entry(Buffer.from('file-'+i)));
    rows[0]!.id='00000000-0000-4000-8000-000000000001';
    rows[0]!.storage_key='broken-key';
    const {database}=fakeDatabase(rows);
    const first=await previewR2BackupSeed(database,{maxFiles:1});
    assert.equal(first.nextCursor,rows[0]!.id);
    assert.equal(first.invalidMetadata,1);
    const next=await previewR2BackupSeed(database,{maxFiles:5,cursor:first.nextCursor});
    assert.equal(next.planned,5);
    assert.ok(next.nextCursor);
    assert.notEqual(next.nextCursor,'broken-key');
});

test('real PostgreSQL migration includes malformed keys and preserves bounded read-only preview',async()=>{
    const db=await databaseFixture();
    const invalid=entry(Buffer.from('damaged'));
    invalid.storage_key='';
    await db.store.pool.query(
        'INSERT INTO atlas_files (id,owner_kind,owner_id,storage_key,checksum,file_name,mime_type,byte_size,created_by) ' +
        "VALUES($1,'workspace',$2,$3,$4,'test.bin','application/octet-stream',$5,'test')",
        [invalid.id,randomUUID(),invalid.storage_key,invalid.checksum,invalid.byte_size],
    );
    const report=await previewR2BackupSeed(db.store.pool,{maxFiles:1});
    assert.equal(report.planned,1);
    assert.equal(report.invalidMetadata,1);
    assert.equal(report.noObjectRequests,true);
});

test('R2 conditional create signs If-None-Match and maps 412 without unsafe overwrite fallback',async()=>{
    const cfg={endpoint:'https://0123456789abcdef.r2.cloudflarestorage.com/',
        bucket:'independent-backup',accessKeyId:'backup-key',secretAccessKey:'different-secret'};
    const bytes=Buffer.from('backup body');
    const row=entry(bytes);
    let status=200;let requests=0;
    const client=new R2ObjectStore(cfg,(async(_url,init)=>{
        requests++;
        assert.equal(init?.method,'PUT');
        const h=init!.headers as Record<string,string>;
        assert.equal(h['if-none-match'],'*');
        assert.match(h.authorization,/SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date/);
        assert.equal(h['x-amz-content-sha256'],hash(bytes));
        return new Response(null,{status});
    }) as typeof fetch);
    await client.putIfAbsent(row.storage_key,bytes,'application/octet-stream');
    status=412;
    await assert.rejects(client.putIfAbsent(row.storage_key,bytes,'application/octet-stream'),
        (error:unknown)=>error instanceof ObjectAlreadyExists);
    assert.equal(requests,2);
});
