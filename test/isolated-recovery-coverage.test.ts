import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {after,test} from "node:test";
import sharp from "sharp";
import {AtlasFilesService} from "../apps/server/src/server/atlas-files.js";
import {LocalObjectStore,ObjectNotFound} from "../apps/server/src/server/file-storage.js";
import {PortfolioMediaService,PORTFOLIO_PROJECT_ID} from "../apps/server/src/portfolio/index.js";
import {captureProjectRecoveryManifest} from "../apps/server/src/server/project-independent-recovery.js";
import {verifyIsolatedRecoveryCoverage} from "../apps/server/src/server/isolated-recovery-coverage.js";
import {cleanupDatabases,databaseFixture} from "./database.js";
after(cleanupDatabases);

async function fixture(){
    const db=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"atlas-coverage-"));
    const files=new AtlasFilesService(db.databaseUrl,root);
    const local=new LocalObjectStore(root);
    const objects=new Map<string,Buffer>(),reads:string[]=[];
    const backup={async getBounded(key:string,max:number){
        assert.equal(max,25*1024*1024);
        reads.push(key);
        const data=objects.get(key);
        if(!data)throw new ObjectNotFound();
        return Buffer.from(data);
    }};
    const project=randomUUID();
    await files.pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Coverage',now(),now())",
        [project]);
    // Portfolio's synthetic Project ID must exist for recovery-run foreign keys.
    await files.pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Portfolio',now(),now())",
        [PORTFOLIO_PROJECT_ID]);
    const upload=async(owner:{kind:"project"|"workspace"|"application";id:string},value:string)=>{
        const file=await files.upload({owner,fileName:value+".txt",
            mimeType:"text/plain",bytes:Buffer.from(value)});
        const result=await files.pool.query<{storage_key:string}>(
            "SELECT storage_key FROM atlas_files WHERE id=$1",[file.id]);
        const key=result.rows[0]!.storage_key;
        objects.set(key,await local.getBounded(key,25*1024*1024));
        return {file,key};
    };
    const capture=async(projectId:string)=>{
        const m=await captureProjectRecoveryManifest({
            database:files.pool,source:local,projectId});
        for(const entry of m.entries)
            objects.set(entry.storageKey,await local.getBounded(entry.storageKey,25*1024*1024));
        return {projectId,runId:m.id};
    };
    return {files,root,db,project,upload,capture,objects,reads,backup,
        async close(){await files.close();await rm(root,{recursive:true,force:true});}};
}

