import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';

after(cleanupDatabases);
import type { Pool } from 'pg';
import { ObjectNotFound, R2ObjectStore } from '../apps/server/src/server/file-storage.js';
import {
    verifyR2Recovery,loadRecoveryR2Config,parseRecoveryVerifyArgs,
    R2_RECOVERY_MAX_FILE_BYTES,
} from '../apps/server/src/server/r2-recovery-verification.js';

const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const fixture=(data:Buffer=Buffer.from('verified backup bytes'))=>{
    const id=randomUUID();
    const checksum=digest(data);
    return {id,storage_key:'files-'+id.replaceAll('-','')+'-'+checksum,checksum,byte_size:data.length};
};
type Row=ReturnType<typeof fixture>;
function database(rows:Row[]) {
    const calls:{sql:string;params:unknown[]}[]=[];
    const sorted=[...rows].sort((a,b)=>a.storage_key.localeCompare(b.storage_key));
    const db={query:async(sql:string,params:unknown[])=>{
        calls.push({sql,params});
        assert.match(sql,/^SELECT id,storage_key,checksum,byte_size FROM atlas_files/);
        const [cursor,limit]=params as [string,number];
        assert.ok(limit<=11 && limit>=2);
        return {rows:sorted.filter(x=>cursor === '' || x.storage_key>cursor).slice(0,limit)};
    }} as unknown as Pick<Pool,'query'>;
    return {db,calls};
}
function store(contents:Map<string,Buffer|undefined>,record:string[]){
    return {getBounded:async(key:string,max:number)=>{
        record.push(key);
        assert.equal(max,R2_RECOVERY_MAX_FILE_BYTES);
        if (!contents.has(key) || contents.get(key)===undefined) throw new ObjectNotFound();
        return contents.get(key)!;
    }};
}
const primaryConfig={
    endpoint:'https://0123456789abcdef.r2.cloudflarestorage.com/',
    bucket:'atlas-primary',accessKeyId:'source-id',secretAccessKey:'primary-key',
};
const backupEnv={
    ATLAS_R2_RECOVERY_ENDPOINT:'https://fedcba9876543210.r2.cloudflarestorage.com/',
    ATLAS_R2_RECOVERY_BUCKET:'atlas-restore',
    ATLAS_R2_RECOVERY_ACCESS_KEY_ID:'backup-read-only',
    ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY:'backup-secret',
};

test('Recovery configs must be independent and complete; CLI refuses mutation flags',()=>{
    assert.equal(loadRecoveryR2Config(backupEnv,primaryConfig).bucket,'atlas-restore');
    assert.throws(()=>loadRecoveryR2Config(backupEnv,null),/not configured/);
    assert.throws(()=>loadRecoveryR2Config({},primaryConfig),/must all be configured/);
    assert.throws(()=>loadRecoveryR2Config({
        ...backupEnv,ATLAS_R2_RECOVERY_ENDPOINT:primaryConfig.endpoint,
        ATLAS_R2_RECOVERY_BUCKET:primaryConfig.bucket,
    },primaryConfig),/must differ/);
    // Distinct buckets—even in different accounts—must not reuse a token
    // identity or secret: the two stores must have separate credentials.
    assert.throws(()=>loadRecoveryR2Config({
        ...backupEnv,ATLAS_R2_RECOVERY_ACCESS_KEY_ID:primaryConfig.accessKeyId,
        ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY:primaryConfig.secretAccessKey,
    },primaryConfig),/different access-key ID and secret/);
    assert.throws(()=>loadRecoveryR2Config({
        ...backupEnv,ATLAS_R2_RECOVERY_ACCESS_KEY_ID:primaryConfig.accessKeyId,
    },primaryConfig),/different access-key ID and secret/);
    assert.throws(()=>loadRecoveryR2Config({
        ...backupEnv,ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY:primaryConfig.secretAccessKey,
    },primaryConfig),/different access-key ID and secret/);
    assert.deepEqual(parseRecoveryVerifyArgs(['--dry-run']),{maxFiles:3});
    assert.deepEqual(parseRecoveryVerifyArgs(['--cursor='+fixture().storage_key,'--max-files=5','--dry-run']).maxFiles,5);
    for(const args of [
        [],['--apply'],['--dry-run','--apply'],['--dry-run','--dry-run'],
        ['--dry-run','--max-files=11'],['--dry-run','--max-files=0'],
        ['--dry-run','--max-files=2.5'],['--dry-run','--max-files=1','--max-files=1'],
        ['--dry-run','--cursor=../secret'],['--dry-run','--cursor=files-bad'],
    ])assert.throws(()=>parseRecoveryVerifyArgs(args));
});

