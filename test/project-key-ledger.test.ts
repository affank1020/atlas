import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Pool } from "pg";
import sharp from "sharp";
import { AtlasFilesService } from "../apps/server/src/server/atlas-files.js";
import { LocalObjectStore, ObjectNotFound } from "../apps/server/src/server/file-storage.js";
import { PortfolioMediaService, PORTFOLIO_PROJECT_ID } from "../apps/server/src/portfolio/index.js";
import {
    advanceProjectKeyRun,auditProjectKeyRun,captureProjectKeyRun,
    projectKeyLedgerStatus,readProjectKeySnapshot,
} from "../apps/server/src/server/project-key-ledger.js";
import type { BoundedCopyStore } from "../apps/server/src/server/project-key-migration.js";
import { cleanupDatabases,databaseFixture } from "./database.js";

after(cleanupDatabases);

function destination(values: Map<string,Buffer>, attempted: string[] = []): BoundedCopyStore {
    return {
        async getBounded(key,maxBytes) {
            assert.equal(maxBytes,25*1024*1024);
            const bytes=values.get(key);
            if (!bytes) throw new ObjectNotFound();
            return Buffer.from(bytes);
        },
        async putIfAbsent(key,bytes,_mimeType) {
            attempted.push(key);
            if (values.has(key)) return false;
            values.set(key,Buffer.from(bytes));
            return true;
        },
    };
}
async function setup() {
    const fixture=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"project-key-ledger-"));
    const files=new AtlasFilesService(fixture.databaseUrl,root);
    const id=randomUUID();
    await files.pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Ledger project',now(),now())",[id]);
    return {fixture,files,root,id,
        async close() { await files.close(); await rm(root,{recursive:true,force:true}); }};
}
async function upload(files:AtlasFilesService,project:string,value:string) {
    return files.upload({owner:{kind:"project",id:project},fileName:value+".bin",
        mimeType:"application/octet-stream",bytes:Buffer.from(value)});
}
test("Captured manifest persists full immutable metadata and resumes across service instances",async()=>{
    const ctx=await setup();
    try {
        const first=await upload(ctx.files,ctx.id,"first");
        const second=await upload(ctx.files,ctx.id,"second");
        const source=new LocalObjectStore(ctx.root),values=new Map<string,Buffer>(),writes:string[]=[];
        const target=destination(values,writes);
        const run=await captureProjectKeyRun(ctx.files.pool,ctx.id);
        assert.equal(run.objectCount,2);
        assert.equal(run.items.length,2);
        const initial=await projectKeyLedgerStatus(ctx.files.pool,run.id);
        assert.equal(initial.nextOrdinal,0);
        assert.equal(initial.currentCatalogMatches,true);
        assert.equal(initial.allCopied,false);
        const dry=await advanceProjectKeyRun({database:ctx.files.pool,source,destination:target,
            runId:run.id,projectId:ctx.id,maxFiles:1});
        assert.equal(dry.status,"dry-run");
        assert.equal(dry.newlyReceipted,0);
        assert.equal(values.size,0);
        const applied=await advanceProjectKeyRun({database:ctx.files.pool,source,destination:target,
            runId:run.id,projectId:ctx.id,maxFiles:1,apply:true});
        assert.equal(applied.status,"copied");
        assert.equal(applied.nextOrdinal,1);
        const otherConnection=new Pool({connectionString:ctx.fixture.databaseUrl});
        try {
            const persisted=await projectKeyLedgerStatus(otherConnection,run.id);
            assert.equal(persisted.receipts,1);
            assert.equal(persisted.nextOrdinal,1);
            const end=await advanceProjectKeyRun({database:otherConnection,source,destination:target,
                runId:run.id,projectId:ctx.id,maxFiles:1,apply:true});
            assert.equal(end.status,"all-copied");
            const all=await projectKeyLedgerStatus(otherConnection,run.id);
            assert.equal(all.receipts,2);
            assert.equal(all.allCopied,true);
            const again=await advanceProjectKeyRun({database:otherConnection,source,destination:target,
                runId:run.id,projectId:ctx.id,apply:true});
            assert.equal(again.status,"all-copied");
            assert.equal(again.newlyReceipted,0);
            const audit=await auditProjectKeyRun({database:otherConnection,source,destination:target,
                runId:run.id,projectId:ctx.id,maxFiles:2});
            assert.deepEqual({status:audit.status,verified:audit.verified,remaining:audit.remaining},
                {status:"passed-page",verified:2,remaining:false});
            assert.equal(values.size,2);
            assert.equal(writes.length,2);
            assert.deepEqual(new Set(run.items.map(i=>i.row.file_id)),new Set([first.id,second.id]));
            assert.equal((await ctx.files.download({kind:"project",id:ctx.id},first.id)).bytes.toString(),"first");
        } finally { await otherConnection.end(); }
    } finally { await ctx.close(); }
});

