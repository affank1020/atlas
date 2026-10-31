import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ObjectNotFound, isLegacyObjectKey, isProjectObjectKey } from "./file-storage.js";
import { readProjectKeySnapshot } from "./project-key-ledger.js";
import type { BoundedCopyStore } from "./project-key-migration.js";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const MAX_BYTES=25*1024*1024,MAX_ENTRIES=2000,MAX_PAGE=5;
export const PROJECT_RECOVERY_CAPTURE_CONFIRM="CAPTURE_PROJECT_RECOVERY";
export const PROJECT_RECOVERY_SEED_CONFIRM="SEED_PROJECT_RECOVERY";

type Entry = {
    ordinal:number; source:"atlas-file"|"portfolio-media";fileId:string;variant:string;
    keyKind:"legacy"|"versioned";storageKey:string;sha256:string;byteSize:number;status:string;
};
type Header = {id:string;project_id:string;catalog_sha256:string;manifest_sha256:string;
    object_count:number;versioned_copy_run_id:string|null;captured_at:Date};
export type ProjectRecoveryManifest = {
    id:string;projectId:string;catalogSha256:string;manifestSha256:string;
    versionedCopyRunId:string|null;capturedAt:string;entries:Entry[];
};
export type RecoveryObjectStore = Pick<BoundedCopyStore,"getBounded"|"putIfAbsent">;
const hash=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
const id=(value:string)=>{if(typeof value!=="string"||!UUID.test(value))
    throw new Error("Invalid Project recovery identity.");return value;};
const digest=(entries:Entry[])=>hash(JSON.stringify(entries.map(e=>[
    e.ordinal,e.source,e.fileId,e.variant,e.keyKind,e.storageKey,e.sha256,e.byteSize,e.status,
])));
const fits=(bytes:Buffer,e:Entry)=>bytes.length===e.byteSize&&hash(bytes)===e.sha256;
function validateEntries(entries:Entry[],project:string) {
    id(project);
    if(entries.length<1||entries.length>MAX_ENTRIES)
        throw new Error("Recovery manifest has an invalid object count.");
    const keys=new Set<string>(),identities=new Set<string>();
    for(let n=0;n<entries.length;n++){
        const e=entries[n]!;
        const ident=JSON.stringify([e.source,e.fileId,e.variant,e.keyKind]);
        if(e.ordinal!==n||!UUID.test(e.fileId)||!SHA.test(e.sha256)||
           !Number.isSafeInteger(e.byteSize)||e.byteSize<1||e.byteSize>MAX_BYTES||
           !["legacy","versioned"].includes(e.keyKind)||
           !["atlas-file","portfolio-media"].includes(e.source)||
           (e.status!=="active"&&e.status!=="archived")||
           (e.keyKind==="legacy"?!isLegacyObjectKey(e.storageKey):!isProjectObjectKey(e.storageKey))||
           keys.has(e.storageKey)||identities.has(ident))
            throw new Error("Invalid or duplicate Project recovery manifest entry.");
        keys.add(e.storageKey);identities.add(ident);
    }
}
async function sourceBytes(store:RecoveryObjectStore,key:string,max=MAX_BYTES){
    return store.getBounded(key,max);
}
type CopyReceipt = {source:string;file_id:string;variant:string;source_key:string;
    target_key:string;sha256:string;byte_size:string};
async function versionedCopies(database:Pick<Pool,"query">,runId:string,project:string,
    expectedCatalog:string,expectedCount:number):Promise<CopyReceipt[]>{
    id(runId);
    const hdr=await database.query<{project_id:string;manifest_sha256:string;object_count:number}>(
        "SELECT project_id,manifest_sha256,object_count FROM atlas_project_key_runs WHERE id=$1",[runId]);
    if(hdr.rows.length!==1||hdr.rows[0]!.project_id!==project||
       hdr.rows[0]!.manifest_sha256!==expectedCatalog||
       hdr.rows[0]!.object_count!==expectedCount)
        throw new Error("Versioned copy run does not match the current Project catalogue.");
    const result=await database.query<CopyReceipt>(
        "SELECT m.source,m.file_id,m.variant,m.source_key,m.target_key,r.sha256,r.byte_size "+
        "FROM atlas_project_key_manifest m JOIN atlas_project_key_receipts r "+
        "ON r.run_id=m.run_id AND r.ordinal=m.ordinal "+
        "WHERE m.run_id=$1 ORDER BY m.ordinal LIMIT $2",[runId,expectedCount+1]);
    if(result.rows.length!==expectedCount)
        throw new Error("Incomplete Project key copy receipts; versioned backup is not attested.");
    return result.rows;
}

