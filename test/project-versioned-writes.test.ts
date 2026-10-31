import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {after,test} from "node:test";
import sharp from "sharp";
import type {PoolClient} from "pg";
import {AtlasFilesService} from "../apps/server/src/server/atlas-files.js";
import {LocalObjectStore,projectStorageKey,isLegacyObjectKey} from "../apps/server/src/server/file-storage.js";
import {PortfolioMediaService,PORTFOLIO_PROJECT_ID} from "../apps/server/src/portfolio/index.js";
import {loadProjectVersionedWritesConfig} from "../apps/server/src/server/config.js";
import {cleanupDatabases,databaseFixture} from "./database.js";
after(cleanupDatabases);

test("Project versioned native uploads coexist with legacy ownership, reads and archived restores",async()=>{
    const f=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"atlas-new-project-key-"));
    const project=randomUUID(),owner={kind:"project" as const,id:project};
    const files=new AtlasFilesService(f.databaseUrl,root,null,undefined,true);
    const previous=new AtlasFilesService(f.databaseUrl,root);
    try{
        await files.pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'New',now(),now())",[project]);
        const old=await previous.upload({owner,fileName:"old.txt",mimeType:"text/plain",
            bytes:Buffer.from("existing-old")});
        const current=await files.upload({owner,fileName:"new.txt",mimeType:"text/plain",
            bytes:Buffer.from("project-new")});
        const stored=await files.pool.query<{id:string;storage_key:string}>(
            "SELECT id,storage_key FROM atlas_files WHERE id=ANY($1::uuid[]) ORDER BY id",
            [[old.id,current.id]]);
        const keys=new Map(stored.rows.map(row=>[row.id,row.storage_key]));
        assert.equal(isLegacyObjectKey(keys.get(old.id)!),true);
        assert.equal(keys.get(current.id),projectStorageKey(project,current.id));
        assert.equal((await files.download(owner,old.id)).bytes.toString(),"existing-old");
        assert.equal((await previous.download(owner,current.id)).bytes.toString(),"project-new");
        await files.archive(owner,current.id);
        await files.restore(owner,current.id);
        assert.equal((await files.download(owner,current.id)).bytes.toString(),"project-new");
        const app=await files.upload({owner:{kind:"application",id:"legacy-app"},
            fileName:"app.txt",mimeType:"text/plain",bytes:Buffer.from("app-legacy")});
        const appKey=await files.pool.query<{storage_key:string}>(
            "SELECT storage_key FROM atlas_files WHERE id=$1",[app.id]);
        assert.equal(isLegacyObjectKey(appKey.rows[0]!.storage_key),true);
    }finally{await files.close();await previous.close();await rm(root,{recursive:true,force:true});}
});

test("Failed versioned Project metadata write cleans only the uncommitted v1 object",async()=>{
    const f=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"atlas-new-project-reclaim-"));
    const project=randomUUID(),source=new LocalObjectStore(root);
    const created:string[]=[],deleted:string[]=[];
    const objects={
        async put(key:string,data:Buffer,mime:string){created.push(key);await source.put(key,data,mime);},
        async get(key:string){return source.get(key);},
        async delete(key:string){deleted.push(key);await source.delete(key);},
    };
    const files=new AtlasFilesService(f.databaseUrl,root,null,objects,true);
    try{
        await files.pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Cleanup',now(),now())",[project]);
        const rejected={query:async()=>{throw new Error("injected metadata failure");}} as unknown as PoolClient;
        await assert.rejects(files.upload({
            owner:{kind:"project",id:project},fileName:"failed.txt",
            mimeType:"text/plain",bytes:Buffer.from("orphan"),database:rejected,
        }),/injected metadata failure/);
        assert.equal(created.length,1);
        assert.equal(created[0]?.startsWith("projects/"+project+"/objects/"),true);
        assert.deepEqual(deleted,created);
        await assert.rejects(source.get(created[0]!));
        const rows=await files.pool.query("SELECT count(*)::int AS count FROM atlas_files");
        assert.equal(rows.rows[0].count,0);
    }finally{await files.close();await rm(root,{recursive:true,force:true});}
});

test("Portfolio writes versioned originals and derivatives while keeping public URLs stable",async()=>{
    const f=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"atlas-new-portfolio-key-"));
    const media=new PortfolioMediaService(f.databaseUrl,root,null,true);
    const legacy=new PortfolioMediaService(f.databaseUrl,root,null,false);
    try{
        const image=await sharp({create:{width:27,height:19,channels:4,
            background:{r:22,g:63,b:87,alpha:1}}}).png().toBuffer();
        const original=await media.upload({
            fileName:"versioned.png",mimeType:"image/png",base64:image.toString("base64"),
            altText:"New Project image",
        });
        const id=original!.id;
        const asset=await media.pool.query<{storage_key:string}>(
            "SELECT storage_key FROM media_assets WHERE id=$1",[id]);
        assert.equal(asset.rows[0]!.storage_key,projectStorageKey(PORTFOLIO_PROJECT_ID,id));
        const derivatives=await media.pool.query<{name:string;storage_key:string}>(
            "SELECT name,storage_key FROM media_variants WHERE asset_id=$1 ORDER BY name",[id]);
        assert.deepEqual(derivatives.rows.map(row=>row.name),["preview","thumbnail"]);
        for(const variant of derivatives.rows)
            assert.equal(variant.storage_key,projectStorageKey(PORTFOLIO_PROJECT_ID,id,variant.name));
        assert.deepEqual((await media.file(id,"original")).bytes,image);
        assert.deepEqual((await legacy.file(id,"original")).bytes,image);
        assert.ok((await media.file(id,"thumbnail")).bytes.length>0);
        assert.equal(original!.url,"/api/media/"+id+"/original");
        const pdf=Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF");
        const previous=await legacy.upload({
            fileName:"legacy.pdf",mimeType:"application/pdf",
            base64:pdf.toString("base64"),
        });
        const prior=await media.pool.query<{storage_key:string}>(
            "SELECT storage_key FROM media_assets WHERE id=$1",[previous!.id]);
        assert.equal(isLegacyObjectKey(prior.rows[0]!.storage_key),true);
        assert.deepEqual((await media.file(previous!.id,"original")).bytes,pdf);
    }finally{await media.close();await legacy.close();await rm(root,{recursive:true,force:true});}
});

test("Versioned writes default off, reject unsafe flags and require primary R2",()=>{
    assert.deepEqual(loadProjectVersionedWritesConfig({} as NodeJS.ProcessEnv,false),{enabled:false});
    assert.deepEqual(loadProjectVersionedWritesConfig({
        ATLAS_PROJECT_VERSIONED_WRITES_ENABLED:"false",
    } as NodeJS.ProcessEnv,true),{enabled:false});
    assert.deepEqual(loadProjectVersionedWritesConfig({
        ATLAS_PROJECT_VERSIONED_WRITES_ENABLED:"true",
    } as NodeJS.ProcessEnv,true),{enabled:true});
    assert.throws(()=>loadProjectVersionedWritesConfig({
        ATLAS_PROJECT_VERSIONED_WRITES_ENABLED:"true",
    } as NodeJS.ProcessEnv,false),/require configured primary R2/);
    for(const flag of ["TRUE","yes","1","on","disabled"]){
        assert.throws(()=>loadProjectVersionedWritesConfig({
            ATLAS_PROJECT_VERSIONED_WRITES_ENABLED:flag,
        } as NodeJS.ProcessEnv,true),/must be true or false/);
    }
});
