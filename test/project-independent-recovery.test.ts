import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after,test } from "node:test";
import sharp from "sharp";
import { Pool } from "pg";
import { AtlasFilesService } from "../apps/server/src/server/atlas-files.js";
import { LocalObjectStore,ObjectNotFound } from "../apps/server/src/server/file-storage.js";
import { PortfolioMediaService,PORTFOLIO_PROJECT_ID } from "../apps/server/src/portfolio/index.js";
import { captureProjectKeyRun,advanceProjectKeyRun } from "../apps/server/src/server/project-key-ledger.js";
import { captureProjectRecoveryManifest,loadProjectRecoveryManifest,
    seedProjectRecovery,verifyIsolatedProjectRecovery,getProjectRecoverySeedStatus } from "../apps/server/src/server/project-independent-recovery.js";
import type { RecoveryObjectStore } from "../apps/server/src/server/project-independent-recovery.js";
import { cleanupDatabases,databaseFixture } from "./database.js";
after(cleanupDatabases);
function bucket(values:Map<string,Buffer>,writes:string[]=[]):RecoveryObjectStore{
    return {async getBounded(key,max){
        assert.equal(max,25*1024*1024);
        const bytes=values.get(key);
        if(!bytes)throw new ObjectNotFound();
        return Buffer.from(bytes);
    },async putIfAbsent(key,bytes){
        writes.push(key);
        if(values.has(key))return false;
        values.set(key,Buffer.from(bytes));
        return true;
    }};
}
async function fixture(){
    const f=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"atlas-independent-recovery-"));
    const files=new AtlasFilesService(f.databaseUrl,root),project=randomUUID();
    await files.pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Recovered project',now(),now())",[project]);
    return {db:f.databaseUrl,pool:files.pool,root,project,files,
        async close(){await files.close();await rm(root,{recursive:true,force:true});}};
}
async function upload(ctx:Awaited<ReturnType<typeof fixture>>,contents:string){
    return ctx.files.upload({owner:{kind:"project",id:ctx.project},
        fileName:contents+".txt",mimeType:"text/plain",bytes:Buffer.from(contents)});
}
test("Complete legacy Project inventory is captured and restores from recovery-only R2",async()=>{
    const ctx=await fixture();
    try{
        await upload(ctx,"alpha");await upload(ctx,"beta");
        const source=new LocalObjectStore(ctx.root);
        const manifest=await captureProjectRecoveryManifest({
            database:ctx.pool,source,projectId:ctx.project});
        assert.equal(manifest.entries.length,2);
        assert.equal(manifest.versionedCopyRunId,null);
        const persisted=await loadProjectRecoveryManifest(ctx.pool,manifest.id);
        assert.equal(persisted.manifestSha256,manifest.manifestSha256);
        const saved=new Map<string,Buffer>(),writes:string[]=[];
        const backup=bucket(saved,writes);
        const args={database:ctx.pool,source,backup,runId:manifest.id,projectId:ctx.project};
        const dry=await seedProjectRecovery({...args,maxFiles:1});
        assert.equal(dry.status,"partial");assert.equal(dry.planned,1);
        assert.equal(saved.size,0);
        const first=await seedProjectRecovery({...args,apply:true,maxFiles:1});
        assert.equal(first.createdVerified,1);
        assert.equal(first.remaining,true);
        const final=await seedProjectRecovery({...args,apply:true,fromOrdinal:first.nextOrdinal,maxFiles:1});
        assert.equal(final.status,"completed","durable earlier receipt plus final page completes manifest");
        assert.equal(final.remaining,false);
        assert.equal(final.seedComplete,true);
        const receiptStatus=await getProjectRecoverySeedStatus(ctx.pool,manifest.id,ctx.project);
        assert.equal(receiptStatus.status,"complete");
        assert.equal(receiptStatus.verifiedEntries,2);
        const full=await seedProjectRecovery({...args,apply:true,maxFiles:2});
        assert.equal(full.status,"completed","repeat must independently recheck backup");
        assert.equal(saved.size,2);assert.equal(writes.length,2);
        const offline=new Pool({connectionString:ctx.db});
        try{
            // Deliberately supply ONLY restored DB and recovery object source.
            const report=await verifyIsolatedProjectRecovery({
                restoredDatabase:offline,backup,runId:manifest.id,
                projectId:ctx.project,maxFiles:2});
            assert.equal(report.status,"passed");
            assert.equal(report.verified,2);
            assert.equal(report.noPrimaryAccess,true);
            assert.equal(report.noWrites,true);
            const repeat=await seedProjectRecovery({...args,apply:true,maxFiles:2});
            assert.equal(repeat.existingVerified,2);
            assert.equal(writes.length,2);
            const key=manifest.entries[0]!.storageKey;
            saved.set(key,Buffer.from("bad"));
            const corruption=await verifyIsolatedProjectRecovery({
                restoredDatabase:offline,backup,runId:manifest.id,
                projectId:ctx.project,maxFiles:2});
            assert.equal(corruption.status,"failed");
            assert.equal(corruption.corrupt,1);
        }finally{await offline.end();}
    }finally{await ctx.close();}
});
test("Missing, corrupt and wrong-Project backup targets never cause unsafe copy",async()=>{
    const ctx=await fixture();
    try{
        await upload(ctx,"first");await upload(ctx,"second");
        const source=new LocalObjectStore(ctx.root);
        const manifest=await captureProjectRecoveryManifest({database:ctx.pool,source,projectId:ctx.project});
        const bytes=new Map<string,Buffer>(),writes:string[]=[];
        const backup=bucket(bytes,writes);
        bytes.set(manifest.entries[1]!.storageKey,Buffer.from("invalid"));
        await assert.rejects(seedProjectRecovery({database:ctx.pool,source,backup,
            runId:manifest.id,projectId:ctx.project,apply:true,maxFiles:2}),/differs/);
        assert.equal(writes.length,0,"must preflight the entire bounded page");
        await assert.rejects(seedProjectRecovery({database:ctx.pool,source,backup,
            runId:manifest.id,projectId:randomUUID(),apply:true}),/another Project/);
        bytes.delete(manifest.entries[1]!.storageKey);
        const result=await verifyIsolatedProjectRecovery({restoredDatabase:ctx.pool,backup,
            runId:manifest.id,projectId:ctx.project,maxFiles:2});
        assert.equal(result.status,"failed");
        assert.equal(result.missing,2);
    }finally{await ctx.close();}
});
test("Project archive / fresh upload invalidates recovery manifest before offsite writes",async()=>{
    const ctx=await fixture();
    try{
        const original=await upload(ctx,"old");
        const manifest=await captureProjectRecoveryManifest({database:ctx.pool,
            source:new LocalObjectStore(ctx.root),projectId:ctx.project});
        await ctx.files.archive({kind:"project",id:ctx.project},original.id);
        const writes:string[]=[];
        await assert.rejects(seedProjectRecovery({database:ctx.pool,
            source:new LocalObjectStore(ctx.root),backup:bucket(new Map(),writes),
            runId:manifest.id,projectId:ctx.project,apply:true}),/does not match/);
        assert.equal(writes.length,0);
        await assert.rejects(verifyIsolatedProjectRecovery({restoredDatabase:ctx.pool,
            backup:bucket(new Map()),runId:manifest.id,projectId:ctx.project}),/does not match/);
    }finally{await ctx.close();}
});
test("Concurrent catalogue change during hashing rejects recovery capture without a DB run",async()=>{
    const ctx=await fixture();
    try{
        await upload(ctx,"start");
        const local=new LocalObjectStore(ctx.root);let inserted=false;
        const source:RecoveryObjectStore={async getBounded(key,max){
            if(!inserted){inserted=true;await upload(ctx,"new");}
            return local.getBounded(key,max);
        }};
        await assert.rejects(captureProjectRecoveryManifest({database:ctx.pool,
            source,projectId:ctx.project}),/changed during source verification/);
        const count=await ctx.pool.query("SELECT count(*)::int AS count FROM atlas_project_recovery_runs WHERE project_id=$1",[ctx.project]);
        assert.equal(count.rows[0]!.count,0);
    }finally{await ctx.close();}
});
test("Portfolio originals and archived checksum-less variants are included and verified",async()=>{
    const f=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"atlas-portfolio-recovery-"));
    const files=new AtlasFilesService(f.databaseUrl,root);
    const media=new PortfolioMediaService(f.databaseUrl,root);
    try{
        await files.pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Portfolio',now(),now())",
            [PORTFOLIO_PROJECT_ID]);
        const png=await sharp({create:{width:12,height:9,channels:4,
            background:{r:40,g:60,b:90,alpha:1}}}).png().toBuffer();
        const asset=await media.upload({fileName:"sample.png",mimeType:"image/png",
            base64:png.toString("base64"),altText:"Sample",client:"recovery-test"});
        await files.pool.query("UPDATE media_assets SET status='archived' WHERE id=$1",[asset.id]);
        const primary=new LocalObjectStore(root);
        const manifest=await captureProjectRecoveryManifest({database:files.pool,
            source:primary,projectId:PORTFOLIO_PROJECT_ID});
        assert.equal(manifest.entries.length,3);
        assert.equal(manifest.entries.every(x=>x.status==="archived"),true);
        assert.equal(new Set(manifest.entries.map(x=>x.variant)).size,3);
        for(const entry of manifest.entries){
            assert.equal(entry.sha256,createHash("sha256").update(
                await primary.getBounded(entry.storageKey,25*1024*1024)).digest("hex"));
        }
        const backup=bucket(new Map());
        await seedProjectRecovery({database:files.pool,source:primary,backup,
            runId:manifest.id,projectId:PORTFOLIO_PROJECT_ID,apply:true,maxFiles:3});
        const verified=await verifyIsolatedProjectRecovery({restoredDatabase:files.pool,backup,
            runId:manifest.id,projectId:PORTFOLIO_PROJECT_ID,maxFiles:3});
        assert.equal(verified.status,"passed");
        assert.equal(verified.verified,3);
    }finally{await media.close();await files.close();await rm(root,{recursive:true,force:true});}
});
test("Completed Stage 4B receipts allow backup of both legacy and versioned Project keys",async()=>{
    const ctx=await fixture();
    try{
        await upload(ctx,"copied");
        const primary=new LocalObjectStore(ctx.root);
        const keyRun=await captureProjectKeyRun(ctx.pool,ctx.project);
        const versioned=new Map<string,Buffer>(),destination=bucket(versioned);
        const step=await advanceProjectKeyRun({database:ctx.pool,
            source:primary,destination,runId:keyRun.id,projectId:ctx.project,apply:true});
        assert.equal(step.status,"all-copied");
        const union:RecoveryObjectStore={
            async getBounded(key,max){
                if(versioned.has(key))return Buffer.from(versioned.get(key)!);
                return primary.getBounded(key,max);
            },
        };
        const run=await captureProjectRecoveryManifest({database:ctx.pool,source:union,
            projectId:ctx.project,versionedRunId:keyRun.id});
        assert.equal(run.entries.length,2);
        assert.equal(run.entries[0]!.keyKind,"legacy");
        assert.equal(run.entries[1]!.keyKind,"versioned");
        const backup=bucket(new Map());
        const seeded=await seedProjectRecovery({database:ctx.pool,source:union,backup,
            runId:run.id,projectId:ctx.project,apply:true,maxFiles:2});
        assert.equal(seeded.status,"completed");
        assert.equal((await verifyIsolatedProjectRecovery({restoredDatabase:ctx.pool,
            backup,runId:run.id,projectId:ctx.project,maxFiles:2})).status,"passed");
    }finally{await ctx.close();}
});

