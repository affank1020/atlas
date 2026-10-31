import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
    loadProjectKeyRun, projectKeyLedgerStatus, readProjectKeySnapshot,
    type ProjectKeyRun, type SnapshotItem,
} from "./project-key-ledger.js";

/** No network mutation methods are accepted. Source and destination objects
 * must already exist and match the durable Stage 4B byte receipts. */
export type CutoverReadStore = { getBounded(key:string,maxBytes:number):Promise<Buffer> };
type CutoverTable="atlas_files"|"media_assets"|"media_variants";
type CutoverState="applied"|"rolled_back";
type SavedCutover={
    project_id:string;key_run_id:string;manifest_sha256:string;
    object_count:number;state:CutoverState;applied_at:Date;rolled_back_at:Date|null;
};
type CatalogRow={
    project_id:string;source:string;file_id:string;variant:string;
    storage_key:string;checksum:string|null;byte_size:string|number;
    mime_type:string;status:string;
};
type Receipt={ordinal:number;sha256:string;byte_size:string|number};
type Change={table:CutoverTable;id:string;variant:string;oldKey:string;newKey:string};
export type CutoverResult={
    projectId:string;keyRunId:string;manifestSha256:string;objectCount:number;
    status:CutoverState;tables:Record<CutoverTable,number>;
    oldObjectsRetained:true;noObjectWrites:true;requiresStoppedWriters:true;
};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_BYTES=25*1024*1024;
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
function uuid(value:string){
    if(typeof value!=="string"||!UUID.test(value))throw new Error("Invalid Project Storage cutover ID.");
    return value;
}
function changes(items:SnapshotItem[]):Change[]{
    const targets=new Set<string>(),result:Change[]=[];
    for(const item of items){
        const row=item.row;
        if(row.source!=="atlas-file"&&row.source!=="portfolio-media")
            throw new Error("Unsupported cutover catalogue source.");
        if(row.source==="atlas-file"&&row.variant!=="original")
            throw new Error("Invalid native File variant.");
        if(row.storage_key===item.target||targets.has(item.target))
            throw new Error("Duplicate or unchanged Project destination key.");
        targets.add(item.target);
        result.push({table:row.source==="atlas-file"?"atlas_files":
            row.variant==="original"?"media_assets":"media_variants",
            id:row.file_id,variant:row.variant,oldKey:row.storage_key,newKey:item.target});
    }
    if(!result.length||result.length>1000)throw new Error("Invalid cutover inventory size.");
    return result;
}
async function saved(database:Pick<Pool,"query">,projectId:string,lock=false):Promise<SavedCutover|null>{
    const result=await database.query<SavedCutover>(
        "SELECT project_id,key_run_id,manifest_sha256,object_count,state,applied_at,rolled_back_at "+
        "FROM atlas_project_storage_cutovers WHERE project_id=$1"+(lock?" FOR UPDATE":""),[projectId]);
    return result.rows[0]??null;
}
/** The view is authoritative before AND after cutover: the legacy-source
 * snapshot helper intentionally rejects switched v1 keys after apply. */
