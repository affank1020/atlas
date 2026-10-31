import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { isLegacyObjectKey, ObjectNotFound } from "./file-storage.js";
import type { RecoveryObjectStore } from "./r2-recovery-verification.js";

const FILE_KEY=/^files-[a-f0-9]{32}-[a-f0-9]{64}$/;
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const MAX_BYTES=25*1024*1024;
export const ISOLATED_LEGACY_MAX_RECORDS=2000;
export const ISOLATED_LEGACY_DEFAULT_RECORDS=100;

type LegacyRow={
    id:string;owner_kind:string;owner_id:string;storage_key:string;
    checksum:string;byte_size:string|number;status:string;
};
type Snapshot={rows:LegacyRow[];truncated:boolean;fingerprint:string};
export type IsolatedLegacyRecoveryReport={
    mode:"read-only";scope:"restored-workspace-application-files";
    status:"passed"|"failed"|"partial"|"empty";
    observedAt:string;inventorySha256:string;maxRecords:number;checked:number;
    activeChecked:number;archivedChecked:number;
    verified:number;missing:number;corrupt:number;invalidMetadata:number;
    truncated:boolean;catalogChanged:boolean;noPrimaryAccess:true;noWrites:true;
    /** Only a complete nonempty result with no failures may be called passed.
     * This does not certify Project Files, Portfolio, Atlas boot or DR readiness. */
    entireLegacyCatalogVerified:boolean;
};
const hash=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
function valid(row:LegacyRow){
    const size=Number(row.byte_size);
    return UUID.test(row.id)&&
        (row.owner_kind==="workspace"||row.owner_kind==="application")&&
        typeof row.owner_id==="string"&&row.owner_id.length>0&&
        (row.status==="active"||row.status==="archived")&&
        typeof row.storage_key==="string"&&isLegacyObjectKey(row.storage_key)&&
        FILE_KEY.test(row.storage_key)&&SHA.test(row.checksum)&&
        Number.isSafeInteger(size)&&size>0&&size<=MAX_BYTES&&
        row.storage_key==="files-"+row.id.replaceAll("-","").toLowerCase()+"-"+row.checksum;
}
function canonical(row:LegacyRow){
    return [row.id,row.owner_kind,row.owner_id,row.storage_key,
        row.checksum,String(row.byte_size),row.status];
}
/** Bounded full-inventory read. Never paginate a mutable catalogue and
 * present its last page as proof of complete coverage. */
async function snapshot(database:Pick<Pool,"query">,max:number):Promise<Snapshot>{
    const result=await database.query<LegacyRow>(
        "SELECT id,owner_kind,owner_id,storage_key,checksum,byte_size,status "+
        "FROM atlas_files WHERE owner_kind IN ('workspace','application') "+
        "ORDER BY id LIMIT $1",[max+1]);
    if(result.rows.length>max+1)
        throw new Error("Isolated legacy Files inventory exceeded the requested bound.");
    const rows=result.rows.slice(0,max);
    const truncated=result.rows.length>max;
    return {rows,truncated,fingerprint:hash(JSON.stringify([truncated,rows.map(canonical)]))};
}
/** Restored database plus recovery-only object GET. No primary-store input,
 * no writes and no network fallback. Include archived legacy files. */
export async function verifyIsolatedLegacyFiles(input:{
    restoredDatabase:Pick<Pool,"query">;
    backup:Pick<RecoveryObjectStore,"getBounded">;
    maxRecords?:number;
}):Promise<IsolatedLegacyRecoveryReport>{
    const max=input.maxRecords??ISOLATED_LEGACY_DEFAULT_RECORDS;
    if(!Number.isSafeInteger(max)||max<1||max>ISOLATED_LEGACY_MAX_RECORDS)
        throw new Error("Invalid bounded isolated legacy Files inventory limit.");
    const initial=await snapshot(input.restoredDatabase,max);
    const observedAt=new Date().toISOString();
    let verified=0,missing=0,corrupt=0,invalidMetadata=0;
    let activeChecked=0,archivedChecked=0;
    for(const row of initial.rows){
        if(row.status==="active")activeChecked++;
        if(row.status==="archived")archivedChecked++;
        if(!valid(row)){invalidMetadata++;continue;}
        let bytes:Buffer;
        try{bytes=await input.backup.getBounded(row.storage_key,MAX_BYTES);}
        catch(error){
            if(error instanceof ObjectNotFound){missing++;continue;}
            // Network/auth/oversize errors are inconclusive, never "missing".
            throw error;
        }
        if(bytes.length!==Number(row.byte_size)||hash(bytes)!==row.checksum)
            corrupt++;
        else verified++;
    }
    const after=await snapshot(input.restoredDatabase,max);
    const catalogChanged=initial.fingerprint!==after.fingerprint;
    const problems=missing+corrupt+invalidMetadata>0||catalogChanged;
    const status=problems?"failed":initial.rows.length===0?"empty":
        initial.truncated?"partial":"passed";
    return {mode:"read-only",scope:"restored-workspace-application-files",
        status,observedAt,inventorySha256:initial.fingerprint,maxRecords:max,
        checked:initial.rows.length,activeChecked,archivedChecked,
        verified,missing,corrupt,invalidMetadata,truncated:initial.truncated,
        catalogChanged,noPrimaryAccess:true,noWrites:true,
        entireLegacyCatalogVerified:status==="passed"};
}
