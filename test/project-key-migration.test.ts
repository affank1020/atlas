import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { Pool } from "pg";
import { AtlasFilesService } from "../apps/server/src/server/atlas-files.js";
import { databaseFixture, cleanupDatabases } from "./database.js";

after(cleanupDatabases);
import {
    LocalObjectStore, ObjectNotFound, R2ObjectStore, projectStorageKey, isProjectObjectKey, isLegacyObjectKey,
} from "../apps/server/src/server/file-storage.js";
import {
    copyProjectKeys, decodeKeyCopyCursor, encodeKeyCopyCursor, parseKeyCopyArgs, PROJECT_KEY_COPY_CONFIRMATION,
    type BoundedCopyStore,
} from "../apps/server/src/server/project-key-migration.js";

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const projectId = randomUUID();
type Row = {
    project_id: string; source: "atlas-file" | "portfolio-media"; file_id: string; variant: string;
    storage_key: string; checksum: string | null; byte_size: number; mime_type: string; status: string;
};
function row(bytes: Buffer, source: Row["source"] = "portfolio-media", variant = "original",
    fileId = randomUUID()): Row {
    const checksum = hash(bytes);
    return { project_id: projectId, source, file_id: fileId, variant,
        storage_key: source === "atlas-file" ? "files-" + fileId.replaceAll("-", "") + "-" + checksum
            : checksum + (variant === "original" ? ".png" : "-preview.webp"),
        checksum: variant === "original" ? checksum : null, byte_size: bytes.length,
        mime_type: variant === "original" ? "image/png" : "image/webp", status: "active" };
}
function database(rows: Row[]) {
    const sorted = [...rows].sort((a,b) => [a.project_id,a.source,a.file_id,a.variant].join(":")
        .localeCompare([b.project_id,b.source,b.file_id,b.variant].join(":")));
    const calls: { sql: string; params: unknown[] }[] = [];
    return { calls, db: { query: async (sql: string, params: unknown[]) => {
        calls.push({sql,params});
        assert.match(sql, /^SELECT project_id,source,file_id,variant/);
        assert.doesNotMatch(sql,/\b(?:UPDATE|DELETE|INSERT|FOR UPDATE)\b/i);
        const [scope,pid,source,fid,variant,limit] = params as [string | null,string | null,string | null,string | null,string | null,number];
        assert.ok(limit >= 2 && limit <= 6);
        const cursor = pid ? [pid,source,fid,variant].join(":") : null;
        return { rows: sorted.filter(r => (!scope || r.project_id === scope) &&
            (!cursor || [r.project_id,r.source,r.file_id,r.variant].join(":") > cursor)).slice(0,limit) };
    } } as unknown as Pick<Pool,"query"> };
}
function store(values: Map<string, Buffer>, writes: string[] = []): BoundedCopyStore {
    return {
        async getBounded(key,maxBytes) {
            assert.equal(maxBytes,25 * 1024 * 1024);
            const value=values.get(key);
            if (!value) throw new ObjectNotFound();
            return Buffer.from(value);
        },
        async putIfAbsent(key,bytes,mimeType) {
            assert.match(mimeType,/^image\//);
            writes.push(key);
            if (values.has(key)) return false;
            values.set(key,Buffer.from(bytes));
            return true;
        },
    };
}

test("Strict versioned Project paths reject traversal, malformed variants and ambiguous keys", async () => {
    const id=randomUUID(), project=randomUUID();
    const original=projectStorageKey(project,id);
    const variant=projectStorageKey(project,id,"preview",2);
    assert.equal(original,`projects/${project}/objects/${id}/v1`);
    assert.equal(variant,`projects/${project}/objects/${id}/variants/preview/v2`);
    assert.equal(isProjectObjectKey(original),true);
    assert.equal(isProjectObjectKey(variant),true);
    assert.equal(isLegacyObjectKey("files-"+"a".repeat(32)+"-"+"b".repeat(64)),true);
    for (const key of [original+"/../v2",original.replace("v1","v0"),original.replace("v1","v01"),
        original.replace(project,"../"),original.replace(project,project.toUpperCase()),
        original.replace("/objects/","//objects/"),variant.replace("preview",".."),
        variant.replace("/preview/","/original/"),"projects/%2e%2e/objects/"+id+"/v1"]) {
        assert.equal(isProjectObjectKey(key),false,key);
    }
    assert.equal(projectStorageKey(project,id,"original"),original);
    for (const variant of ["../x","x/y","X","", "a".repeat(65)])
        assert.throws(()=>projectStorageKey(project,id,variant));
    assert.throws(()=>projectStorageKey(project,id,"preview",0));
    assert.throws(()=>projectStorageKey(project,id,"preview",1000000));
});

test("Local store round-trips slash keys as flat filenames, without following symlink leaves", async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),"project-keys-"));
    const store=new LocalObjectStore(root);
    const key=projectStorageKey(randomUUID(),randomUUID(),"thumbnail");
    const bytes=Buffer.from("safe data");
    try {
        await store.put(key,bytes,"image/webp");
        assert.deepEqual(await store.get(key),bytes);
        assert.deepEqual(await readdir(root),[key.replaceAll("/","%2F")]);
        const malicious=projectStorageKey(randomUUID(),randomUUID());
        const actual=path.join(root,"real");
        await writeFile(actual,bytes);
        await symlink(actual,path.join(root,malicious.replaceAll("/","%2F")));
        await assert.rejects(store.get(malicious));
        await assert.rejects(store.get("../../outside"),/Invalid Atlas media object key/);
        await store.delete(key);
        await assert.rejects(store.get(key),ObjectNotFound);
    } finally { await rm(root,{recursive:true,force:true}); }
});