async function assertCatalogue(database:Pick<Pool,"query">,run:ProjectKeyRun,phase:"old"|"new"){
    const rows=await database.query<CatalogRow>(
        "SELECT project_id,source,file_id,variant,storage_key,checksum,byte_size,mime_type,status "+
        "FROM atlas_project_storage_objects WHERE project_id=$1::text "+
        "ORDER BY source,file_id::text,variant LIMIT $2",
        [run.projectId,run.objectCount+1]);
    if(rows.rows.length!==run.objectCount)
        throw new Error("Project Storage catalogue count changed; writes must remain stopped.");
    for(let i=0;i<run.objectCount;i++){
        const actual=rows.rows[i]!,item=run.items[i]!,expected=item.row;
        if(actual.project_id!==run.projectId||actual.source!==expected.source||
            actual.file_id!==expected.file_id||actual.variant!==expected.variant||
            actual.storage_key!==(phase==="old"?expected.storage_key:item.target)||
            actual.checksum!==expected.checksum||
            Number(actual.byte_size)!==Number(expected.byte_size)||
            actual.mime_type!==expected.mime_type||actual.status!==expected.status)
            throw new Error("Project Storage catalogue drift or mixed key state.");
    }
}
async function verifiedReceipts(database:Pick<Pool,"query">,run:ProjectKeyRun):Promise<Receipt[]>{
    const receipts=await database.query<Receipt>(
        "SELECT ordinal,sha256,byte_size FROM atlas_project_key_receipts "+
        "WHERE run_id=$1 ORDER BY ordinal LIMIT $2",[run.id,run.objectCount+1]);
    if(receipts.rows.length!==run.objectCount)
        throw new Error("Project Storage copy ledger is missing durable byte receipts.");
    for(let i=0;i<receipts.rows.length;i++){
        const receipt=receipts.rows[i]!,item=run.items[i]!;
        if(receipt.ordinal!==i||! /^[a-f0-9]{64}$/.test(receipt.sha256)||
            Number(receipt.byte_size)!==Number(item.row.byte_size)||
            item.row.checksum!==null&&item.row.checksum!==receipt.sha256)
            throw new Error("Project Storage manifest/copy receipt mismatch.");
    }
    return receipts.rows;
}
async function verifyBytes(run:ProjectKeyRun,receipts:Receipt[],
    source:CutoverReadStore,destination:CutoverReadStore){
    for(const item of run.items){
        const receipt=receipts[item.ordinal]!;
        const size=Number(item.row.byte_size);
        // Both copies must be available for rollback, including archived
        // content and Portfolio variants with no historical checksum column.
        for(const [store,key] of [[source,item.row.storage_key],
                                  [destination,item.target]] as const){
            const bytes=await store.getBounded(key,MAX_BYTES);
            if(bytes.length!==size||sha(bytes)!==receipt.sha256)
                throw new Error("Project Storage source or destination bytes differ from receipt.");
        }
    }
}
async function swap(client:PoolClient,c:Change,projectId:string,reverse:boolean){
    const oldKey=reverse?c.newKey:c.oldKey,to=reverse?c.oldKey:c.newKey;
    const [sql,parameters]:[string,string[]]=c.table==="atlas_files"
        ?["UPDATE atlas_files SET storage_key=$4 WHERE id=$1 AND owner_kind='project' "+
          "AND owner_id=$2 AND storage_key=$3 RETURNING id",[c.id,projectId,oldKey,to]]
        :c.table==="media_assets"
            ?["UPDATE media_assets SET storage_key=$3 WHERE id=$1 AND storage_key=$2 RETURNING id",
              [c.id,oldKey,to]]
            :["UPDATE media_variants SET storage_key=$4 WHERE asset_id=$1 AND name=$2 "+
              "AND storage_key=$3 RETURNING asset_id",[c.id,c.variant,oldKey,to]];
    const result=await client.query(sql,parameters);
    if(result.rowCount!==1)
        throw new Error("Project Storage key transition failed its conditional row match.");
}
/** Operator-only. Requires Atlas writers to be fully stopped externally
 * BEFORE invocation and until the new-write flag is deployed, or until a
 * rollback completes. Never run in the live request path.
 *
 * All R2 reads happen before database table locks; metadata is revalidated
 * under locks immediately before the atomic key update. The operator must
 * keep object writers stopped too (R2 has no PostgreSQL transaction). */
