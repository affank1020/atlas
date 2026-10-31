import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {after,test} from "node:test";
import sharp from "sharp";
import {Pool} from "pg";
import { AtlasFilesService } from "../apps/server/src/server/atlas-files.js";
import { LocalObjectStore,ObjectNotFound } from "../apps/server/src/server/file-storage.js";
import { PortfolioMediaService,PORTFOLIO_PROJECT_ID } from "../apps/server/src/portfolio/index.js";
import { captureProjectKeyRun,advanceProjectKeyRun } from "../apps/server/src/server/project-key-ledger.js";
import {
    captureProjectRecoveryManifest,seedProjectRecovery,
} from "../apps/server/src/server/project-independent-recovery.js";
import {assessProjectCutover} from "../apps/server/src/server/project-cutover-readiness.js";
import type {BoundedCopyStore} from "../apps/server/src/server/project-key-migration.js";
import {databaseFixture,cleanupDatabases} from "./database.js";
after(cleanupDatabases);

function bucket(values:Map<string,Buffer>,writes:string[]=[]):BoundedCopyStore{
    return {async getBounded(key,maxBytes){
        assert.equal(maxBytes,25*1024*1024);
        const bytes=values.get(key);
        if(bytes===undefined)throw new ObjectNotFound();
        return Buffer.from(bytes);
    },async putIfAbsent(key,bytes){
        writes.push(key);
        if(values.has(key))return false;
        values.set(key,Buffer.from(bytes));return true;
    }};
}
async function setup(projectId=randomUUID()){
    const f=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"atlas-cutover-"));
    const files=new AtlasFilesService(f.databaseUrl,root);
    await files.pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Cutover fixture',now(),now())",
        [projectId]);
    return {files,root,projectId,db:f.databaseUrl,
        async close(){await files.close();await rm(root,{recursive:true,force:true});}};
}
async function add(files:AtlasFilesService,project:string,value:string){
    return files.upload({owner:{kind:"project",id:project},
        fileName:value+".txt",mimeType:"text/plain",bytes:Buffer.from(value)});
}
async function seededState(ctx:Awaited<ReturnType<typeof setup>>,count:number){
    for(let n=0;n<count;n++)await add(ctx.files,ctx.projectId,"item-"+n);
    const liveOld=new LocalObjectStore(ctx.root);
    const created=new Map<string,Buffer>(),writeKeys:string[]=[];
    const liveNew=bucket(created,writeKeys);
    const keyRun=await captureProjectKeyRun(ctx.files.pool,ctx.projectId);
    for(let i=0;i<count;i+=5){
        const result=await advanceProjectKeyRun({database:ctx.files.pool,
            source:liveOld,destination:liveNew,runId:keyRun.id,projectId:ctx.projectId,
            maxFiles:5,apply:true});
        assert.equal(result.copiedCount,Math.min(i+5,count));
    }
    const union:BoundedCopyStore={async getBounded(key,max){
        if(created.has(key))return liveNew.getBounded(key,max);
        return liveOld.getBounded(key,max);
    }};
    const recovery=await captureProjectRecoveryManifest({database:ctx.files.pool,
        source:union,projectId:ctx.projectId,versionedRunId:keyRun.id});
    const recovered=new Map<string,Buffer>(),recoveryWrites:string[]=[];
    const backup=bucket(recovered,recoveryWrites);
    for(let i=0;i<recovery.entries.length;i+=5){
        const result=await seedProjectRecovery({database:ctx.files.pool,source:union,
            backup,runId:recovery.id,projectId:ctx.projectId,apply:true,
            fromOrdinal:i,maxFiles:5});
        assert.equal(result.verifiedManifestEntries,Math.min(i+5,recovery.entries.length));
    }
    return {liveOld,liveNew,backup,created,recovered,keyRun,recovery,writeKeys,recoveryWrites};
}
test("Reconciles six old/new key pairs, every durable receipt and independent R2 without writes",async()=>{
    const ctx=await setup();
    try{
        const obj=await seededState(ctx,6);
        const args={database:ctx.files.pool,projectId:ctx.projectId,
            keyRunId:obj.keyRun.id,recoveryRunId:obj.recovery.id};
        const plan=await assessProjectCutover({...args,mode:"plan",maxFiles:5});
        assert.equal(plan.metadataMatched,true);
        assert.equal(plan.keyCopyReceiptsComplete,true);
        assert.equal(plan.backupReceiptsComplete,true);
        assert.equal(plan.recoveryCoversBothKeys,true);
        assert.equal(plan.byteVerification,"not-run");
        assert.equal(plan.cutoverAuthorized,false);
        assert.equal(plan.checked,5);
        assert.equal(plan.remaining,true);
        assert.equal(plan.mappings.length,5);
        assert.equal(plan.mappings.every(x=>x.table==="atlas_files"&&x.oldKey!==x.newKey),true);
        assert.equal(obj.recoveryWrites.length,12);
        const page=await assessProjectCutover({...args,mode:"verify",maxFiles:5,
            oldSource:obj.liveOld,versionedPrimary:obj.liveNew,
            independentBackup:obj.backup});
        assert.equal(page.byteVerification,"passed-page");
        assert.equal(page.validatedObjects,20,"four independent bounded reads per object");
        assert.equal(page.blockers.length,0);
        assert.equal(page.cutoverAuthorized,false,"even a passing page never authorizes cutover");
        const connection=new Pool({connectionString:ctx.db});
        try{
            const last=await assessProjectCutover({...args,database:connection,
                mode:"verify",fromOrdinal:page.nextOrdinal,maxFiles:5,
                oldSource:obj.liveOld,versionedPrimary:obj.liveNew,
                independentBackup:obj.backup});
            assert.equal(last.checked,1);
            assert.equal(last.remaining,false);
            assert.equal(last.byteVerification,"passed-page");
            assert.equal(last.validatedObjects,4);
            assert.equal(last.cutoverAuthorized,false);
            assert.equal(obj.writeKeys.length,6);
            assert.equal(obj.recoveryWrites.length,12);
        }finally{await connection.end();}
    }finally{await ctx.close();}
});