/** Byte capture must complete before the dedicated run can be committed.
 * It verifies every original, derivative and archived source, and optionally
 * every separately receipted versioned copy. It does NOT publish R2 backups. */
export async function captureProjectRecoveryManifest(input:{
    database:Pool;source:RecoveryObjectStore;projectId:string;versionedRunId?:string;
}):Promise<ProjectRecoveryManifest>{
    const project=id(input.projectId);
    const snapshot=await readProjectKeySnapshot(input.database,project);
    if(snapshot.items.length===0)throw new Error("Cannot capture an empty Project recovery catalogue.");
    const copies=input.versionedRunId
        ?await versionedCopies(input.database,input.versionedRunId,project,snapshot.sha256,snapshot.items.length):[];
    const byIdentity=new Map(copies.map(x=>[JSON.stringify([x.source,x.file_id,x.variant]),x]));
    if(copies.length&&byIdentity.size!==snapshot.items.length)
        throw new Error("Versioned receipts contain duplicate or missing identities.");
    const entries:Entry[]=[];
    for(const item of snapshot.items){
        const row=item.row,bytes=await sourceBytes(input.source,row.storage_key),size=Number(row.byte_size);
        const sha=hash(bytes);
        if(bytes.length!==size||(row.checksum!==null&&sha!==row.checksum))
            throw new Error("Project recovery source bytes failed catalogue validation.");
        entries.push({ordinal:entries.length,source:row.source,fileId:row.file_id,
            variant:row.variant,keyKind:"legacy",storageKey:row.storage_key,
            sha256:sha,byteSize:size,status:row.status});
        if(input.versionedRunId){
            const receipt=byIdentity.get(JSON.stringify([row.source,row.file_id,row.variant]));
            if(!receipt||receipt.source_key!==row.storage_key||receipt.target_key!==item.target||
                receipt.sha256!==sha||Number(receipt.byte_size)!==size)
                throw new Error("Versioned copy receipt disagrees with authoritative source bytes.");
            const v=await sourceBytes(input.source,item.target);
            if(v.length!==size||hash(v)!==sha)
                throw new Error("Versioned Project source is missing or corrupted.");
            entries.push({ordinal:entries.length,source:row.source,fileId:row.file_id,
                variant:row.variant,keyKind:"versioned",storageKey:item.target,
                sha256:sha,byteSize:size,status:row.status});
        }
    }
    validateEntries(entries,project);
    const again=await readProjectKeySnapshot(input.database,project);
    if(again.sha256!==snapshot.sha256||again.items.length!==snapshot.items.length)
        throw new Error("Project recovery catalogue changed during source verification.");
    const runId=randomUUID(),manifestHash=digest(entries);
    const client=await input.database.connect();
    let begun=false;
    try{
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");begun=true;
        const inside=await readProjectKeySnapshot(client,project);
        if(inside.sha256!==snapshot.sha256||inside.items.length!==snapshot.items.length)
            throw new Error("Project recovery catalogue changed before manifest commit.");
        if(input.versionedRunId)
            await versionedCopies(client,input.versionedRunId,project,snapshot.sha256,snapshot.items.length);
        await client.query(
            "INSERT INTO atlas_project_recovery_runs "+
            "(id,project_id,catalog_sha256,manifest_sha256,object_count,versioned_copy_run_id) "+
            "VALUES($1,$2,$3,$4,$5,$6)",
            [runId,project,snapshot.sha256,manifestHash,entries.length,input.versionedRunId??null]);
        for(const e of entries)await client.query(
            "INSERT INTO atlas_project_recovery_entries "+
            "(run_id,ordinal,source,file_id,variant,key_kind,storage_key,sha256,byte_size,status) "+
            "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            [runId,e.ordinal,e.source,e.fileId,e.variant,e.keyKind,e.storageKey,e.sha256,e.byteSize,e.status]);
        await client.query("COMMIT");begun=false;
    }catch(error){if(begun)await client.query("ROLLBACK").catch(()=>undefined);throw error;
    }finally{client.release();}
    return {id:runId,projectId:project,catalogSha256:snapshot.sha256,
        manifestSha256:manifestHash,versionedCopyRunId:input.versionedRunId??null,
        capturedAt:new Date().toISOString(),entries};
}
export async function loadProjectRecoveryManifest(database:Pick<Pool,"query">,
    runId:string):Promise<ProjectRecoveryManifest>{
    id(runId);
    const result=await database.query<Header>(
        "SELECT id,project_id,catalog_sha256,manifest_sha256,object_count,versioned_copy_run_id,captured_at "+
        "FROM atlas_project_recovery_runs WHERE id=$1",[runId]);
    if(result.rows.length!==1)throw new Error("Project recovery manifest was not found.");
    const h=result.rows[0]!;
    if(!SHA.test(h.catalog_sha256)||!SHA.test(h.manifest_sha256)||
       !Number.isSafeInteger(h.object_count)||h.object_count<1||h.object_count>MAX_ENTRIES)
        throw new Error("Invalid Project recovery manifest header.");
    const saved=await database.query<{ordinal:number;source:Entry["source"];file_id:string;variant:string;
        key_kind:Entry["keyKind"];storage_key:string;sha256:string;byte_size:string;status:string}>(
        "SELECT ordinal,source,file_id,variant,key_kind,storage_key,sha256,byte_size,status "+
        "FROM atlas_project_recovery_entries WHERE run_id=$1 ORDER BY ordinal LIMIT $2",[runId,MAX_ENTRIES+1]);
    const entries=saved.rows.map(x=>({ordinal:x.ordinal,source:x.source,fileId:x.file_id,
        variant:x.variant,keyKind:x.key_kind,storageKey:x.storage_key,
        sha256:x.sha256,byteSize:Number(x.byte_size),status:x.status}));
    validateEntries(entries,h.project_id);
    if(entries.length!==h.object_count||digest(entries)!==h.manifest_sha256)
        throw new Error("Project recovery manifest is incomplete or was modified.");
    return {id:runId,projectId:h.project_id,catalogSha256:h.catalog_sha256,
        manifestSha256:h.manifest_sha256,versionedCopyRunId:h.versioned_copy_run_id,
        capturedAt:new Date(h.captured_at).toISOString(),entries};
}
async function assertCatalog(database:Pick<Pool,"query">,m:ProjectRecoveryManifest){
    const current=await readProjectKeySnapshot(database,m.projectId);
    if(current.sha256!==m.catalogSha256||
       current.items.length!==(m.versionedCopyRunId?m.entries.length/2:m.entries.length))
        throw new Error("Project recovery catalogue does not match the captured manifest.");
}
export type SeedRecoveryReport = {mode:"dry-run"|"apply";status:"ready"|"completed"|"partial"|"failed";
    checked:number;existingVerified:number;planned:number;createdVerified:number;
    racedVerified:number;bytesVerified:number;writesAttempted:number;remaining:boolean;
    nextOrdinal?:number;noDeletes:true};
/** A bounded, fail-closed batch. All source and existing destination bytes are
 * preflighted before the first conditional PUT; never substitute current rows
 * from the live catalogue after confirming the immutable recovery manifest. */
export async function seedProjectRecovery(input:{
    database:Pool;source:RecoveryObjectStore;backup:RecoveryObjectStore;
    runId:string;projectId:string;apply?:boolean;fromOrdinal?:number;maxFiles?:number;
}):Promise<SeedRecoveryReport>{
    const m=await loadProjectRecoveryManifest(input.database,input.runId);
    if(m.projectId!==id(input.projectId))throw new Error("Project recovery run belongs to another Project.");
    const from=input.fromOrdinal??0,n=input.maxFiles??3;
    if(!Number.isInteger(n)||n<1||n>MAX_PAGE||!Number.isSafeInteger(from)||
       from<0||from>=m.entries.length||(input.apply===true&&!input.backup.putIfAbsent))
        throw new Error("Invalid bounded Project recovery seed page.");
    await assertCatalog(input.database,m);
    const page=m.entries.slice(from,from+n);
    const missing:{e:Entry;bytes:Buffer}[]=[];
    let verified=0,bytesVerified=0;
    for(const e of page){
        const source=await sourceBytes(input.source,e.storageKey);
        if(!fits(source,e))throw new Error("Project recovery primary source differs from manifest.");
        bytesVerified+=source.length;
        try {
            const existing=await sourceBytes(input.backup,e.storageKey);
            if(!fits(existing,e))throw new Error("Independent recovery object differs from manifest.");
            verified++;bytesVerified+=existing.length;
        } catch(error){
            if(!(error instanceof ObjectNotFound))throw error;
            missing.push({e,bytes:source});
        }
    }
    let created=0,raced=0,writes=0;
    if(input.apply){
        await assertCatalog(input.database,m);
        for(const item of missing){
            writes++;
            const wasCreated=await input.backup.putIfAbsent!(item.e.storageKey,item.bytes,"application/octet-stream");
            const committed=await sourceBytes(input.backup,item.e.storageKey);
            if(!fits(committed,item.e))
                throw new Error("Independent recovery PUT was not byte-verified.");
            bytesVerified+=committed.length;
            if(wasCreated)created++;else raced++;
        }
        await assertCatalog(input.database,m);
    }
    const end=from+page.length;
    return {mode:input.apply?"apply":"dry-run",status:end<m.entries.length?"partial":
        input.apply?"completed":"ready",
        checked:page.length,existingVerified:verified,planned:missing.length,
        createdVerified:created,racedVerified:raced,bytesVerified,
        writesAttempted:writes,remaining:end<m.entries.length,
        ...(end<m.entries.length?{nextOrdinal:end}:{}),noDeletes:true};
}
export type RecoveryRestoreReport = {status:"passed"|"failed"|"partial";scope:"restored-db-and-independent-r2";
    runId:string;manifestSha256:string;checked:number;verified:number;
    missing:number;corrupt:number;remaining:boolean;nextOrdinal?:number;
    noPrimaryAccess:true;noWrites:true};
/** Designed for a restored, isolated DB connection and independent bucket
 * ONLY. No primary-store argument is accepted or referenced here. */
export async function verifyIsolatedProjectRecovery(input:{
    restoredDatabase:Pick<Pool,"query">;backup:Pick<RecoveryObjectStore,"getBounded">;
    runId:string;projectId:string;fromOrdinal?:number;maxFiles?:number;
}):Promise<RecoveryRestoreReport>{
    const m=await loadProjectRecoveryManifest(input.restoredDatabase,input.runId);
    if(m.projectId!==id(input.projectId))
        throw new Error("Isolated manifest belongs to another Project.");
    await assertCatalog(input.restoredDatabase,m);
    const from=input.fromOrdinal??0,n=input.maxFiles??100;
    if(!Number.isSafeInteger(from)||from<0||from>=m.entries.length||
       !Number.isSafeInteger(n)||n<1||n>MAX_ENTRIES)
        throw new Error("Invalid bounded isolated recovery verification.");
    const page=m.entries.slice(from,from+n);
    let verified=0,missing=0,corrupt=0;
    for(const e of page){
        try{
            const bytes=await sourceBytes(input.backup,e.storageKey);
            if(fits(bytes,e))verified++;else corrupt++;
        }catch(error){if(error instanceof ObjectNotFound)missing++;else throw error;}
    }
    await assertCatalog(input.restoredDatabase,m);
    const end=from+page.length,remaining=end<m.entries.length;
    return {scope:"restored-db-and-independent-r2",runId:m.id,
        manifestSha256:m.manifestSha256,checked:page.length,verified,missing,corrupt,
        status:missing||corrupt?"failed":remaining||from>0?"partial":"passed",
        remaining,...(remaining?{nextOrdinal:end}:{}),noPrimaryAccess:true,noWrites:true};
}