test("Six-object recovery is durably completed across five-object pages and a fresh DB connection",async()=>{
    const ctx=await fixture();
    try{
        for(let n=0;n<6;n++)await upload(ctx,"batch-"+n);
        const source=new LocalObjectStore(ctx.root);
        const manifest=await captureProjectRecoveryManifest({database:ctx.pool,source,projectId:ctx.project});
        assert.equal(manifest.entries.length,6);
        const objects=new Map<string,Buffer>(),writes:string[]=[];
        const backup=bucket(objects,writes);
        const args={database:ctx.pool,source,backup,runId:manifest.id,projectId:ctx.project,apply:true};
        const before=await getProjectRecoverySeedStatus(ctx.pool,manifest.id,ctx.project);
        assert.equal(before.status,"incomplete");
        assert.equal(before.verifiedEntries,0);
        assert.equal(before.nextOrdinal,0);
        const first=await seedProjectRecovery({...args,maxFiles:5});
        assert.equal(first.status,"partial");
        assert.equal(first.seedComplete,false);
        assert.equal(first.verifiedManifestEntries,5);
        assert.equal(first.nextOrdinal,5);
        assert.equal(first.writesAttempted,5);
        assert.equal(objects.size,5);
        const other=new Pool({connectionString:ctx.db});
        try{
            const persisted=await getProjectRecoverySeedStatus(other,manifest.id,ctx.project);
            assert.equal(persisted.verifiedEntries,5,"receipts survive process/database client restart");
            assert.equal(persisted.nextOrdinal,5);
            const last=await seedProjectRecovery({...args,database:other,fromOrdinal:5,maxFiles:5});
            assert.equal(last.checked,1);
            assert.equal(last.status,"completed");
            assert.equal(last.seedComplete,true);
            assert.equal(last.verifiedManifestEntries,6);
            assert.equal(last.remaining,false);
            assert.equal(last.nextOrdinal,undefined);
            assert.equal(objects.size,6);
            const complete=await getProjectRecoverySeedStatus(other,manifest.id,ctx.project);
            assert.equal(complete.status,"complete");
            assert.equal(complete.verifiedEntries,6);
            assert.equal(complete.totalEntries,6);
            assert.equal(complete.metadataOnly,true);
            assert.equal(complete.noWrites,true);
            assert.equal(writes.length,6);
            await assert.rejects(
                getProjectRecoverySeedStatus(other,manifest.id,randomUUID()),/another Project/);
            const repeat=await seedProjectRecovery({...args,database:other,fromOrdinal:5,maxFiles:1});
            assert.equal(repeat.status,"completed");
            assert.equal(repeat.writesAttempted,0);
            assert.equal(writes.length,6,"re-run never overwrites already verified copy");
        }finally{await other.end();}
    }finally{await ctx.close();}
});