test("Signed R2 requests preserve nested path segments and create-only conditional header", async () => {
    const key=projectStorageKey(randomUUID(),randomUUID(),"preview");
    const observed: {url:string;headers:Record<string,string>;method:string}[]=[];
    const remote=new R2ObjectStore({
        endpoint:"https://0123456789abcdef.r2.cloudflarestorage.com",
        bucket:"atlas-files",accessKeyId:"test-id",secretAccessKey:"test-secret",
    },(async (url: URL | RequestInfo, init?: RequestInit) => {
        observed.push({url:String(url),headers:init!.headers as Record<string,string>,method:init!.method!});
        return init?.method === "GET" ? new Response("abc",{status:200,headers:{"content-length":"3"}}) :
            new Response("",{status:200});
    }) as typeof fetch);
    assert.equal(await remote.putIfAbsent(key,Buffer.from("abc"),"image/webp"),true);
    assert.deepEqual(await remote.getBounded(key,25*1024*1024),Buffer.from("abc"));
    assert.equal(observed.length,2);
    assert.ok(observed.every(x=>x.url.endsWith("/atlas-files/"+key)));
    assert.equal(observed[0]!.headers["if-none-match"],"*");
    assert.match(observed[0]!.headers.authorization,/SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date/);
    assert.equal(observed[1]!.method,"GET");
    await assert.rejects(remote.getBounded("projects/../../secret",25*1024*1024),/Invalid Atlas media object key/);
});