test("Fail closed on incomplete copy or backup receipts without touching object stores",async()=>{
    const ctx=await setup();
    try{
        const obj=await seededState(ctx,2);
        const args={database:ctx.files.pool,projectId:ctx.projectId,
            keyRunId:obj.keyRun.id,recoveryRunId:obj.recovery.id};
        await ctx.files.pool.query(
            "DELETE FROM atlas_project_recovery_receipts WHERE run_id=$1 AND ordinal=2",
            [obj.recovery.id]);
        let calls=0;
        const never={async getBounded(){calls++;throw new Error("must not perform R2 GET");}};
        const result=await assessProjectCutover({...args,mode:"verify",
            oldSource:never,versionedPrimary:never,independentBackup:never});
        assert.equal(result.backupReceiptsComplete,false);
        assert.ok(result.blockers.includes("incomplete-independent-backup-receipts"));
        assert.equal(result.byteVerification,"not-run");
        assert.equal(calls,0);
        // Restore one missing backup receipt, then remove a key copy receipt.
        await ctx.files.pool.query(
            "INSERT INTO atlas_project_recovery_receipts(run_id,ordinal,sha256,byte_size) "+
            "SELECT run_id,ordinal,sha256,byte_size FROM atlas_project_recovery_entries WHERE run_id=$1 AND ordinal=2",
            [obj.recovery.id]);
        await ctx.files.pool.query("DELETE FROM atlas_project_key_receipts WHERE run_id=$1 AND ordinal=1",[obj.keyRun.id]);
        const second=await assessProjectCutover({...args,mode:"verify",
            oldSource:never,versionedPrimary:never,independentBackup:never});
        assert.ok(second.blockers.includes("incomplete-key-copy-receipts"));
        assert.equal(calls,0);
    }finally{await ctx.close();}
});

