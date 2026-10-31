import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { ObjectNotFound } from "./file-storage.js";
import {
    projectKeyLedgerStatus, readProjectKeySnapshot, type SnapshotItem,
} from "./project-key-ledger.js";
import {
    getProjectRecoverySeedStatus, loadProjectRecoveryManifest,
    type RecoveryObjectStore,
} from "./project-independent-recovery.js";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_PAGE=5,MAX_BYTES=25*1024*1024;
type Store=Pick<RecoveryObjectStore,"getBounded">;
type KeyReceipt={
    ordinal:number; source:string; file_id:string; variant:string;
    source_key:string; target_key:string; sha256:string|null; byte_size:string|null;
};
export type CutoverMapping={
    ordinal:number; fileId:string;variant:string;source:"atlas-file"|"portfolio-media";
    table:"atlas_files"|"media_assets"|"media_variants";
    storageColumn:"storage_key";oldKey:string;newKey:string;
};
export type CutoverReadiness={
    mode:"plan"|"verify"; projectId:string;keyRunId:string;recoveryRunId:string;
    catalogSha256:string;recoveryManifestSha256:string;
    objectCount:number;startOrdinal:number;checked:number;
    remaining:boolean;nextOrdinal?:number;
    keyCopyReceiptsComplete:boolean;backupReceiptsComplete:boolean;
    recoveryCoversBothKeys:boolean;metadataMatched:boolean;
    byteVerification:"not-run"|"passed-page"|"failed-page";
    validatedObjects:number;missingObjects:number;corruptObjects:number;
    blockers:string[];mappings:CutoverMapping[];
    /** Bounded evidence, NEVER permission to update any storage keys. */
    cutoverAuthorized:false;noDatabaseWrites:true;noObjectWrites:true;
    evidenceScope:"metadata-only"|"bounded-object-page";
};
function keyId(value:string){
    if(typeof value!=="string"||!UUID.test(value))
        throw new Error("Invalid Project cutover scope or ledger run.");
    return value;
}
function mapping(item:SnapshotItem):CutoverMapping{
    const row=item.row;
    if(row.source!=="atlas-file"&&row.source!=="portfolio-media")
        throw new Error("Unsupported Project cutover source.");
    return {ordinal:item.ordinal,fileId:row.file_id,variant:row.variant,
        source:row.source,table:row.source==="atlas-file"?"atlas_files":
        row.variant==="original"?"media_assets":"media_variants",
        storageColumn:"storage_key",oldKey:row.storage_key,newKey:item.target};
}
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
async function readBounded(store:Store,key:string,size:number,digest:string,
    missing:string,corrupt:string,blockers:string[],result:{valid:number;missing:number;corrupt:number}){
    try{
        const bytes=await store.getBounded(key,MAX_BYTES);
        if(bytes.length!==size||sha(bytes)!==digest){
            blockers.push(corrupt);result.corrupt++;
        }else result.valid++;
    }catch(error){
        if(error instanceof ObjectNotFound){
            blockers.push(missing);result.missing++;
        }else throw error; // Auth, network, timeout, and ambiguous 404 are inconclusive.
    }
}
/**
 * Read-only bounded operator preflight.
 *
 * Every pair is joined to: the authoritative live Project catalog, the
 * durable create-only key-copy manifest+receipt, and the independent R2
 * recovery manifest+receipt. A catalogue drift, missing receipt, or absent
 * versioned recovery entry blocks ALL object reads on the page.
 *
 * Plan mode requires only PostgreSQL. Verify mode independently GETs:
 * effective live old bytes, primary R2 versioned bytes, independent R2 old
 * bytes and independent R2 versioned bytes. No PUT, DELETE, UPDATE or
 * new-version decision is available through this API.
 */