test("CLI accepts bounded dry-run and explicitly scoped apply only", () => {
    assert.deepEqual(parseKeyCopyArgs([]),{apply:false,maxFiles:3});
    assert.deepEqual(parseKeyCopyArgs(["--dry-run","--max-files=5","--project="+projectId]),
        {apply:false,maxFiles:5,projectId});
    const token=encodeKeyCopyCursor({projectId,source:"atlas-file",fileId:randomUUID(),variant:"original"});
    assert.deepEqual(decodeKeyCopyCursor(token).projectId,projectId);
    assert.deepEqual(parseKeyCopyArgs(["--apply","--confirm="+PROJECT_KEY_COPY_CONFIRMATION,
        "--project="+projectId,"--cursor="+token]).apply,true);
    for (const args of [["--apply"],["--confirm="+PROJECT_KEY_COPY_CONFIRMATION],
        ["--apply","--project="+projectId],["--apply","--confirm=YES","--project="+projectId],
        ["--apply","--confirm="+PROJECT_KEY_COPY_CONFIRMATION],["--apply","--dry-run","--project="+projectId,
            "--confirm="+PROJECT_KEY_COPY_CONFIRMATION],["--dry-run","--dry-run"],["--max-files=6"],
        ["--max-files=1.5"],["--max-files=-1"],["--cursor=../../foo"],["--delete"],
        ["--project="+randomUUID(),"--cursor="+token]]) assert.throws(()=>parseKeyCopyArgs(args),args.join(" "));
    assert.throws(()=>decodeKeyCopyCursor("abc!"));
});

test("Dry-run covers archived Portfolio originals and checksum-less variants without writes", async () => {
    const original=Buffer.from("portfolio original"),preview=Buffer.from("actual derivative bytes");
    const id=randomUUID(),o=row(original,"portfolio-media","original",id);
    const v=row(preview,"portfolio-media","preview",id);v.status="archived";
    const map=new Map([[o.storage_key,original],[v.storage_key,preview]]);
    const writes:string[]=[];const input=database([o,v]);
    const result=await copyProjectKeys({database:input.db,source:store(map),
        destination:store(new Map(),writes)});
    assert.equal(result.status,"ready");
    assert.equal(result.checked,2);
    assert.equal(result.planned,2);
    assert.equal(result.writesAttempted,0);
    assert.deepEqual(writes,[]);
    assert.equal(result.remaining,false);
    assert.equal(input.calls.length,1);
});

test("Apply writes only absent verified copies, and rerun is idempotent", async () => {
    const bytes=Buffer.from("original bytes"),o=row(bytes,"atlas-file");
    const source=store(new Map([[o.storage_key,bytes]]));
    const destValues=new Map<string,Buffer>(), writes:string[]=[];
    const db=database([o]).db;
    const input={database:db,source,destination:store(destValues,writes),projectId,apply:true};
    const first=await copyProjectKeys(input);
    assert.equal(first.status,"completed");
    assert.equal(first.createdVerified,1);
    assert.equal(first.writesAttempted,1);
    assert.deepEqual(destValues.get(projectStorageKey(projectId,o.file_id)),bytes);
    const again=await copyProjectKeys(input);
    assert.equal(again.alreadyVerified,1);
    assert.equal(again.writesAttempted,0);
    assert.deepEqual(writes,[projectStorageKey(projectId,o.file_id)]);
});

test("Preflight rejects missing or corrupt sources, existing wrong destination, and invalid keys before any write", async () => {
    const firstBytes=Buffer.from("valid"),secondBytes=Buffer.from("missing");
    const a=row(firstBytes),b=row(secondBytes);
    const rows=[a,b].sort((x,y)=>x.file_id.localeCompare(y.file_id));
    const writes:string[]=[];
    const destination=store(new Map(),writes);
    const missing=await copyProjectKeys({database:database(rows).db,source:store(new Map([[a.storage_key,firstBytes]])),
        destination,projectId,apply:true});
    assert.equal(missing.status,"failed");
    assert.equal(writes.length,0,"even a valid first row cannot be written before full batch preflight");
    const bad=await copyProjectKeys({database:database([a]).db,
        source:store(new Map([[a.storage_key,Buffer.from("xxxxx")]])),destination,projectId,apply:true});
    assert.equal(bad.status,"failed");
    assert.equal(writes.length,0);
    const corrupted=new Map([[projectStorageKey(projectId,a.file_id),Buffer.from("wrong")]]);
    const clash=await copyProjectKeys({database:database([a]).db,
        source:store(new Map([[a.storage_key,firstBytes]])),destination:store(corrupted,writes),projectId,apply:true});
    assert.equal(clash.status,"failed");
    assert.equal(writes.length,0);
    const invalid={...a,storage_key:"projects/../../bad"};
    const key=await copyProjectKeys({database:database([invalid]).db,
        source:store(new Map()),destination,projectId,apply:true});
    assert.equal(key.status,"failed");
    assert.equal(writes.length,0);
});

