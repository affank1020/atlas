import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { NodeFileIngestService } from '../apps/server/src/server/node-file-ingest.js';
import { NodeResumableTransferService, NODE_PART_BYTES } from '../apps/server/src/server/node-resumable-transfer.js';
import { AtlasFilesService } from '../apps/server/src/server/atlas-files.js';
import { serveNodeResumableRequest } from '../apps/server/src/api/http/node-resumable.js';
import { uploadNodeFileResumable } from '../apps/node/src/core/file-transfer.js';
import type { ServerServices } from '../apps/server/src/server/composition.js';

after(cleanupDatabases);
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function setup(name: string) {
    const fixture = await databaseFixture();
    const ticket = await new NodeIdentity(fixture.store.pool).ticket();
    const identity = new NodeIdentity(fixture.store.pool);
    const node = await identity.enrol({ token: ticket.enrolmentToken, name, platform: 'android' });
    const workspaceId = randomUUID();
    const pool = fixture.store.pool;
    await pool.query('INSERT INTO logical_workspaces(id,name) VALUES($1,$2)', [workspaceId,name]);
    await pool.query(`INSERT INTO workspaces(id,name,root_path,kind,adapter,node_id,logical_workspace_id)
        VALUES($1,$2,'/mobile','generic',NULL,$3,$1)`, [workspaceId,name,node.nodeId]);
    const root = await mkdtemp(path.join(os.tmpdir(),'atlas-resumable-'));
    const files = new AtlasFilesService(fixture.databaseUrl,root);
    const ingest = new NodeFileIngestService(pool,identity,files);
    const service = new NodeResumableTransferService(pool,ingest);
    const identityInfo = { nodeId:node.nodeId,credential:node.credential,workspaceId,uploadId:randomUUID() };
    return { pool,files,ingest,service,identityInfo,node,root,
        close:async()=>{ await files.close();await rm(root,{recursive:true,force:true}); } };
}

test('Resumable checkpoints survive service restarts and finalize to exactly one verified file',async()=>{
    const env=await setup('Capture Node');
    try {
        const bytes=Buffer.alloc(NODE_PART_BYTES*2+17,0x6a);
        const meta={...env.identityInfo,fileName:'capture.png',mimeType:'image/png',
            byteSize:bytes.length,checksum:sha(bytes)};
        const init=await env.service.init(meta);
        assert.deepEqual(init.received,[]);
        assert.equal(init.chunkBytes,NODE_PART_BYTES);
        await assert.rejects(env.service.complete(env.identityInfo),/incomplete/);
        const last=bytes.subarray(NODE_PART_BYTES*2);
        await env.service.chunk({...env.identityInfo,index:2,bytes:last,checksum:sha(last)});
        const first=bytes.subarray(0,NODE_PART_BYTES);
        const second=bytes.subarray(NODE_PART_BYTES,NODE_PART_BYTES*2);
        assert.deepEqual((await env.service.status(env.identityInfo)).received,[2]);
        // A new process/service instance must observe durable bytea checkpoints.
        const afterRestart=new NodeResumableTransferService(env.pool,env.ingest);
        assert.equal((await afterRestart.chunk({...env.identityInfo,index:2,bytes:last,checksum:sha(last)})).replayed,true);
        await assert.rejects(afterRestart.chunk({...env.identityInfo,index:2,bytes:Buffer.alloc(17,0x3),
            checksum:sha(Buffer.alloc(17,0x3))}),e=>(e as {code:string}).code==='CONFLICT');
        await afterRestart.chunk({...env.identityInfo,index:0,bytes:first,checksum:sha(first)});
        await afterRestart.chunk({...env.identityInfo,index:1,bytes:second,checksum:sha(second)});
        assert.deepEqual((await env.service.status(env.identityInfo)).received,[0,1,2]);
        const saved=await afterRestart.complete(env.identityInfo);
        const got=await env.files.download({kind:'workspace',id:env.identityInfo.workspaceId},saved.fileId);
        assert.deepEqual(got.bytes,bytes);
        assert.equal((await afterRestart.complete(env.identityInfo)).fileId,saved.fileId);
        assert.equal((await afterRestart.init(meta)).completed,true);
        const retained=await env.pool.query('SELECT COUNT(*)::int AS count FROM node_file_transfer_parts WHERE node_id=$1 AND upload_id=$2',
            [env.identityInfo.nodeId,env.identityInfo.uploadId]);
        assert.equal(retained.rows[0].count,0,'completed upload must release all database staging bytes');
        assert.equal((await env.files.list({kind:'workspace',id:env.identityInfo.workspaceId})).length,1);
        await assert.rejects(afterRestart.abort(env.identityInfo),/Completed transfers/);
    }finally{await env.close();}
});

