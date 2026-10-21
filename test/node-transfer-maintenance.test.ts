import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { NodeFileIngestService } from '../apps/server/src/server/node-file-ingest.js';
import { NodeResumableTransferService } from '../apps/server/src/server/node-resumable-transfer.js';
import { AtlasFilesService } from '../apps/server/src/server/atlas-files.js';
import {
    previewNodeTransferCleanup, expireNodeTransferCheckpoints,
    parseNodeTransferMaintenanceArgs, NODE_TRANSFER_RETENTION_DAYS,
    NODE_TRANSFER_APPLY_CONFIRMATION,
} from '../apps/server/src/server/node-transfer-maintenance.js';

after(cleanupDatabases);
const DAY = 24 * 60 * 60 * 1000;
const CHECKSUM = 'a'.repeat(64);
async function setup() {
    const fixture = await databaseFixture();
    const pool = fixture.store.pool;
    const identity = new NodeIdentity(pool);
    const ticket = await identity.ticket();
    const node = await identity.enrol({token:ticket.enrolmentToken,name:'Retention phone',platform:'android'});
    const workspaceId = randomUUID();
    await pool.query('INSERT INTO logical_workspaces(id,name) VALUES($1,$2)',[workspaceId,'Retention']);
    await pool.query(`INSERT INTO workspaces(id,name,root_path,kind,adapter,node_id,logical_workspace_id)
        VALUES($1,'Retention','/mobile','generic',NULL,$2,$1)`,[workspaceId,node.nodeId]);
    const root=await mkdtemp(path.join(os.tmpdir(),'atlas-retention-'));
    const files=new AtlasFilesService(fixture.databaseUrl,root);
    const add=async ({status='active',ageDays=8,bytes=5,fileId=null}:{status?:'active'|'finalizing'|'complete';ageDays?:number;bytes?:number;fileId?:string|null}={})=>{
        const uploadId=randomUUID();
        const updated=new Date(Date.now()-ageDays*DAY);
        await pool.query(`INSERT INTO node_file_transfer_sessions
            (node_id,upload_id,workspace_id,file_name,mime_type,byte_size,checksum,status,completed_file_id,updated_at)
            VALUES($1,$2,$3,'capture.png','image/png',$4,$5,$6,$7,$8)`,
            [node.nodeId,uploadId,workspaceId,bytes,CHECKSUM,status,fileId,updated]);
        if(status!=='complete'){
            const payload=Buffer.from('part');
            await pool.query(`INSERT INTO node_file_transfer_parts
                (node_id,upload_id,part_index,byte_size,checksum,bytes)
                VALUES($1,$2,0,$3,$4,$5)`,
                [node.nodeId,uploadId,payload.length,CHECKSUM,payload]);
        }
        return uploadId;
    };
    return {pool,node,workspaceId,files,add,
        close:async()=>{await files.close();await rm(root,{recursive:true,force:true});}};
}

test('default CLI options dry-run, with explicit irreversible-operations confirmation required',()=>{
    assert.deepEqual(parseNodeTransferMaintenanceArgs([]),{apply:false,maxSessions:25});
    assert.deepEqual(parseNodeTransferMaintenanceArgs(['--dry-run','--max-sessions=2']),
        {apply:false,maxSessions:2});
    assert.deepEqual(parseNodeTransferMaintenanceArgs(['--apply','--confirm='+NODE_TRANSFER_APPLY_CONFIRMATION]),
        {apply:true,maxSessions:25});
    for(const args of [
        ['--apply'],['--confirm='+NODE_TRANSFER_APPLY_CONFIRMATION],['--max-sessions=0'],
        ['--max-sessions=101'],['--max-sessions=2.5'],['--apply','--dry-run'],
        ['--apply','--confirm=YES'],['--apply','--confirm='+NODE_TRANSFER_APPLY_CONFIRMATION,
            '--confirm='+NODE_TRANSFER_APPLY_CONFIRMATION],
    ]) assert.throws(()=>parseNodeTransferMaintenanceArgs(args));
    assert.equal(NODE_TRANSFER_RETENTION_DAYS,7);
});

