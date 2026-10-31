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


async function portfolioFailureFixture() {
    const database=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"atlas-portfolio-failed-upload-"));
    const media=new PortfolioMediaService(database.databaseUrl,root,null,true);
    const image=await sharp({create:{width:24,height:21,channels:4,
        background:{r:81,g:39,b:97,alpha:1}}}).png().toBuffer();
    const input={fileName:"uncommitted.png",mimeType:"image/png",
        base64:image.toString("base64"),altText:"Uncommitted media"};
    return {media,input,async close(){await media.close();await rm(root,{recursive:true,force:true});}};
}

/** Inject a lost SQL acknowledgement either before or after a real command.
 * The wrapped connection still executes actual PostgreSQL transactions. */
function interceptMediaQuery(media:PortfolioMediaService,
    decide:(sql:string)=>"before"|"after"|null) {
    const connect=media.pool.connect.bind(media.pool);
    media.pool.connect=((...args:unknown[])=>{
        // Pool.query obtains a connection via callback mode. Forward it
        // unchanged so the failure hook only wraps upload's transaction.
        if(args.length)return Reflect.apply(connect,media.pool,args);
        return connect().then(client=>{
            const query=client.query.bind(client);
            return new Proxy(client,{get(target,property){
                if(property==="query")return async (sql:string,values?:unknown[])=>{
                    const mode=decide(sql);
                    if(mode==="before")throw new Error("injected database failure");
                    const result=await query(sql,values);
                    if(mode==="after")throw new Error("lost database acknowledgement");
                    return result;
                };
                const value=Reflect.get(target,property);
                return typeof value==="function"?value.bind(target):value;
            }});
        });
    }) as typeof media.pool.connect;
}

test("Versioned Portfolio reclaims both attempted objects after a mid-variant PUT loses its acknowledgement",async()=>{
    const {media,input,close}=await portfolioFailureFixture();
    const attempted:string[]=[],removed:string[]=[];
    const put=media.objects.put.bind(media.objects),discard=media.objects.delete.bind(media.objects);
    try{
        media.objects.put=async(key,bytes,mime)=>{
            attempted.push(key);
            await put(key,bytes,mime);
            if(attempted.length===2)throw new Error("lost variant PUT acknowledgement");
        };
        media.objects.delete=async key=>{removed.push(key);await discard(key);};
        await assert.rejects(media.upload(input),/lost variant PUT acknowledgement/);
        assert.equal(attempted.length,2);
        assert.deepEqual(removed,attempted);
        for(const key of attempted)await assert.rejects(media.objects.get(key));
        const assets=await media.pool.query("SELECT id FROM media_assets");
        assert.equal(assets.rowCount,0);
    }finally{await close();}
});

test("Failed Portfolio variant INSERT rolls back and cleans all UUID-based original/variant bytes",async()=>{
    const {media,input,close}=await portfolioFailureFixture();
    const attempted:string[]=[],removed:string[]=[];
    const put=media.objects.put.bind(media.objects),discard=media.objects.delete.bind(media.objects);
    try{
        media.objects.put=async(key,bytes,mime)=>{attempted.push(key);await put(key,bytes,mime);};
        media.objects.delete=async key=>{removed.push(key);await discard(key);};
        interceptMediaQuery(media,sql=>sql.startsWith("INSERT INTO media_variants")?"before":null);
        await assert.rejects(media.upload(input),/injected database failure/);
        assert.equal(attempted.length,3);
        assert.deepEqual(removed,attempted);
        for(const key of attempted)await assert.rejects(media.objects.get(key));
        const assets=await media.pool.query("SELECT id FROM media_assets");
        const variants=await media.pool.query("SELECT asset_id FROM media_variants");
        assert.equal(assets.rowCount,0);
        assert.equal(variants.rowCount,0);
    }finally{await close();}
});

test("Ambiguous COMMIT after success retains all Portfolio bytes and committed metadata",async()=>{
    const {media,input,close}=await portfolioFailureFixture();
    const attempted:string[]=[],removed:string[]=[];
    const put=media.objects.put.bind(media.objects),discard=media.objects.delete.bind(media.objects);
    try{
        media.objects.put=async(key,bytes,mime)=>{attempted.push(key);await put(key,bytes,mime);};
        media.objects.delete=async key=>{removed.push(key);await discard(key);};
        interceptMediaQuery(media,sql=>sql==="COMMIT"?"after":null);
        await assert.rejects(media.upload(input),/lost database acknowledgement/);
        assert.equal(attempted.length,3);
        assert.deepEqual(removed,[]);
        const asset=await media.pool.query<{id:string;storage_key:string}>(
            "SELECT id,storage_key FROM media_assets");
        assert.equal(asset.rowCount,1);
        assert.ok(attempted.includes(asset.rows[0]!.storage_key));
        const variant=await media.pool.query<{storage_key:string}>(
            "SELECT storage_key FROM media_variants WHERE asset_id=$1",[asset.rows[0]!.id]);
        assert.equal(variant.rowCount,2);
        for(const key of attempted)assert.ok((await media.objects.get(key)).length>0);
    }finally{await close();}
});

test("Portfolio preserves unreferenced objects when database lookup cannot prove their absence",async()=>{
    const {media,input,close}=await portfolioFailureFixture();
    const attempted:string[]=[],removed:string[]=[];
    const put=media.objects.put.bind(media.objects),discard=media.objects.delete.bind(media.objects);
    const query=media.pool.query.bind(media.pool);
    try{
        media.objects.put=async(key,bytes,mime)=>{
            attempted.push(key);await put(key,bytes,mime);
            throw new Error("R2 response lost");
        };
        media.objects.delete=async key=>{removed.push(key);await discard(key);};
        media.pool.query=((sql:string,params?:unknown[])=>{
            if(sql.includes("SELECT EXISTS(SELECT 1 FROM media_assets"))
                throw new Error("database unavailable during cleanup");
            return query(sql,params);
        }) as typeof media.pool.query;
        await assert.rejects(media.upload(input),/R2 response lost/);
        assert.equal(attempted.length,1);
        assert.deepEqual(removed,[]);
        assert.ok((await media.objects.get(attempted[0]!)).length>0);
    }finally{await close();}
});