test("Complete all-owner recovery verifies native Project, Portfolio originals/variants and archived legacy Files",async()=>{
    const ctx=await fixture();
    const portfolio=new PortfolioMediaService(ctx.db.databaseUrl,ctx.root);
    try{
        await ctx.upload({kind:"project",id:ctx.project},"project-file");
        const img=await sharp({create:{width:15,height:15,channels:4,
            background:{r:25,g:40,b:75,alpha:1}}}).png().toBuffer();
        const media=await portfolio.upload({fileName:"coverage.png",mimeType:"image/png",
            base64:img.toString("base64"),altText:"Archived test image",client:"test"});
        await ctx.files.pool.query("UPDATE media_assets SET status='archived' WHERE id=$1",[media.id]);
        const old=await ctx.upload({kind:"application",id:"legacy-app"},"archive-me");
        await ctx.files.archive({kind:"application",id:"legacy-app"},old.file.id);
        const runs=[await ctx.capture(ctx.project),await ctx.capture(PORTFOLIO_PROJECT_ID)];
        const r=await verifyIsolatedRecoveryCoverage({
            restoredDatabase:ctx.files.pool,backup:ctx.backup,projectRuns:runs});
        assert.equal(r.status,"object-scope-passed");
        assert.equal(r.projectCount,2);
        assert.equal(r.catalogObjects,4);
        assert.equal(r.projectVerified,2);
        assert.equal(r.projectEntriesVerified,4,"four manifest entries, not bytes");
        assert.equal("projectBytesVerified" in r,false,
            "operator output cannot mislabel a count as byte volume");
        assert.equal(r.legacyStatus,"passed");
        assert.equal(r.legacyChecked,1);
        assert.equal(r.legacyVerified,1);
        assert.equal(r.projects.length,2);
        assert.equal(r.projects.every(x=>x.status==="passed"),true);
        assert.equal(r.disasterRecoveryReady,false);
        assert.equal(r.cutoverAuthorized,false);
        assert.equal(r.noPrimaryAccess,true);
        assert.equal(r.noWrites,true);
        assert.deepEqual(r.blockers,[]);
        assert.equal(ctx.reads.length,5);
    }finally{await portfolio.close();await ctx.close();}
});
test("Omitted or extraneous selected Project manifests fail before any Project R2 GET",async()=>{
    const ctx=await fixture();
    try{
        await ctx.upload({kind:"project",id:ctx.project},"source");
        const run=await ctx.capture(ctx.project);
        const other=await ctx.upload({kind:"workspace",id:randomUUID()},"legacy");
        const missing=await verifyIsolatedRecoveryCoverage({
            restoredDatabase:ctx.files.pool,backup:ctx.backup,projectRuns:[]});
        assert.equal(missing.status,"blocked");
        assert.ok(missing.blockers.includes("missing-project-recovery-manifest-selection"));
        assert.equal(missing.projectVerified,0);
        assert.deepEqual(ctx.reads,[other.key]);
        ctx.reads.length=0;
        const extraneous=await verifyIsolatedRecoveryCoverage({
            restoredDatabase:ctx.files.pool,backup:ctx.backup,
            projectRuns:[run,{projectId:randomUUID(),runId:randomUUID()}]});
        assert.equal(extraneous.status,"blocked");
        assert.ok(extraneous.blockers.includes("unexpected-project-run-selection"));
        assert.deepEqual(ctx.reads,[other.key]);
    }finally{await ctx.close();}
});
test("Empty legacy inventory needs explicit acknowledgement and does not count as recovered byte evidence",async()=>{
    const ctx=await fixture();
    try{
        await ctx.upload({kind:"project",id:ctx.project},"only-project");
        const scope=[await ctx.capture(ctx.project)];
        const rejected=await verifyIsolatedRecoveryCoverage({
            restoredDatabase:ctx.files.pool,backup:ctx.backup,projectRuns:scope});
        assert.equal(rejected.status,"blocked");
        assert.ok(rejected.blockers.includes("zero-legacy-catalogue-not-acknowledged"));
        assert.equal(rejected.legacyStatus,"empty");
        const accepted=await verifyIsolatedRecoveryCoverage({
            restoredDatabase:ctx.files.pool,backup:ctx.backup,
            projectRuns:scope,expectNoLegacy:true});
        assert.equal(accepted.status,"object-scope-passed");
        assert.equal(accepted.legacyVerified,0);
        assert.equal(accepted.projectVerified,1);
        assert.equal(accepted.disasterRecoveryReady,false);
    }finally{await ctx.close();}
});
test("Recovery object corruption and concurrent Project changes block combined acceptance",async()=>{
    const ctx=await fixture();
    try{
        const source=await ctx.upload({kind:"project",id:ctx.project},"original");
        const run=await ctx.capture(ctx.project);
        await ctx.upload({kind:"workspace",id:randomUUID()},"legacy");
        ctx.objects.set(source.key,Buffer.from("wrong"));
        const damaged=await verifyIsolatedRecoveryCoverage({
            restoredDatabase:ctx.files.pool,backup:ctx.backup,projectRuns:[run]});
        assert.equal(damaged.status,"blocked");
        assert.ok(damaged.blockers.includes("incomplete-or-failed-project-recovery-bytes"));
        ctx.objects.set(source.key,Buffer.from("original"));
        let changed=false;
        const backing={async getBounded(key:string,max:number){
            if(!changed){changed=true;
                await ctx.upload({kind:"project",id:ctx.project},"new-after-snapshot");
            }
            return ctx.backup.getBounded(key,max);
        }};
        // The lower-level verifier detects catalogue drift and throws before
        // the aggregate could produce a false success (the CLI exits 1).
        await assert.rejects(verifyIsolatedRecoveryCoverage({
            restoredDatabase:ctx.files.pool,backup:backing,projectRuns:[run]}),
            /catalogue|changed/);
        assert.equal(changed,true);
    }finally{await ctx.close();}
});
test("An empty recovered catalogue cannot pass without object bytes",async()=>{
    const ctx=await fixture();
    try{
        const noData=await verifyIsolatedRecoveryCoverage({
            restoredDatabase:ctx.files.pool,backup:ctx.backup,projectRuns:[],
            expectNoProjects:true,expectNoLegacy:true});
        assert.equal(noData.status,"blocked");
        assert.ok(noData.blockers.includes("no-object-recovery-evidence"));
        assert.equal(ctx.reads.length,0);
        await ctx.upload({kind:"application",id:"only-legacy"},"live");
        const selected=await verifyIsolatedRecoveryCoverage({
            restoredDatabase:ctx.files.pool,backup:ctx.backup,projectRuns:[],
            expectNoProjects:true});
        assert.equal(selected.status,"object-scope-passed");
        assert.equal(selected.projectCount,0);
        assert.equal(selected.legacyVerified,1);
        assert.equal(selected.disasterRecoveryReady,false);
    }finally{await ctx.close();}
});


test("More than 1,000 Project source rows fails before any backup GET, even if a versioned run could exceed 2,000 manifest entries",async()=>{
    // Simulate the exact boundary without doing 1,001 physical uploads. A
    // versioned recovery manifest doubles each source row and its persisted
    // schema explicitly caps immutable entries at 2,000.
    const project=randomUUID();
    const rows=Array.from({length:1001},(_,i)=>({
        project_id:project,source:"atlas-file",file_id:randomUUID(),
        variant:"original",storage_key:"files-test-"+i,checksum:"f".repeat(64),
        byte_size:1,mime_type:"text/plain",status:"active",
    }));
    let statementCount=0,objectGets=0;
    const restoredDatabase={
        async query(sql:string,params?:unknown[]){
            statementCount++;
            assert.match(sql,/atlas_project_storage_objects/);
            assert.deepEqual(params,[1001],
                "the source inventory must enforce 1,000 source objects, not 2,000");
            return {rows};
        },
    };
    const backup={async getBounded(){
        objectGets++;
        throw new Error("backup GET must not run after catalogue overflow");
    }};
    await assert.rejects(verifyIsolatedRecoveryCoverage({
        restoredDatabase:restoredDatabase as unknown as
            Parameters<typeof verifyIsolatedRecoveryCoverage>[0]["restoredDatabase"],
        backup,projectRuns:[{projectId:project,runId:randomUUID()}],
        expectNoLegacy:true,
    }),/exceeds 1,000 source rows/);
    assert.equal(statementCount,1);
    assert.equal(objectGets,0);
});