test('Staging reservations are bounded, identity-scoped and explicitly abortable',async()=>{
    const env=await setup('Quota Phone');
    try{
        const meta=(uploadId:string)=>({...env.identityInfo,uploadId,fileName:'video.bin',
            mimeType:'application/octet-stream',byteSize:25*NODE_PART_BYTES,checksum:'f'.repeat(64)});
        const one=randomUUID(),two=randomUUID(),three=randomUUID();
        await env.service.init(meta(one));
        await env.service.init(meta(two));
        await assert.rejects(env.service.init(meta(three)),e=>(e as {code:string}).code==='QUOTA_EXCEEDED');
        await assert.rejects(env.service.init({...meta(one),fileName:'different.bin'}),e=>(e as {code:string}).code==='CONFLICT');
        await assert.rejects(env.service.status({...env.identityInfo,uploadId:one,workspaceId:randomUUID()}));
        await assert.rejects(env.service.status({...env.identityInfo,uploadId:one,credential:'bad-token'}));
        assert.deepEqual(await env.service.abort({...env.identityInfo,uploadId:one}),{aborted:true});
        await env.service.init(meta(three));
        assert.equal((await env.service.status({...env.identityInfo,uploadId:three})).completed,false);
        await assert.rejects(env.service.chunk({...env.identityInfo,uploadId:two,index:25,
            bytes:Buffer.from('x'),checksum:sha(Buffer.from('x'))}),/out of range|Invalid Node transfer chunk/);
    }finally{await env.close();}
});

test('Feature-flagged HTTP endpoint authenticates before body, resumes missing chunks and rejects browser Origins',async()=>{
    const env=await setup('HTTP Tablet');
    const services={config:{nodeFiles:{enabled:true}},nodeFileIngest:env.ingest,
        nodeResumable:env.service} as ServerServices;
    const server=createServer((req,res)=>{void serveNodeResumableRequest(req,res,services);});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const port=(server.address() as AddressInfo).port;
    const base=`http://127.0.0.1:${port}/node/files/resumable/`;
    const headers={authorization:`Bearer ${env.identityInfo.credential}`,
        'x-atlas-node-id':env.identityInfo.nodeId,
        'x-atlas-workspace-id':env.identityInfo.workspaceId,
        'x-atlas-upload-id':env.identityInfo.uploadId};
    try{
        assert.equal((await fetch(base+'status',{method:'POST',headers:{...headers,origin:'https://untrusted.test',
            'content-type':'application/json'},body:'{}'})).status,403);
        assert.equal((await fetch(base+'status',{method:'POST',headers:{...headers,authorization:'Bearer invalid',
            'content-type':'application/json'},body:'{}'})).status,401);
        const bytes=Uint8Array.from([10,20,30,40,50]);
        // Node helper converts localhost ws:// to HTTP, persists caller UUID.
        const result=await uploadNodeFileResumable({...env.identityInfo,serverUrl:`ws://127.0.0.1:${port}/node/connect`,
            fileName:'mobile.png',mimeType:'image/png',bytes});
        assert.equal(typeof result.fileId,'string');
        assert.deepEqual((await env.files.download({kind:'workspace',id:env.identityInfo.workspaceId},result.fileId)).bytes,
            Buffer.from(bytes));
        const repeat=await uploadNodeFileResumable({...env.identityInfo,serverUrl:`ws://127.0.0.1:${port}/node/connect`,
            fileName:'mobile.png',mimeType:'image/png',bytes});
        assert.equal(repeat.replayed,true);
        assert.equal(repeat.fileId,result.fileId);
        const tooLarge=await fetch(base+'chunk',{method:'POST',headers:{...headers,'content-type':'application/octet-stream',
            'x-atlas-part-index':'0','x-atlas-part-sha256':'a'.repeat(64)},
            body:Buffer.alloc(NODE_PART_BYTES+1)});
        assert.equal(tooLarge.status,413);
        const disabled={...services,config:{...services.config,nodeFiles:{enabled:false}}} as ServerServices;
        const disabledServer=createServer((req,res)=>{void serveNodeResumableRequest(req,res,disabled);});
        disabledServer.listen(0,'127.0.0.1');await once(disabledServer,'listening');
        try{
            const response=await fetch(`http://127.0.0.1:${(disabledServer.address() as AddressInfo).port}/node/files/resumable/status`,
                {method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'});
            assert.equal(response.status,404);
        }finally{disabledServer.closeAllConnections();await new Promise<void>(resolve=>disabledServer.close(()=>resolve()));}
    }finally{
        server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
        await env.close();
    }
});