test("A changed, archived or newly added catalogue entry invalidates the captured run",async()=>{
    const ctx=await setup();
    try {
        const original=await upload(ctx.files,ctx.id,"before");
        const run=await captureProjectKeyRun(ctx.files.pool,ctx.id);
        await ctx.files.archive({kind:"project",id:ctx.id},original.id);
        const status=await projectKeyLedgerStatus(ctx.files.pool,run.id);
        assert.equal(status.currentCatalogMatches,false);
        const bytes=new Map<string,Buffer>(),writes:string[]=[];
        await assert.rejects(advanceProjectKeyRun({database:ctx.files.pool,
            source:new LocalObjectStore(ctx.root),destination:destination(bytes,writes),
            runId:run.id,projectId:ctx.id,apply:true}),/catalogue changed/);
        assert.equal(writes.length,0);
        const recaptured=await captureProjectKeyRun(ctx.files.pool,ctx.id);
        await upload(ctx.files,ctx.id,"after");
        assert.equal((await projectKeyLedgerStatus(ctx.files.pool,recaptured.id)).currentCatalogMatches,false);
        assert.equal(bytes.size,0);
    } finally { await ctx.close(); }
});

test("The run is strictly Project-scoped and incomplete receipts never pass audit",async()=>{
    const ctx=await setup();
    try {
        await upload(ctx.files,ctx.id,"one");
        const run=await captureProjectKeyRun(ctx.files.pool,ctx.id);
        const other=randomUUID();
        await assert.rejects(advanceProjectKeyRun({database:ctx.files.pool,
            source:new LocalObjectStore(ctx.root),destination:destination(new Map()),
            runId:run.id,projectId:other,apply:true}),/another Project/);
        await assert.rejects(auditProjectKeyRun({database:ctx.files.pool,
            source:new LocalObjectStore(ctx.root),destination:destination(new Map()),
            runId:run.id,projectId:other}),/different Project/);
        const incomplete=await auditProjectKeyRun({database:ctx.files.pool,
            source:new LocalObjectStore(ctx.root),destination:destination(new Map()),
            runId:run.id,projectId:ctx.id});
        assert.equal(incomplete.status,"incomplete");
        assert.equal(incomplete.missingReceipts,1);
    } finally { await ctx.close(); }
});

test("Lost conditional-PUT acknowledgement never records progress; retry verifies its byte-identical copy",async()=>{
    const ctx=await setup();
    try {
        await upload(ctx.files,ctx.id,"lost");
        const run=await captureProjectKeyRun(ctx.files.pool,ctx.id);
        const values=new Map<string,Buffer>();
        let fail=true;
        const target: BoundedCopyStore={
            ...destination(values),
            async putIfAbsent(key,bytes) {
                values.set(key,Buffer.from(bytes));
                if (fail) { fail=false;throw new Error("Acknowledgement lost"); }
                return false;
            },
        };
        const params={database:ctx.files.pool,source:new LocalObjectStore(ctx.root),
            destination:target,runId:run.id,projectId:ctx.id,apply:true};
        await assert.rejects(advanceProjectKeyRun(params),/copy failed/);
        assert.equal((await projectKeyLedgerStatus(ctx.files.pool,run.id)).receipts,0);
        const retried=await advanceProjectKeyRun(params);
        assert.equal(retried.status,"all-copied");
        assert.equal(retried.newlyReceipted,1);
        values.set(run.items[0]!.target,Buffer.from("corrupt"));
        await assert.rejects(auditProjectKeyRun({database:ctx.files.pool,
            source:new LocalObjectStore(ctx.root),destination:target,runId:run.id,projectId:ctx.id}),/corrupt/);
    } finally { await ctx.close(); }
});

