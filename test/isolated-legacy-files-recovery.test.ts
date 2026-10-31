import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after,test } from "node:test";
import { Pool } from "pg";
import {isolatedLegacyVerificationExitCode} from "../apps/server/src/server/isolated-legacy-files-args.js";
import { AtlasFilesService } from "../apps/server/src/server/atlas-files.js";
import { LocalObjectStore,ObjectNotFound } from "../apps/server/src/server/file-storage.js";
import {
    verifyIsolatedLegacyFiles,
} from "../apps/server/src/server/isolated-legacy-files-recovery.js";
import {
    cleanupDatabases,databaseFixture,
} from "./database.js";

after(cleanupDatabases);
async function fixture(){
    const created=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"atlas-isolated-legacy-"));
    const files=new AtlasFilesService(created.databaseUrl,root);
    const objects=new Map<string,Buffer>(),reads:string[]=[];
    const recovery={async getBounded(key:string,max:number){
        assert.equal(max,25*1024*1024);reads.push(key);
        const bytes=objects.get(key);
        if(bytes===undefined)throw new ObjectNotFound();
        return Buffer.from(bytes);
    }};
    return {db:created.databaseUrl,files,root,objects,reads,recovery,
        async close(){await files.close();await rm(root,{recursive:true,force:true});}};
}
async function add(ctx:Awaited<ReturnType<typeof fixture>>,
    owner:{kind:"workspace"|"application"|"project";id:string},value:string){
    if(owner.kind==="project")await ctx.files.pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,$2,now(),now()) ON CONFLICT (id) DO NOTHING",
        [owner.id,"Project "+owner.id]);
    const uploaded=await ctx.files.upload({owner,fileName:value+".bin",
        mimeType:"application/octet-stream",bytes:Buffer.from(value)});
    const row=await ctx.files.pool.query<{storage_key:string}>(
        "SELECT storage_key FROM atlas_files WHERE id=$1",[uploaded.id]);
    const key=row.rows[0]!.storage_key;
    const bytes=await new LocalObjectStore(ctx.root).getBounded(key,25*1024*1024);
    ctx.objects.set(key,bytes);
    return {uploaded,key};
}

test("Restored legacy Workspace and Application Files include archived bytes and exclude Project Files",async()=>{
    const ctx=await fixture();
    try{
        const workspace=randomUUID();
        const active=await add(ctx,{kind:"workspace",id:workspace},"workspace-live");
        const archived=await add(ctx,{kind:"application",id:"my-application"},"app-archived");
        await ctx.files.archive({kind:"application",id:"my-application"},archived.uploaded.id);
        const project=await add(ctx,{kind:"project",id:randomUUID()},"project-excluded");
        const separate=new Pool({connectionString:ctx.db});
        try{
            const result=await verifyIsolatedLegacyFiles({
                restoredDatabase:separate,backup:ctx.recovery,maxRecords:10});
            assert.equal(result.status,"passed");
            assert.equal(result.entireLegacyCatalogVerified,true);
            assert.equal(isolatedLegacyVerificationExitCode(result),0);
            assert.equal(result.checked,2);
            assert.equal(result.activeChecked,1);
            assert.equal(result.archivedChecked,1);
            assert.equal(result.verified,2);
            assert.equal(result.missing,0);
            assert.equal(result.corrupt,0);
            assert.equal(result.invalidMetadata,0);
            assert.equal(result.truncated,false);
            assert.equal(result.noPrimaryAccess,true);
            assert.equal(result.noWrites,true);
            assert.deepEqual(new Set(ctx.reads),new Set([active.key,archived.key]));
            assert.ok(!ctx.reads.includes(project.key));
        }finally{await separate.end();}
    }finally{await ctx.close();}
});

