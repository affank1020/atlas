import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { verifyIsolatedProjectRecovery,loadProjectRecoveryManifest } from "./project-independent-recovery.js";
import { verifyIsolatedLegacyFiles } from "./isolated-legacy-files-recovery.js";
import type { RecoveryObjectStore } from "./r2-recovery-verification.js";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// An immutable Project recovery manifest can contain both original and
// versioned entries. Existing manifest/restore tooling caps those at 2,000
// entries (and the key-copy snapshot at 1,000 source rows). Therefore this
// aggregate must bound SOURCE rows to 1,000, not claim 2,000 source rows.
const MAX_PROJECTS=25,MAX_CATALOG_SOURCE_OBJECTS=1000;
export type RecoveryRunScope={projectId:string;runId:string};
type Row={
    project_id:string;source:string;file_id:string;variant:string;
    storage_key:string;checksum:string|null;byte_size:string|number;
    mime_type:string;status:string;
};
type Inventory={projects:string[];objects:number;sha256:string};
export type IsolatedRecoveryCoverage={
    scope:"restored-db-and-independent-r2-all-file-owners";mode:"read-only";
    status:"object-scope-passed"|"blocked";
    catalogSha256:string;projectCount:number;catalogObjects:number;
    projectVerified:number;projectEntriesVerified:number;
    legacyStatus:"passed"|"failed"|"partial"|"empty";
    legacyChecked:number;legacyVerified:number;
    projects:{projectId:string;runId:string;status:"passed"|"failed"|"partial";
        verified:number;expected:number;versionedIncluded:boolean}[];
    blockers:string[];catalogChanged:boolean;
    noPrimaryAccess:true;noWrites:true;
    disasterRecoveryReady:false;cutoverAuthorized:false;
};
const sha=(content:string)=>createHash("sha256").update(content).digest("hex");
async function inventory(db:Pick<Pool,"query">):Promise<Inventory>{
    // One statement for the full Project and Portfolio source inventory.
    // No separate pagination can accidentally certify only the last page.
    const records=await db.query<Row>(
        "SELECT project_id,source,file_id,variant,storage_key,checksum,byte_size,mime_type,status "+
        "FROM atlas_project_storage_objects "+
        "ORDER BY project_id,source,file_id,variant LIMIT $1",
        [MAX_CATALOG_SOURCE_OBJECTS+1]);
    if(records.rows.length>MAX_CATALOG_SOURCE_OBJECTS)
        throw new Error("Project/Portfolio recovery exceeds 1,000 source rows (2,000 possible recovery manifest entries); split or review bounds before acceptance.");
    const projects:string[]=[];
    for(const row of records.rows){
        if(!UUID.test(row.project_id))
            throw new Error("Invalid Project identity in restored storage inventory.");
        if(projects[projects.length-1]!==row.project_id)projects.push(row.project_id);
    }
    if(projects.length>MAX_PROJECTS)
        throw new Error("Too many Projects for one bounded recovery acceptance check.");
    const canonical=records.rows.map(x=>[
        x.project_id,x.source,x.file_id,x.variant,x.storage_key,x.checksum,
        Number(x.byte_size),x.mime_type,x.status,
    ]);
    return {projects,objects:records.rows.length,sha256:sha(JSON.stringify(canonical))};
}
/**
 * All-file-owner recovery-only coverage check, running on a separately
 * restored PostgreSQL database and an independent recovery R2 account.
 *
 * Never infer which recovery run to use from "latest" or silently skip
 * Projects: the operator must supply one exact run ID for EVERY Project
 * with Files/Portfolio objects in the restored catalogue.
 *
 * This verifies referenced bytes on the recovery side; it does not prove
 * snapshot provenance, host isolation, writer quiescence, Atlas boot,
 * actual recovery operations or a production cutover.
 */