export async function executeProjectKeyCutover(input:{
    database:Pool;projectId:string;keyRunId?:string;
    mode:"apply"|"rollback";oldSource:CutoverReadStore;newPrimary:CutoverReadStore;
}):Promise<CutoverResult>{
    const project=uuid(input.projectId);
    if(input.mode!=="apply"&&input.mode!=="rollback")throw new Error("Invalid cutover mode.");
    const prior=await saved(input.database,project);
    if(input.mode==="apply"&&prior)
        throw new Error("Project already has a durable cutover record; use status.");
    if(input.mode==="rollback"&&(!prior||prior.state!=="applied"))
        throw new Error("Project has no applied cutover to roll back.");
    const keyRunId=uuid(input.mode==="apply"?input.keyRunId!:prior!.key_run_id);
    const run=await loadProjectKeyRun(input.database,keyRunId);
    if(run.projectId!==project||run.items.length!==run.objectCount)
        throw new Error("Cutover run does not match the scoped Project.");
    if(prior&&(prior.key_run_id!==run.id||prior.manifest_sha256!==run.manifestSha256||
       prior.object_count!==run.objectCount))
        throw new Error("Saved rollback metadata differs from the immutable key manifest.");
    changes(run.items);
    if(input.mode==="apply"){
        const status=await projectKeyLedgerStatus(input.database,run.id);
        if(!status.allCopied)throw new Error("All Project destination copy receipts must be complete.");
    }
    await assertCatalogue(input.database,run,input.mode==="apply"?"old":"new");
    const receipts=await verifiedReceipts(input.database,run);
    await verifyBytes(run,receipts,input.oldSource,input.newPrimary);

    const client=await input.database.connect();
    let begun=false;
    try{
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");begun=true;
        await client.query("SET LOCAL lock_timeout='5000ms'");
        await client.query("SET LOCAL statement_timeout='30000ms'");
        // Exact three authoritative tables. Prevent all ordinary metadata
        // INSERT/UPDATE/DELETE while checking and switching the keys.
        await client.query("LOCK TABLE atlas_files,media_assets,media_variants IN SHARE ROW EXCLUSIVE MODE");
        await client.query("SELECT id FROM atlas_project_key_runs WHERE id=$1 FOR UPDATE",[run.id]);
        const latest=await saved(client,project,true);
        if(input.mode==="apply"&&latest||input.mode==="rollback"&&
           (!latest||latest.state!=="applied"||latest.key_run_id!==run.id))
            throw new Error("Project cutover state changed during the operation.");
        // Compare the entire live catalogue (not merely the changed page)
        // under table locks, after waiting for any in-flight writer.
        await assertCatalogue(client,run,input.mode==="apply"?"old":"new");
        const lockedReceipts=await verifiedReceipts(client,run);
        for(let i=0;i<receipts.length;i++){
            if(lockedReceipts[i]!.ordinal!==receipts[i]!.ordinal||
               lockedReceipts[i]!.sha256!==receipts[i]!.sha256||
               Number(lockedReceipts[i]!.byte_size)!==Number(receipts[i]!.byte_size))
                throw new Error("Project Storage byte receipts changed after R2 verification.");
        }
        const entries=changes(run.items);
        const tables:Record<CutoverTable,number>={
            atlas_files:0,media_assets:0,media_variants:0,
        };
        for(const entry of entries){
            await swap(client,entry,project,input.mode==="rollback");
            tables[entry.table]++;
        }
        await assertCatalogue(client,run,input.mode==="apply"?"new":"old");
        if(input.mode==="apply"){
            await client.query(
                "INSERT INTO atlas_project_storage_cutovers "+
                "(project_id,key_run_id,manifest_sha256,object_count,state) "+
                "VALUES($1,$2,$3,$4,'applied')",
                [project,run.id,run.manifestSha256,run.objectCount]);
        }else{
            const updated=await client.query(
                "UPDATE atlas_project_storage_cutovers SET state='rolled_back',rolled_back_at=now() "+
                "WHERE project_id=$1 AND key_run_id=$2 AND state='applied' RETURNING project_id",
                [project,run.id]);
            if(updated.rowCount!==1)throw new Error("Durable rollback state changed.");
        }
        await client.query("COMMIT");begun=false;
        return {projectId:project,keyRunId:run.id,manifestSha256:run.manifestSha256,
            objectCount:run.objectCount,status:input.mode==="apply"?"applied":"rolled_back",
            tables,oldObjectsRetained:true,noObjectWrites:true,requiresStoppedWriters:true};
    }catch(error){
        if(begun)await client.query("ROLLBACK").catch(()=>undefined);
        throw error;
    }finally{client.release();}
}
export async function getProjectKeyCutoverStatus(database:Pool,projectId:string){
    const row=await saved(database,uuid(projectId));
    if(!row)return {projectId,state:"not-applied" as const};
    return {projectId,keyRunId:row.key_run_id,manifestSha256:row.manifest_sha256,
        objectCount:row.object_count,state:row.state,
        appliedAt:new Date(row.applied_at).toISOString(),
        rolledBackAt:row.rolled_back_at?new Date(row.rolled_back_at).toISOString():null};
}