test('read-only recovery verifies all committed primary and backup bytes including archived entries',async()=>{
    const one=fixture(Buffer.from('hello one')),two=fixture(Buffer.from('archived content'));
    const objects=new Map([[one.storage_key,Buffer.from('hello one')],[two.storage_key,Buffer.from('archived content')]]);
    const [primaryCalls,backupCalls]=[[],[]] as string[][];
    const {db,calls}=database([one,two]);
    const result=await verifyR2Recovery({database:db,primary:store(objects,primaryCalls),
        backup:store(objects,backupCalls)});
    assert.equal(result.status,'passed');
    assert.equal(result.checked,2);
    assert.equal(result.verifiedBoth,2);
    assert.equal(result.bytesRead,2*(one.byte_size+two.byte_size));
    assert.equal(result.entireCatalogChecked,true);
    assert.equal(result.noWrites,true);
    assert.equal(result.failureFileIds.length,0);
    assert.equal(primaryCalls.length,2);
    assert.equal(backupCalls.length,2);
    assert.equal(calls.length,1);
    assert.ok(calls.every(c=>c.sql.startsWith('SELECT ')));
});

test('recovery does not fall back to primary when backup is absent or corrupt',async()=>{
    const one=fixture(Buffer.from('a private document'));
    const two=fixture(Buffer.from('another private document'));
    const bytesOne=Buffer.from('a private document'),bytesTwo=Buffer.from('another private document');
    const entries=new Map([[one.storage_key,bytesOne],[two.storage_key,bytesTwo]]);
    const backup=new Map([[one.storage_key,bytesOne],[two.storage_key,Buffer.from('tampered')]]);
    backup.delete(one.storage_key);
    const {db}=database([one,two]);
    const report=await verifyR2Recovery({database:db,primary:store(entries,[]),backup:store(backup,[])});
    assert.equal(report.status,'failed');
    assert.equal(report.verifiedPrimary,2);
    assert.equal(report.verifiedBackup,0);
    assert.equal(report.backupMissing,1);
    assert.equal(report.backupCorrupt,1);
    assert.deepEqual(new Set(report.failureFileIds),new Set([one.id,two.id]));
});

test('backup can be independently recoverable even after primary source loss',async()=>{
    const data=Buffer.from('restore without source');
    const row=fixture(data);
    const {db}=database([row]);
    const report=await verifyR2Recovery({database:db,primary:store(new Map(),[]),
        backup:store(new Map([[row.storage_key,data]]),[])});
    assert.equal(report.status,'failed');
    assert.equal(report.primaryMissing,1);
    assert.equal(report.verifiedBackup,1);
    assert.equal(report.verifiedBoth,0);
});

test('batch cursor explicitly marks partial coverage and bounds remote GET requests',async()=>{
    const rows=Array.from({length:6},(_,i)=>fixture(Buffer.from('blob'+i)));
    const content=new Map(rows.map((row,i)=>[row.storage_key,Buffer.from('blob'+i)]));
    const {db}=database(rows);
    const primaryCalls:string[]=[],backupCalls:string[]=[];
    const first=await verifyR2Recovery({database:db,primary:store(content,primaryCalls),
        backup:store(content,backupCalls),maxFiles:2});
    assert.equal(first.status,'partial');
    assert.equal(first.entireCatalogChecked,false);
    assert.equal(first.remaining,true);
    assert.equal(first.checked,2);
    assert.equal(primaryCalls.length,2);
    assert.equal(backupCalls.length,2);
    assert.ok(first.nextCursor);
    const next=await verifyR2Recovery({database:db,primary:store(content,[]),
        backup:store(content,[]),maxFiles:2,cursor:first.nextCursor});
    assert.equal(next.status,'partial','cursor windows can never claim full-catalog proof');
    assert.equal(next.checked,2);
    const final=await verifyR2Recovery({database:db,primary:store(content,[]),
        backup:store(content,[]),maxFiles:2,cursor:next.nextCursor});
    assert.equal(final.checked,2);
    assert.equal(final.remaining,false);
    assert.equal(final.entireCatalogChecked,false);
    assert.equal(final.status,'partial');
});

test('bad metadata is not used to build an arbitrary R2 object GET',async()=>{
    const bad=fixture(Buffer.from('hello'));
    bad.storage_key='files-'+'0'.repeat(32)+'-'+'1'.repeat(64);
    const {db}=database([bad]);
    const requests:string[]=[];
    const empty=store(new Map(),requests);
    const report=await verifyR2Recovery({database:db,primary:empty,backup:empty});
    assert.equal(report.invalidMetadata,1);
    assert.equal(report.status,'failed');
    assert.equal(requests.length,0);
});

