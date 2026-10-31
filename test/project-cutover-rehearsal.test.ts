import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {after,test} from "node:test";
import sharp from "sharp";
import { Pool } from "pg";
import { AtlasFilesService } from "../apps/server/src/server/atlas-files.js";
import { LocalObjectStore,ObjectNotFound } from "../apps/server/src/server/file-storage.js";
import { PortfolioMediaService,PORTFOLIO_PROJECT_ID } from "../apps/server/src/portfolio/index.js";
import {
    readProjectKeySnapshot,captureProjectKeyRun,advanceProjectKeyRun,
} from "../apps/server/src/server/project-key-ledger.js";
import {
    captureProjectRecoveryManifest,seedProjectRecovery,
} from "../apps/server/src/server/project-independent-recovery.js";
import {
    rehearseProjectCutover,
} from "../apps/server/src/server/project-cutover-rehearsal.js";
import type { BoundedCopyStore } from "../apps/server/src/server/project-key-migration.js";
import {cleanupDatabases,databaseFixture} from "./database.js";
after(cleanupDatabases);

function store(objects:Map<string,Buffer>,attempts:string[]=[]):BoundedCopyStore{
    return {async getBounded(key,max){
        assert.equal(max,25*1024*1024);
        const b=objects.get(key);
        if(!b)throw new ObjectNotFound();
        return Buffer.from(b);
    },async putIfAbsent(key,value){
        attempts.push(key);
        if(objects.has(key))return false;
        objects.set(key,Buffer.from(value));
        return true;
    }};
}
async function fixture(project=randomUUID()){
    const db=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"atlas-cutover-rehearsal-"));
    const files=new AtlasFilesService(db.databaseUrl,root);
    await files.pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Rehearsal',now(),now())",[project]);
    return {db:db.databaseUrl,project,files,root,
        async close(){await files.close();await rm(root,{recursive:true,force:true});}};
}
async function add(ctx:Awaited<ReturnType<typeof fixture>>,text:string){
    return ctx.files.upload({owner:{kind:"project",id:ctx.project},
        fileName:text+".txt",mimeType:"text/plain",bytes:Buffer.from(text)});
}
async function prepared(ctx:Awaited<ReturnType<typeof fixture>>){
    const original=new LocalObjectStore(ctx.root);
    const keyRun=await captureProjectKeyRun(ctx.files.pool,ctx.project);
    const versioned=new Map<string,Buffer>(),writes:string[]=[];
    const copy=store(versioned,writes);
    let copied=0;
    while(copied<keyRun.objectCount){
        const progress=await advanceProjectKeyRun({database:ctx.files.pool,
            source:original,destination:copy,runId:keyRun.id,projectId:ctx.project,
            apply:true,maxFiles:5});
        assert.ok(progress.copiedCount>copied);
        copied=progress.copiedCount;
    }
    const source:BoundedCopyStore={async getBounded(key,max){
        if(versioned.has(key))return copy.getBounded(key,max);
        return original.getBounded(key,max);
    }};
    const recovery=await captureProjectRecoveryManifest({database:ctx.files.pool,
        source,projectId:ctx.project,versionedRunId:keyRun.id});
    const backups=store(new Map());
    for(let i=0;i<recovery.entries.length;i+=5){
        await seedProjectRecovery({database:ctx.files.pool,source,backup:backups,
            runId:recovery.id,projectId:ctx.project,apply:true,maxFiles:5,fromOrdinal:i});
    }
    return {keyRun,recovery,versioned,writes};
}
async function verifyUnchanged(ctx:Awaited<ReturnType<typeof fixture>>,sha:string){
    const fresh=new Pool({connectionString:ctx.db});
    try{
        const snapshot=await readProjectKeySnapshot(fresh,ctx.project);
        assert.equal(snapshot.sha256,sha);
        assert.equal(snapshot.items.every(x=>x.row.storage_key!==x.target),true);
        const lingering=await fresh.query(
            "SELECT count(*)::int AS count FROM atlas_project_recovery_receipts WHERE run_id=$1",
            ["00000000-0000-4000-8000-000000000001"]);
        assert.equal(lingering.rows[0]!.count,0);
    }finally{await fresh.end();}
}
test("Atomic forward and reverse rehearsal rolls back all native Project keys across 6 objects",async()=>{
    const ctx=await fixture();
    try{
        for(let i=0;i<6;i++)await add(ctx,"native-"+i);
        const state=await prepared(ctx);
        const before=await readProjectKeySnapshot(ctx.files.pool,ctx.project);
        const r=await rehearseProjectCutover({database:ctx.files.pool,projectId:ctx.project,
            keyRunId:state.keyRun.id,recoveryRunId:state.recovery.id});
        assert.equal(r.status,"passed");
        assert.equal(r.rows,6);
        assert.equal(r.forwardSimulated,6);
        assert.equal(r.reverseSimulated,6);
        assert.equal(r.tables.atlas_files,6);
        assert.equal(r.tables.media_assets,0);
        assert.equal(r.tables.media_variants,0);
        assert.equal(r.catalogSha256,before.sha256);
        assert.equal(r.storageKeysUnchanged,true);
        assert.equal(r.noCommittedDatabaseWrites,true);
        assert.equal(r.noObjectReads,true);
        assert.equal(r.noObjectWrites,true);
        assert.equal(r.cutoverAuthorized,false);
        assert.equal(state.writes.length,6,"only explicit test fixture key copying wrote bytes");
        await verifyUnchanged(ctx,before.sha256);
        const repeat=await rehearseProjectCutover({database:ctx.files.pool,
            projectId:ctx.project,keyRunId:state.keyRun.id,recoveryRunId:state.recovery.id});
        assert.equal(repeat.status,"passed","rehearsal is repeatable after rollback");
    }finally{await ctx.close();}
});
test("Archived Portfolio original and derivatives update together then rollback without changing URLs",async()=>{
    const ctx=await fixture(PORTFOLIO_PROJECT_ID);
    const media=new PortfolioMediaService(ctx.db,ctx.root);
    try{
        const png=await sharp({create:{width:14,height:11,channels:4,
            background:{r:42,g:55,b:75,alpha:1}}}).png().toBuffer();
        const asset=await media.upload({fileName:"asset.png",mimeType:"image/png",
            base64:png.toString("base64"),altText:"Rehearsal",client:"test"});
        await ctx.files.pool.query("UPDATE media_assets SET status='archived' WHERE id=$1",[asset.id]);
        const state=await prepared(ctx);
        const snapshot=await readProjectKeySnapshot(ctx.files.pool,ctx.project);
        assert.equal(snapshot.items.length,3);
        const r=await rehearseProjectCutover({database:ctx.files.pool,
            projectId:ctx.project,keyRunId:state.keyRun.id,recoveryRunId:state.recovery.id});
        assert.equal(r.rows,3);
        assert.equal(r.tables.media_assets,1);
        assert.equal(r.tables.media_variants,2);
        await verifyUnchanged(ctx,snapshot.sha256);
        const keys=await ctx.files.pool.query<{storage_key:string}>(
            "SELECT storage_key FROM media_assets WHERE id=$1",[asset.id]);
        assert.equal(keys.rows[0]!.storage_key,snapshot.items.find(x=>x.row.variant==="original")!.row.storage_key);
        const variant=await ctx.files.pool.query(
            "SELECT name,storage_key FROM media_variants WHERE asset_id=$1 ORDER BY name",[asset.id]);
        assert.equal(variant.rows.length,2);
        assert.deepEqual(new Set(variant.rows.map(x=>x.storage_key)),
            new Set(snapshot.items.filter(x=>x.row.variant!=="original").map(x=>x.row.storage_key)));
    }finally{await media.close();await ctx.close();}
});
test("Wrong Project, missing independent receipts and stale catalogue all fail without persistent changes",async()=>{
    const ctx=await fixture();
    try{
        const original=await add(ctx,"one");
        const state=await prepared(ctx);
        const before=await readProjectKeySnapshot(ctx.files.pool,ctx.project);
        await assert.rejects(rehearseProjectCutover({database:ctx.files.pool,
            projectId:randomUUID(),keyRunId:state.keyRun.id,recoveryRunId:state.recovery.id}),
            /Project|another|missing/);
        await verifyUnchanged(ctx,before.sha256);
        await ctx.files.pool.query(
            "DELETE FROM atlas_project_recovery_receipts WHERE run_id=$1 AND ordinal=1",[state.recovery.id]);
        await assert.rejects(rehearseProjectCutover({database:ctx.files.pool,
            projectId:ctx.project,keyRunId:state.keyRun.id,recoveryRunId:state.recovery.id}),
            /blocked|incomplete/);
        await verifyUnchanged(ctx,before.sha256);
        await ctx.files.archive({kind:"project",id:ctx.project},original.id);
        await assert.rejects(rehearseProjectCutover({database:ctx.files.pool,
            projectId:ctx.project,keyRunId:state.keyRun.id,recoveryRunId:state.recovery.id}),
            /catalogue|blocked|changed/);
    }finally{await ctx.close();}
});


test("Direct engine refuses the non-disposable database even when CLI validation is bypassed",async()=>{
    const ctx=await fixture();
    try{
        await add(ctx,"safety-boundary");
        const state=await prepared(ctx);
        // Remove the fixture's atlas_test_* search_path, leaving the shared
        // test server's non-disposable database schema. The engine must fail
        // before its first BEGIN or table lock, regardless of valid run IDs.
        const url=new URL(ctx.db);
        url.searchParams.delete("options");
        const unsafe=new Pool({connectionString:url.toString()});
        try{
            await assert.rejects(rehearseProjectCutover({database:unsafe,
                projectId:ctx.project,keyRunId:state.keyRun.id,
                recoveryRunId:state.recovery.id}),/Only disposable PostgreSQL/);
        }finally{await unsafe.end();}
        const before=await readProjectKeySnapshot(ctx.files.pool,ctx.project);
        await verifyUnchanged(ctx,before.sha256);
    }finally{await ctx.close();}
});
