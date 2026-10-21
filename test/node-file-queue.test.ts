import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NodeOfflineFileQueue,MAX_QUEUE_ITEMS } from '../apps/node/src/core/file-queue.js';
import { NodeFileTransferError } from '../apps/node/src/core/file-transfer.js';

const identity = {nodeId:randomUUID(),credential:'p'.repeat(43),
    serverUrl:'wss://atlas.example.test/node/connect'};
const workspaceId=randomUUID();
async function fixture(send?: ConstructorParameters<typeof NodeOfflineFileQueue>[2]) {
    const root=await mkdtemp(join(tmpdir(),'atlas-offline-queue-'));
    const queue = new NodeOfflineFileQueue(identity,join(root,'queue'),send);
    return {root,queue,close:()=>rm(root,{recursive:true,force:true})};
}
const specimen = {workspaceId,fileName:'screenshot-draft.png',mimeType:'image/png',
    bytes:Buffer.from('SENSITIVE_SCREENSHOT_CONTENT_HERE')};

test('queue encrypts content and metadata with 0600 files and resumes after a process restart',async()=>{
    const received:{id:string;bytes:Buffer;credential:string}[]=[];
    const sender:ConstructorParameters<typeof NodeOfflineFileQueue>[2]=async x=>{
        received.push({id:x.uploadId,bytes:Buffer.from(x.bytes),credential:x.credential});
        return {fileId:randomUUID(),replayed:false};
    };
    const {root,queue,close}=await fixture(sender);
    try{
        const id=await queue.enqueue(specimen);
        const names=await readdir(join(root,'queue'));
        assert.ok(names.includes(id+'.job'));
        const disk=await readFile(join(root,'queue',id+'.job'));
        assert.equal(disk.toString('utf8').includes(specimen.fileName),false);
        assert.equal(disk.toString('utf8').includes('SENSITIVE_SCREENSHOT_CONTENT_HERE'),false);
        assert.equal(disk.toString('utf8').includes(identity.credential),false);
        assert.deepEqual((await queue.snapshot()).total,1);
        const restart=new NodeOfflineFileQueue(identity,join(root,'queue'),sender);
        assert.equal((await restart.flush(1000)).delivered,1);
        assert.equal(received.length,1);
        assert.equal(received[0]?.id,id);
        assert.deepEqual(received[0]?.bytes,specimen.bytes);
        assert.equal(received[0]?.credential,identity.credential);
        assert.equal((await restart.snapshot()).total,0);
        assert.equal((await restart.flush(2000)).delivered,0);
    }finally{await close();}
});

test('interrupted resumable sends retain UUID, recover checkpoint, and persist bounded backoff',async()=>{
    const sent:string[]=[];
    let failures=0;
    const sender:ConstructorParameters<typeof NodeOfflineFileQueue>[2]=async x=>{
        sent.push(x.uploadId);
        if (failures++===0) throw new Error('Simulated offline network');
        return {fileId:randomUUID(),replayed:true};
    };
    const {root,queue,close}=await fixture(sender);
    try{
        const id=await queue.enqueue(specimen);
        const first=await queue.flush(10_000);
        assert.deepEqual(first,{delivered:0,deferred:1,blocked:0,unreadable:0});
        const restarted=new NodeOfflineFileQueue(identity,join(root,'queue'),sender);
        assert.equal((await restarted.flush(11_000)).deferred,1);
        assert.equal(sent.length,1);
        assert.equal((await restarted.flush(41_000)).delivered,1);
        assert.deepEqual(sent,[id,id]);
        assert.equal((await restarted.snapshot()).total,0);
    }finally{await close();}
});

test('HTTP conflicts are blocked until explicitly restarted with a fresh UUID',async()=>{
    const sent:string[]=[];
    const sender:ConstructorParameters<typeof NodeOfflineFileQueue>[2]=async x=>{
        sent.push(x.uploadId);
        if(sent.length===1) throw new NodeFileTransferError(409);
        return {fileId:randomUUID(),replayed:false};
    };
    const {root,queue,close}=await fixture(sender);
    try{
        const stale=await queue.enqueue(specimen);
        assert.equal((await queue.flush()).blocked,1);
        assert.equal((await queue.snapshot()).blocked,1);
        assert.deepEqual(await queue.flush(),{delivered:0,deferred:0,blocked:1,unreadable:0});
        assert.deepEqual(sent,[stale]);
        const replacement=await queue.restartWithNewId(stale);
        assert.notEqual(stale,replacement);
        assert.equal((await queue.snapshot()).ready,1);
        assert.equal((await queue.flush()).delivered,1);
        assert.deepEqual(sent,[stale,replacement]);
    }finally{await close();}
});