export async function verifyIsolatedRecoveryCoverage(input:{
    restoredDatabase:Pick<Pool,"query">;
    backup:Pick<RecoveryObjectStore,"getBounded">;
    projectRuns:RecoveryRunScope[];
    expectNoLegacy?:boolean;
    expectNoProjects?:boolean;
}):Promise<IsolatedRecoveryCoverage>{
    if(!Array.isArray(input.projectRuns)||input.projectRuns.length>MAX_PROJECTS||
       typeof input.expectNoLegacy!=="undefined"&&typeof input.expectNoLegacy!=="boolean"||
       typeof input.expectNoProjects!=="undefined"&&typeof input.expectNoProjects!=="boolean")
        throw new Error("Invalid bounded full-recovery scope.");
    const configured=new Map<string,string>(),usedRuns=new Set<string>();
    for(const pair of input.projectRuns){
        if(!pair||!UUID.test(pair.projectId)||!UUID.test(pair.runId)||
           configured.has(pair.projectId)||usedRuns.has(pair.runId))
            throw new Error("Invalid, duplicate or reused explicit Project recovery run.");
        configured.set(pair.projectId,pair.runId);usedRuns.add(pair.runId);
    }
    const first=await inventory(input.restoredDatabase);
    const wanted=new Set(first.projects);
    const blockers:string[]=[];
    const block=(name:string)=>{if(!blockers.includes(name))blockers.push(name);};
    if(first.projects.length===0&&!input.expectNoProjects)
        block("zero-project-catalogue-not-acknowledged");
    if(first.projects.length!==0&&input.expectNoProjects)
        block("unexpected-project-storage-present");
    if(first.projects.some(id=>!configured.has(id)))
        block("missing-project-recovery-manifest-selection");
    if([...configured.keys()].some(id=>!wanted.has(id)))
        block("unexpected-project-run-selection");
    let projectVerified=0,projectEntriesVerified=0;
    const projects:IsolatedRecoveryCoverage["projects"]=[];
    // Do not spend a single R2 GET on a partial or mismatched Project
    // selection. One omitted Project makes the whole request incomplete.
    if(!blockers.length){
        for(const projectId of first.projects){
            const runId=configured.get(projectId)!;
            const manifest=await loadProjectRecoveryManifest(input.restoredDatabase,runId);
            if(manifest.projectId!==projectId)
                throw new Error("Selected recovery run belongs to a different Project.");
            const result=await verifyIsolatedProjectRecovery({
                restoredDatabase:input.restoredDatabase,backup:input.backup,
                projectId,runId,maxFiles:2000,
            });
            projects.push({projectId,runId,status:result.status,verified:result.verified,
                expected:manifest.entries.length,versionedIncluded:manifest.versionedCopyRunId!==null});
            if(result.status==="passed"&&result.verified===manifest.entries.length){
                projectVerified++;projectEntriesVerified+=result.verified;
            }else block("incomplete-or-failed-project-recovery-bytes");
        }
    }
    const legacy=await verifyIsolatedLegacyFiles({
        restoredDatabase:input.restoredDatabase,backup:input.backup,maxRecords:2000,
    });
    if(legacy.status==="empty"){
        if(!input.expectNoLegacy)block("zero-legacy-catalogue-not-acknowledged");
    }else if(legacy.status!=="passed"||input.expectNoLegacy){
        block("legacy-catalogue-not-fully-recovered");
    }
    const after=await inventory(input.restoredDatabase);
    const catalogChanged=first.sha256!==after.sha256||
        first.objects!==after.objects||JSON.stringify(first.projects)!==JSON.stringify(after.projects);
    if(catalogChanged)block("project-catalogue-changed-during-recovery-verification");
    if(projectVerified!==first.projects.length)block("not-all-projects-verified");
    if(projectVerified===0&&legacy.verified===0)
        block("no-object-recovery-evidence");
    return {scope:"restored-db-and-independent-r2-all-file-owners",
        mode:"read-only",status:blockers.length?"blocked":"object-scope-passed",
        catalogSha256:first.sha256,projectCount:first.projects.length,
        catalogObjects:first.objects,projectVerified,projectEntriesVerified,
        legacyStatus:legacy.status,legacyChecked:legacy.checked,legacyVerified:legacy.verified,
        projects,blockers,catalogChanged,noPrimaryAccess:true,noWrites:true,
        disasterRecoveryReady:false,cutoverAuthorized:false};
}
