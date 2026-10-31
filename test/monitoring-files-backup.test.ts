import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';
import { AuditService } from '../apps/server/src/core/audit.js';
import { recordR2SeedObservation } from '../apps/server/src/server/operational-audit.js';
import { projectMonitoringEvent } from '../apps/server/src/core/monitoring-projection.js';
import type { SeedReport } from '../apps/server/src/server/r2-backup-seeding.js';
import type { AuditEvent } from '../apps/server/src/types.js';

after(cleanupDatabases);
const bytesHash = 'a'.repeat(64);
const fileRow = (id: string, kind: string, owner: string, folderId: string | null = null) => ({
    id, owner_kind: kind, owner_id: owner,
    storage_key: `files-${id.replaceAll('-', '')}-${bytesHash}`,
    checksum: bytesHash, file_name: 'PRIVATE_FILE_NAME', mime_type: 'text/plain',
    byte_size: 12, visibility: 'private', created_by: 'UNTRUSTED_ACTOR',
    folder_id: folderId,
});
async function insertFile(db: { query: (sql: string, values?: unknown[]) => Promise<any> },
    file: ReturnType<typeof fileRow>) {
    return db.query(`INSERT INTO atlas_files
        (id,owner_kind,owner_id,storage_key,checksum,file_name,mime_type,byte_size,visibility,created_by,folder_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [file.id,file.owner_kind,file.owner_id,file.storage_key,file.checksum,file.file_name,
            file.mime_type,file.byte_size,file.visibility,file.created_by,file.folder_id]);
}
function safe(event: any) { return event.resulting as Record<string, unknown>; }

test('Files and folder mutations are audited with DB-derived Project ownership and no names, paths or actor claims', async () => {
    const f = await databaseFixture();
    const project = await f.catalog.createProject({ name: 'Files audit Project' });
    const other = await f.catalog.createProject({ name: 'Other Project' });
    const folderA = randomUUID(), folderB = randomUUID(), fileId = randomUUID();
    await f.store.pool.query(`INSERT INTO atlas_file_folders(id,project_id,name,created_by)
        VALUES($1,$2,'PRIVATE_FOLDER_NAME','UNTRUSTED_ACTOR'),($3,$2,'SECOND_FOLDER','UNTRUSTED_ACTOR')`,
        [folderA,project.id,folderB]);
    await f.store.pool.query(`UPDATE atlas_file_folders SET name='RENAMED_PRIVATE' WHERE id=$1`,[folderA]);
    await f.store.pool.query(`UPDATE atlas_file_folders SET name='RENAMED_PRIVATE' WHERE id=$1`,[folderA]);
    await insertFile(f.store.pool,fileRow(fileId,'project',project.id,folderA));
    await f.store.pool.query(`UPDATE atlas_files SET folder_id=$2 WHERE id=$1`,[fileId,folderB]);
    await f.store.pool.query(`UPDATE atlas_files SET status='archived' WHERE id=$1`,[fileId]);
    await f.store.pool.query(`UPDATE atlas_files SET status='active' WHERE id=$1`,[fileId]);
    await f.store.pool.query(`UPDATE atlas_files SET status='active' WHERE id=$1`,[fileId]);
    const audit = new AuditService(f.store);
    const page = await audit.monitoring({ projectId:project.id,category:'files',
        groupOperations:true,safeDetails:true,limit:100 });
    assert.deepEqual(page.items.map(e=>e.operation).sort(), [
        'files.archived','files.folder_created','files.folder_created','files.folder_renamed',
        'files.moved','files.restored','files.uploaded',
    ]);
    assert.equal(page.total,7);
    assert.ok(page.items.every(e=>e.client==='atlas-files-db' && e.projectId===project.id));
    assert.equal((await audit.monitoring({projectId:other.id,category:'files'})).total,0);
    const moved=page.items.find(e=>e.operation==='files.moved')!;
    assert.deepEqual(safe(moved),{fileId,folderId:folderB,previousFolderId:folderA,
        ownerKind:'project',source:'database-trigger'});
    assert.ok(!JSON.stringify(page).includes('PRIVATE_FILE_NAME'));
    assert.ok(!JSON.stringify(page).includes('PRIVATE_FOLDER_NAME'));
    assert.ok(!JSON.stringify(page).includes('UNTRUSTED_ACTOR'));
    assert.equal((await audit.monitoring({projectId:project.id,category:'files',operation:'files.archived'})).total,1);
});

test('Workspace-owned file audit uses stored checkout Project scope and never leaks to other Projects',async()=>{
    const f=await databaseFixture();
    const first=await f.catalog.createProject({name:'Workspace file owner'});
    const other=await f.catalog.createProject({name:'Unrelated workspace'});
    const local=(await f.store.pool.query("SELECT id FROM nodes WHERE local_key='local' LIMIT 1")).rows[0]!.id;
    const logical=(await f.store.pool.query(`INSERT INTO logical_workspaces(id,name) VALUES(gen_random_uuid(),'Files scope') RETURNING id`)).rows[0]!.id;
    const checkout=(await f.store.pool.query(`INSERT INTO workspaces(id,project_id,name,root_path,kind,adapter,node_id,logical_workspace_id)
        VALUES(gen_random_uuid(),$1,'Files scope','/tmp','generic',NULL,$2,$3) RETURNING id`,
        [first.id,local,logical])).rows[0]!.id as string;
    const fileId=randomUUID();
    await insertFile(f.store.pool,fileRow(fileId,'workspace',checkout));
    const audit=new AuditService(f.store);
    const scoped=await audit.monitoring({projectId:first.id,workspaceId:checkout,category:'files',safeDetails:true});
    assert.equal(scoped.total,1);
    assert.equal(scoped.items[0]?.workspaceId,checkout);
    assert.deepEqual(safe(scoped.items[0]),{fileId,ownerKind:'workspace',source:'database-trigger'});
    assert.equal((await audit.monitoring({projectId:other.id,category:'files'})).total,0);
    assert.equal((await audit.monitoring({workspaceId:randomUUID(),category:'files'})).total,0);
});

test('Rolled-back Files mutations never create orphan audit evidence',async()=>{
    const f=await databaseFixture(),project=await f.catalog.createProject({name:'Atomic Files'});
    const client=await f.store.pool.connect(),id=randomUUID();
    try {
        await client.query('BEGIN');
        await insertFile(client,fileRow(id,'project',project.id));
        await client.query('ROLLBACK');
    } finally {client.release();}
    const total=await f.store.pool.query(`SELECT count(*)::int AS total FROM audit_events
        WHERE operation='files.uploaded' AND after_state->>'fileId'=$1`,[id]);
    assert.equal(total.rows[0]!.total,0);
    assert.equal((await f.store.pool.query('SELECT id FROM atlas_files WHERE id=$1',[id])).rowCount,0);
});

test('R2 seed observations store only bounded counters, not file identities or restored-state claims',async()=>{
    const f=await databaseFixture(),runId=randomUUID(),privateId=randomUUID();
    const report:SeedReport={
        mode:'apply',status:'partial',checked:2,existingVerified:1,planned:0,createdVerified:1,
        racedVerified:0,invalidMetadata:0,primaryMissing:0,primaryCorrupt:0,backupCorrupt:0,
        bytesRead:19,bytesUploaded:12,writesAttempted:1,maxFiles:3,remaining:true,
        entireCatalogChecked:false,failureFileIds:[privateId],nextCursor:privateId,
    };
    await recordR2SeedObservation(f.store.pool,runId,report);
    const audit=new AuditService(f.store);
    const page=await audit.monitoring({operation:'backup.r2_seed_observed',category:'backup',safeDetails:true});
    assert.equal(page.total,1);
    assert.equal(page.items[0]!.client,'atlas-backup-cli');
    assert.deepEqual(safe(page.items[0]),{
        runId,source:'operator-cli',mode:'apply',status:'partial',checked:2,
        existingVerified:1,planned:0,createdVerified:1,racedVerified:0,
        invalidMetadata:0,primaryMissing:0,primaryCorrupt:0,backupCorrupt:0,
        writesAttempted:1,remaining:true,entireCatalogChecked:false,
    });
    assert.ok(!JSON.stringify(page).includes(privateId));
    assert.ok(!JSON.stringify(page).includes('verifiedRestore'));
    await assert.rejects(recordR2SeedObservation(f.store.pool,'invalid-run-id',report),/Invalid backup run ID/);
    assert.equal((await audit.monitoring({projectId:randomUUID(),category:'backup'})).total,0,
        'Global operator backup observation must not appear under an unrelated Project');
});

test('Forged monitoring details on unrelated operations cannot appear as Files or backup evidence',()=>{
    const suspicious={
        fileId:randomUUID(),folderId:randomUUID(),ownerKind:'project',source:'operator-cli',
        runId:randomUUID(),mode:'apply',status:'completed',checked:10,createdVerified:10,
        filename:'SECRET',token:'TOKEN',verifiedRestore:true,
    };
    const base: AuditEvent ={id:randomUUID(),occurredAt:new Date().toISOString(),client:'untrusted',
        operation:'record.updated' as const,projectId:randomUUID(),resulting:suspicious};
    const safe=projectMonitoringEvent(base);
    assert.equal(safe.resulting,undefined);
    const fakeFile = projectMonitoringEvent({ ...base, operation: 'files.uploaded',
        resulting: { fileId:suspicious.fileId, ownerKind:'project', source:'database-trigger' } });
    assert.equal(fakeFile.resulting,undefined,'Only database-trigger file rows may expose file correlation');
    const fakeBackup = projectMonitoringEvent({ ...base, operation: 'backup.r2_seed_observed',
        resulting: { runId:suspicious.runId, mode:'apply',status:'completed',source:'operator-cli' } });
    assert.equal(fakeBackup.resulting,undefined,'Only the operator CLI label may expose backup observations');
});