test("Out-of-order seed pages and incomplete attempts never falsely certify whole coverage",async()=>{
    const ctx=await fixture();
    try{
        for(let n=0;n<7;n++)await upload(ctx,"item-"+n);
        const source=new LocalObjectStore(ctx.root);
        const manifest=await captureProjectRecoveryManifest({database:ctx.pool,source,projectId:ctx.project});
        const backing=new Map<string,Buffer>();
        const backup=bucket(backing);
        const args={database:ctx.pool,source,backup,runId:manifest.id,projectId:ctx.project,apply:true};
        const later=await seedProjectRecovery({...args,fromOrdinal:5,maxFiles:2});
        assert.equal(later.status,"partial");
        assert.equal(later.seedComplete,false);
        assert.equal(later.verifiedManifestEntries,2);
        assert.equal(later.nextOrdinal,0,"earliest unverified page is the resume point");
        const before=await ctx.pool.query(
            "SELECT count(*)::int AS count FROM atlas_project_recovery_receipts WHERE run_id=$1",[manifest.id]);
        assert.equal(before.rows[0]!.count,2);
        let interrupted=true;
        const transient={
            async getBounded(key:string,max:number){return backup.getBounded(key,max);},
            async putIfAbsent(key:string,bytes:Buffer,mime:string){
                const wrote=await backup.putIfAbsent!(key,bytes,mime);
                if(interrupted){interrupted=false;throw new Error("PUT acknowledgment lost");}
                return wrote;
            },
        };
        await assert.rejects(seedProjectRecovery({...args,backup:transient,maxFiles:5}),
            /acknowledgment lost/);
        const after=await getProjectRecoverySeedStatus(ctx.pool,manifest.id,ctx.project);
        assert.equal(after.verifiedEntries,2,"inconclusive copy has no durable page receipt");
        assert.equal(after.status,"incomplete");
        const replay=await seedProjectRecovery({...args,maxFiles:5});
        assert.equal(replay.status,"completed","retry verifies previously written bytes");
        assert.equal(replay.verifiedManifestEntries,7);
        const all=await getProjectRecoverySeedStatus(ctx.pool,manifest.id,ctx.project);
        assert.equal(all.status,"complete");
        await ctx.pool.query("DELETE FROM atlas_project_recovery_receipts WHERE run_id=$1 AND ordinal=3",
            [manifest.id]);
        const missing=await getProjectRecoverySeedStatus(ctx.pool,manifest.id,ctx.project);
        assert.equal(missing.status,"incomplete");
        assert.equal(missing.nextOrdinal,3);
        assert.equal(missing.verifiedEntries,6);
    }finally{await ctx.close();}
});