test('preview never mutates; applied bounded retention removes only old active checkpoints',async()=>{
    const env=await setup();
    try{
        const oldA=await env.add({ageDays:8,bytes:25});
        const oldB=await env.add({ageDays:14,bytes:20});
        const recent=await env.add({ageDays:2,bytes:15});
        const finalizing=await env.add({status:'finalizing',ageDays:14,bytes:25});
        const file=await env.files.upload({owner:{kind:'workspace',id:env.workspaceId},
            fileName:'safe.png',mimeType:'image/png',bytes:Buffer.from('committed file')});
        const completed=await env.add({status:'complete',ageDays:200,bytes:14,fileId:file.id});
        const before=await env.pool.query('SELECT COUNT(*)::int AS count FROM node_file_transfer_parts');
        const snapshot=await previewNodeTransferCleanup(env.pool);
        assert.equal(snapshot.mode,'dry-run');
        assert.equal(snapshot.noDeletion,true);
        assert.equal(snapshot.staleActiveSessions,2);
        assert.equal(snapshot.staleReservedBytes,45);
        assert.equal(snapshot.staleStagedBytes,8);
        assert.equal(snapshot.staleFinalizingSessions,1);
        assert.equal((await env.pool.query('SELECT COUNT(*)::int AS count FROM node_file_transfer_parts')).rows[0].count,
            before.rows[0].count,'dry-run must never delete bytes');

        const first=await expireNodeTransferCheckpoints(env.pool,{maxSessions:1});
        assert.equal(first.removedSessions,1);
        assert.equal(first.pendingFinalizingPreserved,true);
        const second=await expireNodeTransferCheckpoints(env.pool,{maxSessions:1});
        assert.equal(second.removedSessions,1);
        const third=await expireNodeTransferCheckpoints(env.pool,{maxSessions:10});
        assert.equal(third.removedSessions,0);
        const stored=(await env.pool.query<{upload_id:string,status:string}>(
            'SELECT upload_id,status FROM node_file_transfer_sessions')).rows;
        assert.deepEqual(new Set(stored.map(x=>x.upload_id)),new Set([recent,finalizing,completed]));
        const remainingParts=(await env.pool.query<{upload_id:string}>(
            'SELECT upload_id FROM node_file_transfer_parts')).rows;
        assert.deepEqual(new Set(remainingParts.map(x=>x.upload_id)),new Set([recent,finalizing]));
        assert.equal((await env.files.download({kind:'workspace',id:env.workspaceId},file.id)).bytes.toString(),
            'committed file');
        assert.ok(!stored.find(x=>x.upload_id===oldA));
        assert.ok(!stored.find(x=>x.upload_id===oldB));
    }finally{await env.close();}
});

test('locked checkpoints are skipped and last-minute updates prevent deletion',async()=>{
    const env=await setup();
    const held=await env.pool.connect();
    try{
        const old=await env.add({ageDays:9,bytes:18});
        await held.query('BEGIN');
        await held.query(`SELECT upload_id FROM node_file_transfer_sessions
            WHERE node_id=$1 AND upload_id=$2 FOR UPDATE`,[env.node.nodeId,old]);
        assert.equal((await expireNodeTransferCheckpoints(env.pool,{maxSessions:3})).removedSessions,0,
            'SKIP LOCKED must not wait or delete an actively locked upload');
        await held.query('UPDATE node_file_transfer_sessions SET updated_at=now() WHERE node_id=$1 AND upload_id=$2',
            [env.node.nodeId,old]);
        await held.query('COMMIT');
        assert.equal((await expireNodeTransferCheckpoints(env.pool)).removedSessions,0,
            'recently updated session must be preserved even after dry-run marked it stale');
        await env.pool.query('UPDATE node_file_transfer_sessions SET updated_at=$3 WHERE node_id=$1 AND upload_id=$2',
            [env.node.nodeId,old,new Date(Date.now()-9*DAY)]);
        assert.equal((await expireNodeTransferCheckpoints(env.pool)).removedSessions,1);
    }finally{await held.query('ROLLBACK').catch(()=>undefined);held.release();await env.close();}
});

test('a successful resumable init refreshes inactivity age before cleanup can claim it',async()=>{
    const env=await setup();
    try {
        const uploadId=await env.add({ageDays:9,bytes:5});
        const identity=new NodeIdentity(env.pool);
        const ingest=new NodeFileIngestService(env.pool,identity,env.files);
        const resumable=new NodeResumableTransferService(env.pool,ingest);
        assert.equal((await previewNodeTransferCleanup(env.pool)).staleActiveSessions,1);
        const result=await resumable.init({
            nodeId:env.node.nodeId,credential:env.node.credential,workspaceId:env.workspaceId,
            uploadId,fileName:'capture.png',mimeType:'image/png',byteSize:5,checksum:CHECKSUM,
        });
        assert.deepEqual(result.received,[0]);
        assert.equal((await previewNodeTransferCleanup(env.pool)).staleActiveSessions,0);
        assert.equal((await expireNodeTransferCheckpoints(env.pool)).removedSessions,0);
        assert.equal((await env.pool.query('SELECT COUNT(*)::int AS count FROM node_file_transfer_parts')).rows[0].count,1);
    } finally { await env.close(); }
});

test('invalid timestamps and unsafe batch sizes fail closed',async()=>{
    const env=await setup();
    try{
        await assert.rejects(previewNodeTransferCleanup(env.pool,new Date('invalid')),/timestamp/);
        await assert.rejects(expireNodeTransferCheckpoints(env.pool,{maxSessions:1000}),/between 1 and 100/);
        await assert.rejects(expireNodeTransferCheckpoints(env.pool,{maxSessions:-1}),/between 1 and 100/);
    }finally{await env.close();}
});
