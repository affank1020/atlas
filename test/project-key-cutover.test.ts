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
import {captureProjectKeyRun,advanceProjectKeyRun} from "../apps/server/src/server/project-key-ledger.js";
import {
    executeProjectKeyCutover,getProjectKeyCutoverStatus,type CutoverReadStore,
} from "../apps/server/src/server/project-key-cutover.js";
import {
    parseProjectKeyCutoverArgs,APPLY_CONFIRM,ROLLBACK_CONFIRM,
} from "../apps/server/src/server/project-key-cutover-args.js";
import {cleanupDatabases,databaseFixture} from "./database.js";
after(cleanupDatabases);

function memory(){
    const objects=new Map<string,Buffer>();
    return {objects,async getBounded(key:string,maxBytes:number){
        assert.equal(maxBytes,25*1024*1024);
        const bytes=objects.get(key);
        if(!bytes)throw new ObjectNotFound();
        return Buffer.from(bytes);
    },async putIfAbsent(key:string,bytes:Buffer){
        if(objects.has(key))return false;
        objects.set(key,Buffer.from(bytes));return true;
    }};
}
async function fixture(projectId=randomUUID()){
    const f=await databaseFixture(),root=await mkdtemp(path.join(os.tmpdir(),"atlas-cutover-apply-"));
    const files=new AtlasFilesService(f.databaseUrl,root);
    await files.pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Cutover',now(),now())",[projectId]);
    const old=new LocalObjectStore(root),newPrimary=memory();
    return {projectId,root,files,old,newPrimary,db:f.databaseUrl,
        async add(value:string){
            return files.upload({owner:{kind:"project",id:projectId},fileName:value+".txt",
                mimeType:"text/plain",bytes:Buffer.from(value)});
        },
        async prepare(){
            const run=await captureProjectKeyRun(files.pool,projectId);
            let processed=0;
            while(processed<run.objectCount){
                const r=await advanceProjectKeyRun({database:files.pool,
                    runId:run.id,projectId,source:old,destination:newPrimary,
                    apply:true,maxFiles:5});
                assert.ok(r.copiedCount>processed);
                processed=r.copiedCount;
            }
            return run;
        },
        async close(){await files.close();await rm(root,{recursive:true,force:true});}};
}
function call(ctx:Awaited<ReturnType<typeof fixture>>,runId:string,mode:"apply"|"rollback",
    oldSource:CutoverReadStore=ctx.old,newPrimary:CutoverReadStore=ctx.newPrimary){
    return executeProjectKeyCutover({database:ctx.files.pool,projectId:ctx.projectId,
        keyRunId:runId,mode,oldSource,newPrimary});
}
test("Apply switches six Project Files atomically, retains old bytes, and rollback restores keys",async()=>{
    const ctx=await fixture();
    try{
        const created=[];
        for(let i=0;i<6;i++)created.push(await ctx.add("file-"+i));
        const run=await ctx.prepare();
        assert.equal((await getProjectKeyCutoverStatus(ctx.files.pool,ctx.projectId)).state,"not-applied");
        const result=await call(ctx,run.id,"apply");
        assert.equal(result.status,"applied");
        assert.equal(result.tables.atlas_files,6);
        assert.equal(result.oldObjectsRetained,true);
        assert.equal(result.noObjectWrites,true);
        const switched=await ctx.files.pool.query<{id:string;storage_key:string}>(
            "SELECT id,storage_key FROM atlas_files WHERE owner_id=$1",[ctx.projectId]);
        for(const row of switched.rows){
            const entry=run.items.find(x=>x.row.file_id===row.id)!;
            assert.equal(row.storage_key,entry.target);
            assert.equal((await ctx.old.get(entry.row.storage_key)).toString(),
                "file-"+created.findIndex(x=>x.id===row.id));
        }
        assert.equal((await getProjectKeyCutoverStatus(ctx.files.pool,ctx.projectId)).state,"applied");
        await assert.rejects(call(ctx,run.id,"apply"),/already has an applied cutover/);
        const reverted=await call(ctx,run.id,"rollback");
        assert.equal(reverted.status,"rolled_back");
        const restored=await ctx.files.pool.query<{id:string;storage_key:string}>(
            "SELECT id,storage_key FROM atlas_files WHERE owner_id=$1",[ctx.projectId]);
        for(const row of restored.rows)
            assert.equal(row.storage_key,run.items.find(x=>x.row.file_id===row.id)!.row.storage_key);
        assert.equal((await getProjectKeyCutoverStatus(ctx.files.pool,ctx.projectId)).state,"rolled_back");
        await assert.rejects(call(ctx,run.id,"rollback"),/no applied cutover/);
        await assert.rejects(call(ctx,run.id,"apply"),/key run cannot be reused/);
    }finally{await ctx.close();}
});
test("A fresh fully verified run can reapply after rollback without discarding prior attempts",async()=>{
    const ctx=await fixture();
    try{
        const original=await ctx.add("original-key");
        const first=await ctx.prepare();
        await call(ctx,first.id,"apply");
        await call(ctx,first.id,"rollback");

        // A fresh immutable snapshot and receipts can reuse matching existing
        // v1 bytes, but the prior key-run ID can NEVER be used for another
        // attempt, even though its metadata was restored to the old key.
        await assert.rejects(call(ctx,first.id,"apply"),/key run cannot be reused/);
        const second=await ctx.prepare();
        assert.notEqual(second.id,first.id);
        const secondResult=await call(ctx,second.id,"apply");
        assert.equal(secondResult.status,"applied");
        const current=await getProjectKeyCutoverStatus(ctx.files.pool,ctx.projectId);
        assert.equal(current.state,"applied");
        assert.equal(current.keyRunId,second.id);
        const key=await ctx.files.pool.query<{storage_key:string}>(
            "SELECT storage_key FROM atlas_files WHERE id=$1",[original.id]);
        assert.equal(key.rows[0]!.storage_key,second.items[0]!.target);

        const historical=await ctx.files.pool.query<{
            key_run_id:string;state:string;rolled_back_at:Date|null
        }>("SELECT key_run_id,state,rolled_back_at FROM atlas_project_storage_cutovers "+
          "WHERE project_id=$1 ORDER BY attempt_id",[ctx.projectId]);
        assert.deepEqual(historical.rows.map(x=>[x.key_run_id,x.state]),[
            [first.id,"rolled_back"],[second.id,"applied"],
        ]);
        assert.ok(historical.rows[0]!.rolled_back_at);
        assert.equal(historical.rows[1]!.rolled_back_at,null);
        await assert.rejects(call(ctx,first.id,"apply"),/already has an applied cutover/);
        await call(ctx,second.id,"rollback");
        await assert.rejects(call(ctx,first.id,"apply"),/key run cannot be reused/);
        await assert.rejects(call(ctx,second.id,"apply"),/key run cannot be reused/);
        const end=await ctx.files.pool.query<{state:string}>(
            "SELECT state FROM atlas_project_storage_cutovers WHERE project_id=$1 ORDER BY attempt_id",
            [ctx.projectId]);
        assert.deepEqual(end.rows.map(x=>x.state),["rolled_back","rolled_back"]);
    }finally{await ctx.close();}
});