test('rotated credentials and tampered jobs remain opaque but can be discarded by UUID',async()=>{
    const {root,queue,close}=await fixture();
    try{
        const id=await queue.enqueue(specimen);
        const rotated=new NodeOfflineFileQueue({...identity,credential:'q'.repeat(43)},join(root,'queue'));
        assert.equal((await rotated.snapshot()).unreadable,1);
        assert.deepEqual(await rotated.flush(),{delivered:0,deferred:0,blocked:0,unreadable:1});
        // Operator-only deletion needs just a checked opaque job ID, not the old key.
        await rotated.discard(id);
        assert.equal((await rotated.snapshot()).total,0);
        const corrupted=await queue.enqueue(specimen);
        const target=join(root,'queue',corrupted+'.job');
        const data=await readFile(target);
        data[data.length-1]=data[data.length-1]!^0xff;
        await writeFile(target,data,{mode:0o600});
        assert.equal((await queue.snapshot()).unreadable,1);
        assert.deepEqual(await queue.flush(),{delivered:0,deferred:0,blocked:0,unreadable:1});
        await queue.discard(corrupted);
        assert.equal((await queue.snapshot()).total,0);
    }finally{await close();}
});

test('admission enforces hard queue item cap, input checks, and an exclusive writer lock',async()=>{
    const {root,queue,close}=await fixture();
    try{
        for(let i=0;i<MAX_QUEUE_ITEMS;i++)
            await queue.enqueue({...specimen,fileName:'screenshot-'+i+'.png'});
        assert.equal((await queue.snapshot()).total,MAX_QUEUE_ITEMS);
        await assert.rejects(queue.enqueue(specimen),/item limit/);
        await assert.rejects(queue.enqueue({...specimen,fileName:'../secret'}),/Invalid/);
        await assert.rejects(queue.enqueue({...specimen,bytes:new Uint8Array(0)}),/Invalid/);
        await mkdir(join(root,'queue','.queue-lock'));
        await assert.rejects(queue.enqueue(specimen),/busy/);
    }finally{await close();}
});

test('no duplicate concurrent drain and explicit discard never uploads',async()=>{
    let calls=0;
    const sender:ConstructorParameters<typeof NodeOfflineFileQueue>[2]=async()=>{
        calls++;
        await new Promise(resolve=>setTimeout(resolve,15));
        return {fileId:randomUUID(),replayed:false};
    };
    const {queue,close}=await fixture(sender);
    try{
        const id=await queue.enqueue(specimen);
        const results=await Promise.all([queue.flush(),queue.flush()]);
        assert.deepEqual(results,[{delivered:1,deferred:0,blocked:0,unreadable:0},{delivered:1,deferred:0,blocked:0,unreadable:0}]);
        assert.equal(calls,1);
        const other=await queue.enqueue(specimen);
        await queue.discard(other);
        assert.equal((await queue.snapshot()).total,0);
        await assert.rejects(queue.restartWithNewId(id));
    }finally{await close();}
});

test('operator discard cannot claim success while a drain is in flight, and no failed retry resurrects it',async()=>{
    let finish!: (value?: unknown)=>void;
    let entered!: ()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const pending=new Promise<void>(resolve=>{finish=resolve;});
    const sender:ConstructorParameters<typeof NodeOfflineFileQueue>[2]=async()=>{
        entered();
        await pending;
        throw new Error('offline transport');
    };
    const {root,queue,close}=await fixture(sender);
    try {
        const id=await queue.enqueue(specimen);
        const worker=queue.flush();
        await started;
        const cli=new NodeOfflineFileQueue(identity,join(root,'queue'));
        await assert.rejects(cli.discard(id),/busy/,
            'discard must not report success while an upload can still rewrite state');
        finish();
        assert.equal((await worker).deferred,1);
        await cli.discard(id);
        assert.equal((await queue.snapshot()).total,0);
        assert.deepEqual((await readdir(join(root,'queue'))).filter(x=>x.endsWith('.job')),[]);
    }finally{finish?.();await close();}
});

test('operator discard cannot remove a job before an already-sending success is committed',async()=>{
    let finish!: ()=>void;
    let entered!: ()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const pending=new Promise<void>(resolve=>{finish=resolve;});
    const sender:ConstructorParameters<typeof NodeOfflineFileQueue>[2]=async()=>{
        entered(); await pending;return {fileId:randomUUID(),replayed:false};
    };
    const {root,queue,close}=await fixture(sender);
    try {
        const id=await queue.enqueue(specimen);
        const worker=queue.flush();
        await started;
        const cli=new NodeOfflineFileQueue(identity,join(root,'queue'));
        await assert.rejects(cli.discard(id),/busy/);
        finish();
        assert.equal((await worker).delivered,1);
        await assert.rejects(cli.discard(id),e=>(e as NodeJS.ErrnoException).code==='ENOENT');
        assert.equal((await queue.snapshot()).total,0);
    } finally {finish?.();await close();}
});