export async function assessProjectCutover(input:{
    database:Pick<Pool,"query">;
    projectId:string;keyRunId:string;recoveryRunId:string;
    mode:"plan"|"verify";fromOrdinal?:number;maxFiles?:number;
    oldSource?:Store;versionedPrimary?:Store;independentBackup?:Store;
}):Promise<CutoverReadiness>{
    const project=keyId(input.projectId),keyRunId=keyId(input.keyRunId);
    const recoveryRunId=keyId(input.recoveryRunId);
    if(input.mode!=="plan"&&input.mode!=="verify")
        throw new Error("Invalid read-only cutover assessment mode.");
    const from=input.fromOrdinal??0,count=input.maxFiles??3;
    if(!Number.isSafeInteger(from)||from<0||
       !Number.isSafeInteger(count)||count<1||count>MAX_PAGE)
        throw new Error("Cutover assessment is limited to five objects per page.");
    if(input.mode==="verify"&&(!input.oldSource||!input.versionedPrimary||!input.independentBackup))
        throw new Error("All three independent read sources are required for cutover verification.");

    const [catalog,keyStatus,recoveryStatus,recovery]=await Promise.all([
        readProjectKeySnapshot(input.database,project),
        projectKeyLedgerStatus(input.database,keyRunId),
        getProjectRecoverySeedStatus(input.database,recoveryRunId,project),
        loadProjectRecoveryManifest(input.database,recoveryRunId),
    ]);
    if(keyStatus.projectId!==project||recovery.projectId!==project)
        throw new Error("Cutover run belongs to a different Project.");
    if(from>=catalog.items.length)
        throw new Error("Cutover page starts beyond the current Project catalogue.");
    const blockers:string[]=[];
    const block=(reason:string)=>{if(!blockers.includes(reason))blockers.push(reason);};
    if(!catalog.items.length)block("empty-catalogue");
    if(!keyStatus.currentCatalogMatches||catalog.sha256!==keyStatus.manifestSha256||
       catalog.items.length!==keyStatus.objectCount)
        block("key-run-catalogue-drift");
    if(!keyStatus.allCopied)block("incomplete-key-copy-receipts");
    if(recovery.catalogSha256!==catalog.sha256)
        block("recovery-catalogue-drift");
    if(recovery.versionedCopyRunId!==keyRunId||
       recovery.entries.length!==catalog.items.length*2)
        block("recovery-missing-versioned-keys");
    if(recoveryStatus.status!=="complete")
        block("incomplete-independent-backup-receipts");

    const records=await input.database.query<KeyReceipt>(
        "SELECT m.ordinal,m.source,m.file_id,m.variant,m.source_key,m.target_key,"+
        "r.sha256,r.byte_size FROM atlas_project_key_manifest m "+
        "LEFT JOIN atlas_project_key_receipts r ON r.run_id=m.run_id AND r.ordinal=m.ordinal "+
        "WHERE m.run_id=$1 ORDER BY m.ordinal LIMIT $2",
        [keyRunId,catalog.items.length+1]);
    if(records.rows.length!==catalog.items.length)
        block("key-manifest-count-mismatch");
    // This is a full in-memory metadata comparison, even though byte GETs
    // remain tightly paginated. Never let an unchecked earlier row turn a
    // later page into a cutover-ready signal.
    if(!blockers.length){
        for(let i=0;i<catalog.items.length;i++){
            const item=catalog.items[i]!,r=records.rows[i]!,old=recovery.entries[i*2],
                next=recovery.entries[i*2+1],row=item.row;
            if(r.ordinal!==i||r.source!==row.source||r.file_id!==row.file_id||
               r.variant!==row.variant||r.source_key!==row.storage_key||
               r.target_key!==item.target||!r.sha256||
               Number(r.byte_size)!==Number(row.byte_size)||
               row.checksum!==null&&r.sha256!==row.checksum||
               !old||!next||old.keyKind!=="legacy"||next.keyKind!=="versioned"||
               old.source!==row.source||next.source!==row.source||
               old.fileId!==row.file_id||next.fileId!==row.file_id||
               old.variant!==row.variant||next.variant!==row.variant||
               old.storageKey!==row.storage_key||next.storageKey!==item.target||
               old.sha256!==r.sha256||next.sha256!==r.sha256||
               old.byteSize!==Number(row.byte_size)||next.byteSize!==Number(row.byte_size)||
               old.status!==row.status||next.status!==row.status){
                block("source-target-receipt-disagreement");
                break;
            }
        }
    }
    const metadataMatched=blockers.length===0;
    const page=catalog.items.slice(from,from+count),end=from+page.length;
    const remaining=end<catalog.items.length;
    const counts={valid:0,missing:0,corrupt:0};
    let verified:"not-run"|"passed-page"|"failed-page"="not-run";
    if(input.mode==="verify"&&!blockers.length){
        for(const item of page){
            const receipt=records.rows[item.ordinal]!;
            const size=Number(item.row.byte_size),digest=receipt.sha256!;
            await readBounded(input.oldSource!,item.row.storage_key,size,digest,
                "missing-primary-legacy","corrupt-primary-legacy",blockers,counts);
            await readBounded(input.versionedPrimary!,item.target,size,digest,
                "missing-primary-versioned","corrupt-primary-versioned",blockers,counts);
            await readBounded(input.independentBackup!,item.row.storage_key,size,digest,
                "missing-recovery-legacy","corrupt-recovery-legacy",blockers,counts);
            await readBounded(input.independentBackup!,item.target,size,digest,
                "missing-recovery-versioned","corrupt-recovery-versioned",blockers,counts);
        }
        // Detect fresh uploads/archives that appeared during remote reads.
        const after=await readProjectKeySnapshot(input.database,project);
        if(after.sha256!==catalog.sha256||after.items.length!==catalog.items.length)
            block("catalogue-changed-during-verification");
        verified=blockers.length?"failed-page":"passed-page";
    }
    return {
        mode:input.mode,projectId:project,keyRunId,recoveryRunId,
        catalogSha256:catalog.sha256,recoveryManifestSha256:recovery.manifestSha256,
        objectCount:catalog.items.length,startOrdinal:from,checked:page.length,
        remaining,...(remaining?{nextOrdinal:end}:{}),
        keyCopyReceiptsComplete:keyStatus.allCopied,
        backupReceiptsComplete:recoveryStatus.status==="complete",
        recoveryCoversBothKeys:recovery.versionedCopyRunId===keyRunId&&
            recovery.entries.length===catalog.items.length*2,
        metadataMatched,
        byteVerification:verified,validatedObjects:counts.valid,
        missingObjects:counts.missing,corruptObjects:counts.corrupt,blockers,
        mappings:page.map(mapping),
        cutoverAuthorized:false,noDatabaseWrites:true,noObjectWrites:true,
        evidenceScope:input.mode==="plan"?"metadata-only":"bounded-object-page",
    };
}