test("Missing, damaged, and invalid restored legacy metadata all fail closed",async()=>{
    const ctx=await fixture();
    try{
        const first=await add(ctx,{kind:"workspace",id:randomUUID()},"missing-data");
        const second=await add(ctx,{kind:"application",id:"another-app"},"corrupt-data");
        const third=await add(ctx,{kind:"workspace",id:randomUUID()},"metadata-data");
        ctx.objects.delete(first.key);
        ctx.objects.set(second.key,Buffer.from("corrupted"));
        await ctx.files.pool.query(
            "UPDATE atlas_files SET checksum=$2 WHERE id=$1",
            [third.uploaded.id,"f".repeat(64)]);
        const result=await verifyIsolatedLegacyFiles({
            restoredDatabase:ctx.files.pool,backup:ctx.recovery,maxRecords:5});
        assert.equal(result.status,"failed");
        assert.equal(result.entireLegacyCatalogVerified,false);
        assert.equal(result.missing,1);
        assert.equal(result.corrupt,1);
        assert.equal(result.invalidMetadata,1);
        assert.equal(result.verified,0);
        assert.equal(ctx.reads.length,2,
            "Invalid metadata must be rejected before any R2 GET");
    }finally{await ctx.close();}
});

test("Bounded legacy verification refuses to claim all-catalog coverage when truncated",async()=>{
    const ctx=await fixture();
    try{
        for(let i=0;i<4;i++)
            await add(ctx,{kind:"workspace",id:randomUUID()},"page-"+i);
        const result=await verifyIsolatedLegacyFiles({
            restoredDatabase:ctx.files.pool,backup:ctx.recovery,maxRecords:2});
        assert.equal(result.status,"partial");
        assert.equal(result.truncated,true);
        assert.equal(result.checked,2);
        assert.equal(result.verified,2);
        assert.equal(result.entireLegacyCatalogVerified,false);
        assert.equal(ctx.reads.length,2);
        await assert.rejects(verifyIsolatedLegacyFiles({
            restoredDatabase:ctx.files.pool,backup:ctx.recovery,maxRecords:2001}),/limit/);
    }finally{await ctx.close();}
});

test("An empty legacy inventory is distinct from a passing nonempty backup",async()=>{
    const ctx=await fixture();
    try{
        await add(ctx,{kind:"project",id:randomUUID()},"project-only");
        const result=await verifyIsolatedLegacyFiles({
            restoredDatabase:ctx.files.pool,backup:ctx.recovery});
        assert.equal(result.status,"empty");
        assert.equal(result.checked,0);
        assert.equal(result.entireLegacyCatalogVerified,false);
        assert.equal(isolatedLegacyVerificationExitCode(result),2,
            "actual empty restored database must cause non-success operator exit");
        assert.equal(ctx.reads.length,0);
    }finally{await ctx.close();}
});

test("Metadata change during recovery reads is reported as failed, not full coverage",async()=>{
    const ctx=await fixture();
    try{
        await add(ctx,{kind:"workspace",id:randomUUID()},"before");
        let inserted=false;
        const backup={async getBounded(key:string,max:number){
            if(!inserted){
                inserted=true;
                await add(ctx,{kind:"application",id:"later-upload"},"later");
            }
            return ctx.recovery.getBounded(key,max);
        }};
        const result=await verifyIsolatedLegacyFiles({
            restoredDatabase:ctx.files.pool,backup,maxRecords:3});
        assert.equal(result.catalogChanged,true);
        assert.equal(result.status,"failed");
        assert.equal(result.entireLegacyCatalogVerified,false);
        assert.equal(inserted,true);
    }finally{await ctx.close();}
});

test("Recovery authorization and transport errors propagate, never become missing objects",async()=>{
    const ctx=await fixture();
    try{
        await add(ctx,{kind:"workspace",id:randomUUID()},"source");
        await assert.rejects(verifyIsolatedLegacyFiles({
            restoredDatabase:ctx.files.pool,
            backup:{async getBounded(){throw new Error("recovery R2 permission denied");}}}),
            /permission denied/);
        assert.equal(ctx.reads.length,0);
    }finally{await ctx.close();}
});