test("Reattempt after rollback still requires complete fresh receipts and intact destination bytes",async()=>{
    const ctx=await fixture();
    try{
        await ctx.add("fresh-verified");
        const first=await ctx.prepare();
        await call(ctx,first.id,"apply");
        await call(ctx,first.id,"rollback");
        const second=await ctx.prepare();
        const key=second.items[0]!.target,previous=ctx.newPrimary.objects.get(key)!;
        ctx.newPrimary.objects.set(key,Buffer.from("tampered"));
        await assert.rejects(call(ctx,second.id,"apply"),/bytes differ/);
        ctx.newPrimary.objects.set(key,previous);
        await ctx.files.pool.query(
            "DELETE FROM atlas_project_key_receipts WHERE run_id=$1",[second.id]);
        await assert.rejects(call(ctx,second.id,"apply"),/receipts|copy ledger/);
        assert.equal((await getProjectKeyCutoverStatus(ctx.files.pool,ctx.projectId)).state,"rolled_back");
        const historical=await ctx.files.pool.query(
            "SELECT key_run_id FROM atlas_project_storage_cutovers WHERE project_id=$1",
            [ctx.projectId]);
        assert.deepEqual(historical.rows.map(x=>x.key_run_id),[first.id],
            "failed reattempts must not create history or mutate storage keys");
    }finally{await ctx.close();}
});

