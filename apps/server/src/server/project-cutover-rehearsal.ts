import type { Pool, PoolClient } from "pg";
import { readProjectKeySnapshot, type SnapshotItem } from "./project-key-ledger.js";
import { assessProjectCutover } from "./project-cutover-readiness.js";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Table="atlas_files"|"media_assets"|"media_variants";
export type CutoverRehearsalReport={
    status:"passed";projectId:string;keyRunId:string;recoveryRunId:string;
    catalogSha256:string;rows:number;forwardSimulated:number;reverseSimulated:number;
    tables:Record<Table,number>;
    storageKeysUnchanged:true;noCommittedDatabaseWrites:true;
    noObjectReads:true;noObjectWrites:true;cutoverAuthorized:false;
    scope:"disposable-database-transaction-only";
};
function uuid(value:string){
    if(typeof value!=="string"||!UUID.test(value))
        throw new Error("Invalid Project cutover rehearsal ID.");
    return value;
}
type Change={table:Table;fileId:string;variant:string;oldKey:string;newKey:string};
function change(item:SnapshotItem):Change{
    const row=item.row;
    if(row.source==="atlas-file"){
        if(row.variant!=="original")throw new Error("Native Atlas File has an invalid variant.");
        return {table:"atlas_files",fileId:row.file_id,variant:"original",
            oldKey:row.storage_key,newKey:item.target};
    }
    if(row.source==="portfolio-media")
        return {table:row.variant==="original"?"media_assets":"media_variants",
            fileId:row.file_id,variant:row.variant,
            oldKey:row.storage_key,newKey:item.target};
    throw new Error("Unknown Project storage source.");
}
/** SQL structure is a fixed whitelist; values are always bound parameters.
 * The asset ID + variant name is the identity of a Portfolio derivative.
 * Project scope is passed explicitly rather than inferred from a key. */
async function selectKey(client:PoolClient,c:Change,project:string):Promise<string>{
    const [sql,params]:[string,string[]]=c.table==="atlas_files"
        ?["SELECT storage_key FROM atlas_files WHERE id=$1 AND owner_kind='project' AND owner_id=$2",[c.fileId,project]]
        :c.table==="media_assets"
            ?["SELECT storage_key FROM media_assets WHERE id=$1",[c.fileId]]
            :["SELECT storage_key FROM media_variants WHERE asset_id=$1 AND name=$2",[c.fileId,c.variant]];
    const result=await client.query<{storage_key:string}>(sql,params);
    if(result.rows.length!==1)throw new Error("Cutover rehearsal key identity missing.");
    return result.rows[0]!.storage_key;
}
async function swapKey(client:PoolClient,c:Change,project:string,from:string,to:string){
    const [sql,params]:[string,string[]]=c.table==="atlas_files"
        ?["UPDATE atlas_files SET storage_key=$4 WHERE id=$1 AND owner_kind='project' AND owner_id=$2 AND storage_key=$3 RETURNING id",
          [c.fileId,project,from,to]]
        :c.table==="media_assets"
            ?["UPDATE media_assets SET storage_key=$3 WHERE id=$1 AND storage_key=$2 RETURNING id",
              [c.fileId,from,to]]
            :["UPDATE media_variants SET storage_key=$4 WHERE asset_id=$1 AND name=$2 AND storage_key=$3 RETURNING asset_id",
              [c.fileId,c.variant,from,to]];
    const result=await client.query(sql,params);
    if(result.rowCount!==1)throw new Error("Cutover rehearsal conditional key transition did not affect exactly one row.");
}
/**
 * Exercising exact migration SQL on a disposable database only.
 * Locks all three catalogue tables, checks the FULL immutable metadata
 * evidence, conditionally swaps every key, verifies the forward state,
 * conditionally reverses every key, verifies the restored catalogue digest,
 * and ALWAYS rolls the entire transaction back. There is intentionally no
 * COMMIT, apply, production activation or R2 access path.
 *
 * This proves transaction logic on the current disposable DB copy, NOT
 * production DR, current remote-byte health or a safe writer-quiescence
 * window. In particular it may not be used as cutover authorisation.
 */