test("Page cursor only advances after complete verification; ambiguous PUT is safe to retry", async () => {
    const a=row(Buffer.from("first")),b=row(Buffer.from("second"));
    const all=[a,b],sourceMap=new Map(all.map(r=>[r.storage_key,Buffer.from(r===a?"first":"second")]));
    const values=new Map<string,Buffer>();let first=true;
    const destination:BoundedCopyStore={
        ...store(values),
        async putIfAbsent(key,bytes) {
            if (first) { first=false;values.set(key,Buffer.from(bytes));throw new Error("ACK lost"); }
            if (values.has(key)) return false;
            values.set(key,Buffer.from(bytes));return true;
        },
    };
    const db=database(all).db,base={database:db,source:store(sourceMap),destination,projectId,apply:true,maxFiles:1};
    const failed=await copyProjectKeys(base);
    assert.equal(failed.status,"failed");
    assert.equal(failed.nextCursor,undefined);
    assert.equal(values.size,1);
    const retried=await copyProjectKeys(base);
    assert.equal(retried.status,"partial");
    assert.equal(retried.alreadyVerified,1);
    const continued=await copyProjectKeys({...base,cursor:retried.nextCursor});
    assert.equal(continued.status,"completed");
    assert.equal(continued.createdVerified,1);
    assert.equal(values.size,2);
});

test("Real PostgreSQL view provides a bounded ordered copy plan without DB mutations", async () => {
    const fixture=await databaseFixture();
    const root=await mkdtemp(path.join(os.tmpdir(),"project-copy-db-"));
    const files=new AtlasFilesService(fixture.databaseUrl,root);
    try {
        await files.pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Migration project',now(),now())",
            [projectId]);
        const bytes=Buffer.from("committed private bytes");
        const uploaded=await files.upload({owner:{kind:"project",id:projectId},fileName:"sample.bin",
            mimeType:"application/octet-stream",bytes});
        const output=await copyProjectKeys({database:files.pool,
            source:new LocalObjectStore(root),destination:store(new Map()),projectId,maxFiles:2});
        assert.equal(output.status,"ready");
        assert.equal(output.checked,1);
        assert.equal(output.planned,1);
        assert.equal(decodeKeyCopyCursor(output.nextCursor!).fileId,uploaded.id);
        assert.deepEqual((await files.list({kind:"project",id:projectId})).map(x=>x.id),[uploaded.id]);
        assert.deepEqual((await files.download({kind:"project",id:projectId},uploaded.id)).bytes,bytes);
    } finally {
        await files.close();
        await rm(root,{recursive:true,force:true});
    }
});

test("A competing conditional PUT winner is read back and verified rather than overwritten", async () => {
    const bytes=Buffer.from("race copy source"),entry=row(bytes,"atlas-file");
    const objects=new Map<string,Buffer>();
    let attempts=0;
    const remote:BoundedCopyStore={
        ...store(objects),
        async putIfAbsent(key,value) { attempts++;objects.set(key,Buffer.from(value));return false; },
    };
    const result=await copyProjectKeys({database:database([entry]).db,
        source:store(new Map([[entry.storage_key,bytes]])),destination:remote,projectId,apply:true});
    assert.equal(result.status,"completed");
    assert.equal(result.racedVerified,1);
    assert.equal(result.createdVerified,0);
    assert.equal(attempts,1);
    assert.deepEqual(objects.get(projectStorageKey(projectId,entry.file_id)),bytes);
});