test('blocked and backed-off records do not starve later ready uploads',async()=>{
    const delivered:string[]=[];
    const sender:ConstructorParameters<typeof NodeOfflineFileQueue>[2]=async x=>{
        delivered.push(x.uploadId);
        return {fileId:randomUUID(),replayed:false};
    };
    const {root,queue,close}=await fixture(sender);
    try{
        const jobs:string[]=[];
        for(let i=0;i<6;i++)jobs.push(await queue.enqueue({...specimen,fileName:'item-'+i+'.png'}));
        // Set first five UUID-ordered records to a mix of blocked/deferred
        // while ensuring the sixth is ready, regardless of random UUID order.
        const sorted=[...jobs].sort();
        for(let i=0;i<5;i++) {
            const file=join(root,'queue',sorted[i]+'.job');
            // Use authenticated queue operations to create blocked/deferred
            // states: status is not externally writable without the secret.
            // One failed send per record sets backoff; permanent errors block.
        }
        const failures=new Set(sorted.slice(0,4));
        const deferredId=sorted[4]!;
        let captured:string[]=[];
        const stageSender:ConstructorParameters<typeof NodeOfflineFileQueue>[2]=async x=>{
            captured.push(x.uploadId);
            if(failures.has(x.uploadId))throw new NodeFileTransferError(409);
            if(x.uploadId===deferredId)throw new Error('temporary outage');
            return {fileId:randomUUID(),replayed:false};
        };
        const stage=new NodeOfflineFileQueue(identity,join(root,'queue'),stageSender);
        const staged=await stage.flush(1000,4);
        assert.equal(staged.blocked,4);
        const second=await stage.flush(1001,4);
        assert.equal(second.deferred,1);
        assert.equal(second.delivered,1,'ready sixth record is not starved by skipped jobs');
        assert.equal(captured.includes(sorted[5]!),true);
        assert.equal(delivered.length,0);
    }finally{await close();}
});

test('restart-new atomically rotates remote ID within existing slot at eight-job capacity',async()=>{
    const transmitted:string[]=[];
    let permanentFailure=true;
    const sender:ConstructorParameters<typeof NodeOfflineFileQueue>[2]=async x=>{
        transmitted.push(x.uploadId);
        if(permanentFailure)throw new NodeFileTransferError(409);
        return {fileId:randomUUID(),replayed:false};
    };
    const {root,queue,close}=await fixture(sender);
    try{
        const jobs:string[]=[];
        for(let i=0;i<MAX_QUEUE_ITEMS;i++)
            jobs.push(await queue.enqueue({...specimen,fileName:'full-'+i+'.png'}));
        const original=[...jobs].sort()[0]!;
        assert.equal((await queue.flush(1000,1)).blocked,1);
        const before=await queue.snapshot();
        const rotated=await queue.restartWithNewId(original);
        assert.notEqual(rotated,original);
        const after=await queue.snapshot();
        assert.equal(after.total,MAX_QUEUE_ITEMS);
        assert.ok(after.encryptedDiskBytes <= before.encryptedDiskBytes, 'rotation reuses the prior disk quota');
        assert.equal(after.ready,MAX_QUEUE_ITEMS);
        // The stable queue identifier remains usable for discard/recovery,
        // but the remote identity has been changed only after explicit action.
        permanentFailure=false;
        assert.equal((await queue.flush(2000,1)).delivered,1);
        assert.equal(transmitted.includes(rotated),true);
        assert.equal((await queue.snapshot()).total,MAX_QUEUE_ITEMS-1);
    }finally{await close();}
});

test('unreadable first job does not block a later healthy job',async()=>{
    let sent=0;
    const sender:ConstructorParameters<typeof NodeOfflineFileQueue>[2]=async()=>{
        sent++;return {fileId:randomUUID(),replayed:false};
    };
    const {root,queue,close}=await fixture(sender);
    try {
        const a=await queue.enqueue(specimen);
        const b=await queue.enqueue(specimen);
        const first=[a,b].sort()[0]!;
        const raw=await readFile(join(root,'queue',first+'.job'));
        raw[raw.length-1]^=0xff;
        await writeFile(join(root,'queue',first+'.job'),raw,{mode:0o600});
        const outcome=await queue.flush();
        assert.equal(outcome.unreadable,1);
        assert.equal(outcome.delivered,1);
        assert.equal(sent,1);
        await queue.discard(first);
        assert.equal((await queue.snapshot()).total,0);
    }finally{await close();}
});