test("Portfolio originals and every archived derivative receive independently hashed receipts",async()=>{
    const fixture=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"portfolio-key-ledger-"));
    const files=new AtlasFilesService(fixture.databaseUrl,root);
    const media=new PortfolioMediaService(fixture.databaseUrl,root);
    try {
        await files.pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Portfolio',now(),now())",
            [PORTFOLIO_PROJECT_ID]);
        const png=await sharp({create:{width:9,height:8,channels:4,
            background:{r:30,g:70,b:100,alpha:1}}}).png().toBuffer();
        const saved=await media.upload({fileName:"Image.png",mimeType:"image/png",
            base64:png.toString("base64"),altText:"Image",client:"ledger-test"});
        await files.pool.query("UPDATE media_assets SET status='archived' WHERE id=$1",[saved.id]);
        const snapshot=await readProjectKeySnapshot(files.pool,PORTFOLIO_PROJECT_ID);
        assert.equal(snapshot.items.length,3);
        assert.equal(snapshot.items.filter(x=>x.row.checksum===null).length,2);
        const run=await captureProjectKeyRun(files.pool,PORTFOLIO_PROJECT_ID);
        const target=destination(new Map());
        const result=await advanceProjectKeyRun({database:files.pool,
            source:new LocalObjectStore(root),destination:target,
            runId:run.id,projectId:PORTFOLIO_PROJECT_ID,maxFiles:3,apply:true});
        assert.equal(result.status,"all-copied");
        const audit=await auditProjectKeyRun({database:files.pool,source:new LocalObjectStore(root),
            destination:target,runId:run.id,projectId:PORTFOLIO_PROJECT_ID,maxFiles:3});
        assert.equal(audit.verified,3);
        assert.equal(audit.status,"passed-page");
    } finally { await media.close();await files.close();await rm(root,{recursive:true,force:true}); }
});

test("A run snapshot remains consistent when the source catalogue is empty or unexpectedly large",async()=>{
    const ctx=await setup();
    try {
        await assert.rejects(captureProjectKeyRun(ctx.files.pool,ctx.id),/empty Project/);
        const count=await ctx.files.pool.query("SELECT count(*)::int AS n FROM atlas_project_key_runs WHERE project_id=$1",[ctx.id]);
        assert.equal(count.rows[0]!.n,0,"empty capture must not leave a partial header");
    } finally { await ctx.close(); }
});

test("Catalogue insertion between initial fingerprint and copy preflight cannot create unmanifested R2 keys",async()=>{
    const ctx=await setup();
    try {
        await upload(ctx.files,ctx.id,"captured-original");
        const run=await captureProjectKeyRun(ctx.files.pool,ctx.id);
        const local=new LocalObjectStore(ctx.root);
        const keys=new Map<string,Buffer>(),writes:string[]=[];
        let injected=false;
        const source:BoundedCopyStore={
            async getBounded(key,maxBytes) {
                if (!injected) {
                    injected=true;
                    // This upload occurs after the ledger has accepted the
                    // catalogue fingerprint but before a copy's first PUT.
                    await upload(ctx.files,ctx.id,"unmanifested-later-upload");
                }
                return local.getBounded(key,maxBytes);
            },
        };
        await assert.rejects(advanceProjectKeyRun({database:ctx.files.pool,
            source,destination:destination(keys,writes),
            runId:run.id,projectId:ctx.id,apply:true,maxFiles:2}),/catalogue changed/);
        assert.equal(injected,true);
        assert.deepEqual(writes,[],"not even the manifest's first target may be copied after drift");
        assert.equal(keys.size,0);
        assert.equal((await projectKeyLedgerStatus(ctx.files.pool,run.id)).receipts,0);
        // The saved manifest stays immutable; a retry must reject the drift,
        // rather than copying the newly inserted live-catalogue row.
        await assert.rejects(advanceProjectKeyRun({database:ctx.files.pool,
            source:local,destination:destination(keys,writes),
            runId:run.id,projectId:ctx.id,apply:true}),/catalogue changed/);
        assert.deepEqual(writes,[]);
    } finally { await ctx.close(); }
});

test("Earlier manifest row changed mid-copy cannot slip through a matching last-row cursor",async()=>{
    const ctx=await setup();
    try {
        const first=await upload(ctx.files,ctx.id,"first-row");
        await upload(ctx.files,ctx.id,"second-row");
        const run=await captureProjectKeyRun(ctx.files.pool,ctx.id);
        assert.equal(run.objectCount,2);
        const earlier=run.items[0]!.row.file_id;
        const later=run.items[1]!.row.file_id;
        const local=new LocalObjectStore(ctx.root);
        let changed=false;
        const source:BoundedCopyStore={
            async getBounded(key,maxBytes) {
                if (!changed) {
                    changed=true;
                    await ctx.files.archive({kind:"project",id:ctx.id},earlier);
                }
                return local.getBounded(key,maxBytes);
            },
        };
        const objects=new Map<string,Buffer>(),writes:string[]=[];
        await assert.rejects(advanceProjectKeyRun({database:ctx.files.pool,
            source,destination:destination(objects,writes),runId:run.id,
            projectId:ctx.id,apply:true,maxFiles:2}),/catalogue changed/);
        assert.equal(changed,true);
        assert.equal(run.items[1]!.row.file_id,later,"last cursor remains unchanged");
        assert.equal(writes.length,0);
        assert.equal((await projectKeyLedgerStatus(ctx.files.pool,run.id)).receipts,0);
        assert.equal(first.id===earlier || first.id===later,true);
    } finally { await ctx.close(); }
});