test('initial uncursored scan includes schema-allowed empty storage keys and never claims success',async()=>{
    const invalid=fixture(Buffer.from('broken imported metadata'));
    invalid.storage_key='';
    const goodBytes=Buffer.from('recoverable real object');
    const good=fixture(goodBytes);
    const primaryCalls:string[]=[],backupCalls:string[]=[];
    const {db,calls}=database([good,invalid]);
    const objects=new Map([[good.storage_key,goodBytes]]);
    const result=await verifyR2Recovery({
        database:db,primary:store(objects,primaryCalls),backup:store(objects,backupCalls),
    });
    assert.equal(result.checked,2);
    assert.equal(result.invalidMetadata,1);
    assert.equal(result.verifiedBoth,1);
    assert.equal(result.entireCatalogChecked,true);
    assert.equal(result.status,'failed','invalid row must never yield a passed backup drill');
    assert.deepEqual(result.failureFileIds,[invalid.id]);
    assert.deepEqual(primaryCalls,[good.storage_key]);
    assert.deepEqual(backupCalls,[good.storage_key]);
    assert.equal(calls[0]?.params[0],'');
    assert.match(calls[0]!.sql,/\$1 = '' OR storage_key > \$1/);
});

test('real migrated PostgreSQL schema permits empty storage key and the verifier flags it',async()=>{
    const fixtureDb=await databaseFixture();
    const goodBytes=Buffer.from('file accessible in separate R2 stores');
    const good=fixture(goodBytes);
    const broken=fixture(Buffer.from('empty metadata key'));
    broken.storage_key='';
    const ownerId=randomUUID();
    for (const row of [good,broken]) {
        await fixtureDb.store.pool.query(
            `INSERT INTO atlas_files (id,owner_kind,owner_id,storage_key,checksum,file_name,
                mime_type,byte_size,visibility,created_by) VALUES
                ($1,'workspace',$2,$3,$4,'document.bin','application/octet-stream',$5,'private','test')`,
            [row.id,ownerId,row.storage_key,row.checksum,row.byte_size],
        );
    }
    const source=new Map([[good.storage_key,goodBytes]]);
    const report=await verifyR2Recovery({
        database:fixtureDb.store.pool,
        primary:store(source,[]),
        backup:store(source,[]),
    });
    assert.equal(report.checked,2);
    assert.equal(report.verifiedBoth,1);
    assert.equal(report.invalidMetadata,1);
    assert.equal(report.status,'failed');
    assert.equal(report.entireCatalogChecked,true);
    assert.deepEqual(report.failureFileIds,[broken.id]);
});

test('network/auth failures abort verification and empty catalogue is not backup proof',async()=>{
    const row=fixture();
    const {db}=database([row]);
    await assert.rejects(verifyR2Recovery({database:db,
        primary:{getBounded:async()=>{throw new Error('R2 unavailable');}},
        backup:store(new Map(),[])}),/R2 unavailable/);
    const empty=await verifyR2Recovery({database:database([]).db,
        primary:store(new Map(),[]),backup:store(new Map(),[])});
    assert.equal(empty.status,'empty');
    assert.equal(empty.entireCatalogChecked,true);
    await assert.rejects(verifyR2Recovery({database:db,primary:store(new Map(),[]),
        backup:store(new Map(),[]),maxFiles:500}),/limit/);
});

test('bounded SigV4 GET requires valid key, rejects oversized streamed objects and advertized lengths',async()=>{
    const row=fixture(Buffer.from('good'));
    const urls:string[]=[];
    let responseBody='good',responseHeaders:Record<string,string>={};
    const signer=new R2ObjectStore(primaryConfig,(async(url,init)=>{
        urls.push(String(url));
        assert.equal(init?.method,'GET');
        assert.equal((init?.headers as Record<string,string>).authorization?.startsWith('AWS4-HMAC-SHA256'),true);
        return new Response(responseBody,{status:200,headers:responseHeaders});
    }) as typeof fetch);
    assert.equal((await signer.getBounded(row.storage_key,5)).toString(),'good');
    assert.equal(urls.length,1);
    assert.equal(new URL(urls[0]!).pathname,'/atlas-primary/'+row.storage_key);
    await assert.rejects(signer.getBounded('evil/../../../name',100),/Invalid Atlas media object key/);
    await assert.rejects(signer.getBounded(row.storage_key,0),/Invalid bounded/);
    responseHeaders={'content-length':'1000'};
    await assert.rejects(signer.getBounded(row.storage_key,4),/exceeds byte limit/);
    responseHeaders={};
    responseBody='longer than declared';
    await assert.rejects(signer.getBounded(row.storage_key,4),/exceeds byte limit/);
    responseBody='good';
    responseHeaders={'content-length':'2'};
    await assert.rejects(signer.getBounded(row.storage_key,10),/length differs/);
});