export async function rehearseProjectCutover(input:{
    database:Pool;projectId:string;keyRunId:string;recoveryRunId:string;
}):Promise<CutoverRehearsalReport>{
    const project=uuid(input.projectId),keyRun=uuid(input.keyRunId),
        recoveryRun=uuid(input.recoveryRunId);
    const client=await input.database.connect();
    let begun=false;
    try{
        // Direct API callers cannot bypass the CLI's disposable-host guard.
        // Atlas CI creates unique atlas_test_* schemas; manual rehearsals
        // must use a distinct atlas_cutover_rehearsal database, never atlas.
        const environment=await client.query<{db:string;schema:string}>(
            "SELECT current_database() AS db,current_schema() AS schema");
        const location=environment.rows[0];
        if(!location||!(/^atlas_test_[a-f0-9]{32}$/.test(location.schema)||
            /^atlas_cutover_rehearsal(?:_[a-z0-9_]+)?$/.test(location.db)))
            throw new Error("Only disposable PostgreSQL rehearsal or isolated test schemas are permitted.");
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");begun=true;
        await client.query("SET LOCAL lock_timeout='2500ms'");
        await client.query("SET LOCAL statement_timeout='15000ms'");
        // These locks serialize INSERT/UPDATE/DELETE across all three tables
        // during the rehearsal, including existing Portfolio upload paths.
        // A production writer cannot race into the disposable transaction.
        await client.query(
            "LOCK TABLE atlas_files,media_assets,media_variants IN SHARE ROW EXCLUSIVE MODE");
        const plan=await assessProjectCutover({database:client,projectId:project,
            keyRunId:keyRun,recoveryRunId:recoveryRun,mode:"plan",maxFiles:5});
        if(!plan.metadataMatched||plan.blockers.length||
           !plan.keyCopyReceiptsComplete||!plan.backupReceiptsComplete||
           !plan.recoveryCoversBothKeys)
            throw new Error("Cutover rehearsal blocked by incomplete or drifting catalogue evidence.");
        const snapshot=await readProjectKeySnapshot(client,project);
        if(snapshot.sha256!==plan.catalogSha256||snapshot.items.length!==plan.objectCount||
           snapshot.items.length<1)
            throw new Error("Cutover rehearsal captured an inconsistent Project catalogue.");
        const changes=snapshot.items.map(change);
        const targets=new Set(changes.map(c=>c.newKey));
        if(targets.size!==changes.length||changes.some(c=>c.oldKey===c.newKey))
            throw new Error("Cutover rehearsal contains duplicate or unchanged versioned targets.");
        const tables:Record<Table,number>={atlas_files:0,media_assets:0,media_variants:0};
        for(const c of changes){
            if(await selectKey(client,c,project)!==c.oldKey)
                throw new Error("Cutover rehearsal original key did not match the manifest.");
            await swapKey(client,c,project,c.oldKey,c.newKey);
            if(await selectKey(client,c,project)!==c.newKey)
                throw new Error("Cutover rehearsal new key was not visible in the transaction.");
            tables[c.table]++;
        }
        for(const c of [...changes].reverse()){
            await swapKey(client,c,project,c.newKey,c.oldKey);
            if(await selectKey(client,c,project)!==c.oldKey)
                throw new Error("Cutover rehearsal reversal did not restore the original key.");
        }
        const restored=await readProjectKeySnapshot(client,project);
        if(restored.sha256!==snapshot.sha256||restored.items.length!==changes.length)
            throw new Error("Cutover rehearsal failed to restore the original metadata digest.");
        // Return only an assertion that all steps inside the transaction
        // passed. The mandatory ROLLBACK happens in finally, before return.
        const result:CutoverRehearsalReport={
            status:"passed",projectId:project,keyRunId:keyRun,recoveryRunId:recoveryRun,
            catalogSha256:snapshot.sha256,rows:changes.length,
            forwardSimulated:changes.length,reverseSimulated:changes.length,tables,
            storageKeysUnchanged:true,noCommittedDatabaseWrites:true,
            noObjectReads:true,noObjectWrites:true,cutoverAuthorized:false,
            scope:"disposable-database-transaction-only",
        };
        return result;
    }finally{
        try{if(begun)await client.query("ROLLBACK");}
        finally{client.release();}
    }
}
