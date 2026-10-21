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
        assert.deepEqual(first,{delivered:0,deferred:1,blocked:0});
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
        assert.deepEqual(await queue.flush(),{delivered:0,deferred:0,blocked:1});
        assert.deepEqual(sent,[stale]);
        const replacement=await queue.restartWithNewId(stale);
        assert.notEqual(stale,replacement);
        assert.equal((await queue.snapshot()).ready,1);
        assert.equal((await queue.flush()).delivered,1);
        assert.deepEqual(sent,[stale,replacement]);
    }finally{await close();}
});

test('queue fails closed on credential rotation or modified encrypted bytes',async()=>{
    const {root,queue,close}=await fixture();
    try{
        const id=await queue.enqueue(specimen);
        const rotated=new NodeOfflineFileQueue({...identity,credential:'q'.repeat(43)},join(root,'queue'));
        await assert.rejects(rotated.snapshot(),/authenticat|Unsupported state|decipher|bad decrypt/i);
        const target=join(root,'queue',id+'.job');
        const data=await readFile(target);
        data[data.length-1]=data[data.length-1]!^0xff;
        await writeFile(target,data,{mode:0o600});
        await assert.rejects(queue.flush(),/authenticat|Unsupported state|decipher|bad decrypt/i);
        assert.ok((await readdir(join(root,'queue'))).includes(id+'.job'),
            'corrupted payload must never be silently deleted');
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
        await mkdir(join(root,'queue','.enqueue-lock'));
        await assert.rejects(queue.enqueue(specimen),/EEXIST/);
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
        assert.deepEqual(results,[{delivered:1,deferred:0,blocked:0},{delivered:1,deferred:0,blocked:0}]);
        assert.equal(calls,1);
        const other=await queue.enqueue(specimen);
        await queue.discard(other);
        assert.equal((await queue.snapshot()).total,0);
        await assert.rejects(queue.restartWithNewId(id));
    }finally{await close();}
});