test("Classifies missing and corrupt primary/recovery objects; network errors are inconclusive",async()=>{
    const ctx=await setup();
    try{
        const obj=await seededState(ctx,1);
        const args={database:ctx.files.pool,projectId:ctx.projectId,
            keyRunId:obj.keyRun.id,recoveryRunId:obj.recovery.id,mode:"verify" as const};
        const old=obj.recovery.entries[0]!.storageKey,newKey=obj.recovery.entries[1]!.storageKey;
        obj.recovered.delete(old);
        obj.recovered.set(newKey,Buffer.from("corrupted"));
        obj.created.set(newKey,Buffer.from("wrong"));
        const result=await assessProjectCutover({...args,oldSource:obj.liveOld,
            versionedPrimary:obj.liveNew,independentBackup:obj.backup});
        assert.equal(result.byteVerification,"failed-page");
        assert.equal(result.missingObjects,1);
        assert.equal(result.corruptObjects,2);
        assert.ok(result.blockers.includes("missing-recovery-legacy"));
        assert.ok(result.blockers.includes("corrupt-recovery-versioned"));
        assert.ok(result.blockers.includes("corrupt-primary-versioned"));
        await assert.rejects(assessProjectCutover({...args,
            oldSource:{async getBounded(){throw new Error("permission denied");}},
            versionedPrimary:obj.liveNew,independentBackup:obj.backup}),/permission denied/);
    }finally{await ctx.close();}
});

test("Invalid scope, catalogue drift and legacy-only recovery never satisfy cutover preflight",async()=>{
    const ctx=await setup();
    try{
        const obj=await seededState(ctx,1);
        const args={database:ctx.files.pool,projectId:ctx.projectId,
            keyRunId:obj.keyRun.id,recoveryRunId:obj.recovery.id,mode:"plan" as const};
        await assert.rejects(assessProjectCutover({...args,projectId:randomUUID()}),
            /another Project|belongs|not match/);
        await assert.rejects(assessProjectCutover({...args,fromOrdinal:1}),
            /beyond/);
        await assert.rejects(assessProjectCutover({...args,maxFiles:6}),/limited/);
        // Capturing a legacy-only recovery manifest (fully seeded) is not
        // equivalent to backing up all versioned destination keys.
        const legacy=await captureProjectRecoveryManifest({database:ctx.files.pool,
            source:obj.liveOld,projectId:ctx.projectId});
        const dry=await assessProjectCutover({...args,recoveryRunId:legacy.id});
        assert.equal(dry.recoveryCoversBothKeys,false);
        assert.ok(dry.blockers.includes("recovery-missing-versioned-keys"));
        const before=await add(ctx.files,ctx.projectId,"new");
        assert.ok(before.id);
        await assert.rejects(assessProjectCutover(args),/catalogue|changed/);
    }finally{await ctx.close();}
});

test("Portfolio originals and derivatives map to correct authoritative tables without changing public URLs",async()=>{
    const ctx=await setup(PORTFOLIO_PROJECT_ID);
    const media=new PortfolioMediaService(ctx.db,ctx.root);
    try{
        const png=await sharp({create:{width:9,height:8,channels:4,
            background:{r:30,g:40,b:90,alpha:1}}}).png().toBuffer();
        const record=await media.upload({fileName:"test.png",mimeType:"image/png",
            base64:png.toString("base64"),altText:"Test",client:"cutover-test"});
        await ctx.files.pool.query("UPDATE media_assets SET status='archived' WHERE id=$1",[record.id]);
        const obj=await seededState(ctx,0);
        // seededState needs at least one existing asset, already provided by Portfolio.
        assert.equal(obj.keyRun.objectCount,3);
        const plan=await assessProjectCutover({database:ctx.files.pool,
            projectId:ctx.projectId,keyRunId:obj.keyRun.id,
            recoveryRunId:obj.recovery.id,mode:"plan",maxFiles:5});
        assert.equal(plan.metadataMatched,true);
        assert.equal(plan.checked,3);
        assert.equal(plan.mappings.filter(x=>x.table==="media_assets").length,1);
        assert.equal(plan.mappings.filter(x=>x.table==="media_variants").length,2);
        assert.equal(plan.mappings.every(x=>x.fileId===record.id),true);
        assert.equal(plan.cutoverAuthorized,false);
    }finally{await media.close();await ctx.close();}
});