test("Archived Portfolio image original/variants switch together; public IDs and URLs remain stable",async()=>{
    const ctx=await fixture(PORTFOLIO_PROJECT_ID);
    const media=new PortfolioMediaService(ctx.db,ctx.root);
    try{
        const bytes=await sharp({create:{width:16,height:15,channels:4,
            background:{r:10,g:25,b:40,alpha:1}}}).png().toBuffer();
        const asset=await media.upload({fileName:"portfolio.png",mimeType:"image/png",
            base64:bytes.toString("base64"),altText:"Test image"});
        const url=asset.url;
        await ctx.files.pool.query("UPDATE media_assets SET status='archived' WHERE id=$1",[asset.id]);
        const run=await ctx.prepare();
        assert.equal(run.items.length,3);
        const result=await call(ctx,run.id,"apply");
        assert.equal(result.tables.media_assets,1);
        assert.equal(result.tables.media_variants,2);
        const rows=await ctx.files.pool.query<{storage_key:string}>(
            "SELECT storage_key FROM media_assets WHERE id=$1",[asset.id]);
        assert.equal(rows.rows[0]!.storage_key,run.items.find(x=>x.row.variant==="original")!.target);
        for(const item of run.items){
            await ctx.old.put(item.target,ctx.newPrimary.objects.get(item.target)!,"application/octet-stream");
        }
        await ctx.files.pool.query("UPDATE media_assets SET status='active' WHERE id=$1",[asset.id]);
        assert.equal((await media.list()).find(x=>x.id===asset.id)!.url,url);
        assert.deepEqual((await media.file(asset.id,"original")).bytes,bytes);
        assert.ok((await media.file(asset.id,"thumbnail")).bytes.length>0);
        // Changes to archive state after apply intentionally block rollback:
        // no older manifest may silently overwrite a newer metadata state.
        await assert.rejects(call(ctx,run.id,"rollback"),/catalogue drift/i);
        await ctx.files.pool.query("UPDATE media_assets SET status='archived' WHERE id=$1",[asset.id]);
        assert.equal((await call(ctx,run.id,"rollback")).status,"rolled_back");
    }finally{await media.close();await ctx.close();}
});
test("Corrupt versioned target, incomplete receipts, and changed catalogue fail before any apply",async()=>{
    const ctx=await fixture();
    try{
        const file=await ctx.add("original");
        const run=await ctx.prepare();
        const item=run.items[0]!;
        ctx.newPrimary.objects.set(item.target,Buffer.from("wrong bytes"));
        await assert.rejects(call(ctx,run.id,"apply"),/bytes differ/);
        ctx.newPrimary.objects.set(item.target,Buffer.from("original"));
        await ctx.files.pool.query(
            "DELETE FROM atlas_project_key_receipts WHERE run_id=$1",[run.id]);
        await assert.rejects(call(ctx,run.id,"apply"),/receipts|copy ledger/);
        assert.equal((await getProjectKeyCutoverStatus(ctx.files.pool,ctx.projectId)).state,"not-applied");
        const key=await ctx.files.pool.query<{storage_key:string}>(
            "SELECT storage_key FROM atlas_files WHERE id=$1",[file.id]);
        assert.equal(key.rows[0]!.storage_key,item.row.storage_key);
    }finally{await ctx.close();}
});
test("A new Project file after apply makes rollback fail closed without changing either key",async()=>{
    const ctx=await fixture();
    const versioned=new AtlasFilesService(ctx.db,ctx.root,null,undefined,true);
    try{
        await ctx.add("before");
        const run=await ctx.prepare();
        await call(ctx,run.id,"apply");
        const newer=await versioned.upload({owner:{kind:"project",id:ctx.projectId},
            fileName:"new.txt",mimeType:"text/plain",bytes:Buffer.from("after")});
        await assert.rejects(call(ctx,run.id,"rollback"),/catalogue count changed/);
        assert.equal((await getProjectKeyCutoverStatus(ctx.files.pool,ctx.projectId)).state,"applied");
        const rows=await ctx.files.pool.query<{storage_key:string}>(
            "SELECT storage_key FROM atlas_files WHERE id=$1",[newer.id]);
        assert.match(rows.rows[0]!.storage_key,/^projects\//);
    }finally{await versioned.close();await ctx.close();}
});
test("A writer arriving after byte preflight is detected under the transaction lock",async()=>{
    const ctx=await fixture();
    try{
        await ctx.add("first");
        const run=await ctx.prepare();
        let inserted=false;
        const racing:CutoverReadStore={async getBounded(key,maxBytes){
            const bytes=await ctx.newPrimary.getBounded(key,maxBytes);
            if(!inserted){inserted=true;await ctx.add("late-writer");}
            return bytes;
        }};
        await assert.rejects(call(ctx,run.id,"apply",ctx.old,racing),/catalogue count changed/);
        assert.equal((await getProjectKeyCutoverStatus(ctx.files.pool,ctx.projectId)).state,"not-applied");
    }finally{await ctx.close();}
});
test("CLI requires mode-specific exact confirmations and forbids unscoped operations",()=>{
    const project=randomUUID(),run=randomUUID();
    assert.deepEqual(parseProjectKeyCutoverArgs(["--status","--project="+project]),
        {mode:"status",projectId:project});
    assert.deepEqual(parseProjectKeyCutoverArgs(["--apply","--project="+project,
        "--key-run="+run,"--confirm="+APPLY_CONFIRM]),
        {mode:"apply",projectId:project,keyRunId:run});
    assert.deepEqual(parseProjectKeyCutoverArgs(["--rollback","--project="+project,
        "--confirm="+ROLLBACK_CONFIRM]),{mode:"rollback",projectId:project});
    for(const args of [[],["--apply","--project="+project],
        ["--apply","--project="+project,"--key-run="+run,"--confirm=YES"],
        ["--rollback","--project="+project,"--key-run="+run,"--confirm="+ROLLBACK_CONFIRM],
        ["--status","--project="+project,"--key-run="+run],
        ["--status","--project="+project,"--confirm=YES"],
        ["--apply","--rollback","--project="+project,"--key-run="+run],
        ["--status","--project=bad"],["--status","--project="+project,"--project="+project],
        ["--status","--project="+project,"--commit"],
    ])assert.throws(()=>parseProjectKeyCutoverArgs(args));
});
