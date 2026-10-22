import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    BackupError, parseArgs, readSnapshot, recoveryConfig, publishSnapshot,
    R2BackupStore, run, MAX_ARCHIVE_BYTES,
} from "../scripts/postgres-offsite-r2.mjs";

function fixture(t: import("node:test").TestContext) {
    const dir = mkdtempSync(path.join(tmpdir(), "atlas-pg-offsite-"));
    t.after(() => rmSync(dir, { recursive:true, force:true }));
    const archive = path.join(dir, "snapshot.dump.age");
    const ciphertext = Buffer.from("age-encryption.org/v1\n" + "x".repeat(1024));
    const sha = createHash("sha256").update(ciphertext).digest("hex");
    const manifest = {
        schemaVersion:1,kind:"postgres-custom-age",database:"atlas_import",
        createdAt:"2026-10-22T12:00:00Z",bytes:ciphertext.length,
        ciphertextSha256:sha,verifiedRestore:false,
    };
    writeFileSync(archive,ciphertext,{mode:0o600});
    writeFileSync(archive+".json",JSON.stringify(manifest),{mode:0o600});
    return {dir,archive,ciphertext,sha,manifest};
}

const primary="https://11111111111111111111111111111111.r2.cloudflarestorage.com";
const recovery="https://22222222222222222222222222222222.r2.cloudflarestorage.com";
const environment = {
    ATLAS_R2_ENDPOINT:primary,
    ATLAS_R2_RECOVERY_ENDPOINT:recovery,
    ATLAS_R2_RECOVERY_BUCKET:"atlas-independent-db",
    ATLAS_R2_RECOVERY_ACCESS_KEY_ID:"recovery-id",
    ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY:"recovery-secret",
    ATLAS_R2_ACCESS_KEY_ID:"primary-id",
    ATLAS_R2_SECRET_ACCESS_KEY:"primary-secret",
};

class MemoryStore {
    objects=new Map<string,Buffer>();
    gets:string[]=[];
    puts:string[]=[];
    race=false;
    omitCommittedRead=false;
    async get(key:string,limit:number) {
        this.gets.push(key);
        if(this.omitCommittedRead && this.puts.includes(key)) return null;
        const bytes=this.objects.get(key);
        if(!bytes) return null;
        if(bytes.length>limit) throw new BackupError("remote object over limit");
        return Buffer.from(bytes);
    }
    async putIfAbsent(key:string,bytes:Buffer) {
        this.puts.push(key);
        if(this.objects.has(key)) return false;
        this.objects.set(key,Buffer.from(bytes));
        return !this.race;
    }
}

test("default dry-run verifies local ciphertext with no network or credentials",async t=>{
    const f=fixture(t);
    const result=await run(["--archive="+f.archive],{},()=>{throw Error("no network allowed")});
    assert.equal(result.mode,"dry-run");
    assert.equal(result.status,"local-verified");
    assert.equal(result.remoteChecked,false);
    assert.equal(result.ciphertextSha256,f.sha);
});

test("CLI modes are exclusive and apply requires the literal confirmation",()=>{
    assert.equal(parseArgs(["--archive=/safe/a.dump.age"]).mode,"dry-run");
    assert.equal(parseArgs(["--archive=/safe/a.dump.age","--verify"]).mode,"verify");
    assert.equal(parseArgs(["--archive=/safe/a.dump.age","--apply","--confirm=PUBLISH_PG_OFFSITE"]).mode,"apply");
    for(const args of [
        ["--archive=/safe/a.dump.age","--apply"],
        ["--archive=/safe/a.dump.age","--verify","--confirm=PUBLISH_PG_OFFSITE"],
        ["--archive=/safe/a.dump.age","--apply","--dry-run","--confirm=PUBLISH_PG_OFFSITE"],
        ["--archive=relative.dump.age"],["--archive=/safe/a.dump.age","--confirm=WRONG"],
        ["--archive=/safe/a.dump.age","--archive=/safe/b.dump.age"],
    ]) assert.throws(()=>parseArgs(args),BackupError);
});

test("rejects tampering, unsafe permissions, malicious metadata and symlink",async t=>{
    const f=fixture(t);
    const bad=Buffer.alloc(f.ciphertext.length,0);
    writeFileSync(f.archive,bad);
    await assert.rejects(readSnapshot(f.archive),/SHA-256/);
    writeFileSync(f.archive,f.ciphertext);
    chmodSync(f.archive,0o644);
    await assert.rejects(readSnapshot(f.archive),/private/);
    chmodSync(f.archive,0o600);
    const linked=path.join(f.dir,"linked.dump.age");
    symlinkSync(f.archive,linked);
    await assert.rejects(readSnapshot(linked),BackupError);
    writeFileSync(f.archive+".json",JSON.stringify({...f.manifest,database:"../../bad"}));
    await assert.rejects(readSnapshot(f.archive),/schema/);
    assert.ok(MAX_ARCHIVE_BYTES > f.ciphertext.length);
});

test("offsite configuration enforces a different Cloudflare account and credentials",()=>{
    assert.equal(recoveryConfig(environment).bucket,"atlas-independent-db");
    assert.throws(()=>recoveryConfig({...environment,ATLAS_R2_RECOVERY_ENDPOINT:primary}),/separate Cloudflare account/);
    assert.throws(()=>recoveryConfig({...environment,
        ATLAS_R2_RECOVERY_ENDPOINT:"https://11111111111111111111111111111111.eu.r2.cloudflarestorage.com"}),/separate Cloudflare account/);
    assert.throws(()=>recoveryConfig({...environment,ATLAS_R2_RECOVERY_BUCKET:""}),/bucket/);
    assert.throws(()=>recoveryConfig({...environment,ATLAS_R2_RECOVERY_ACCESS_KEY_ID:"primary-id"}),/reuse/);
    assert.throws(()=>recoveryConfig({...environment,ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY:"primary-secret"}),/reuse/);
    assert.throws(()=>recoveryConfig({...environment,ATLAS_R2_RECOVERY_ENDPOINT:"http://evil.example"}),/endpoint/);
});

test("apply creates ciphertext first and manifest last; re-reads both and is idempotent",async t=>{
    const f=fixture(t), s=new MemoryStore();
    const configRun=()=>run(["--archive="+f.archive,"--apply","--confirm=PUBLISH_PG_OFFSITE"],environment,()=>s);
    const result=await configRun();
    assert.equal(result.status,"verified");
    assert.equal(result.createdObjects,2);
    assert.equal(s.puts.length,2);
    assert.ok(s.puts[0]!.endsWith(".dump.age"));
    assert.ok(s.puts[1]!.endsWith(".dump.age.json"));
    assert.equal(s.gets.filter(x=>x===result.archiveKey).length,2);
    assert.equal(s.gets.filter(x=>x===result.manifestKey).length,2);
    assert.equal((await configRun()).createdObjects,0);
    assert.equal((await run(["--archive="+f.archive,"--verify"],environment,()=>s)).status,"verified");
    assert.equal(s.puts.length,2);
});

test("verify does not upload and refuses missing objects",async t=>{
    const f=fixture(t),s=new MemoryStore();
    await assert.rejects(run(["--archive="+f.archive,"--verify"],environment,()=>s),/incomplete/);
    assert.equal(s.puts.length,0);
});

test("existing corrupt archive or manifest is never replaced",async t=>{
    const f=fixture(t),snap=await readSnapshot(f.archive),s=new MemoryStore();
    s.objects.set(snap.archiveKey,Buffer.from("corrupted"));
    await assert.rejects(publishSnapshot(snap,s,"apply"),/ciphertext differs/);
    assert.equal(s.puts.length,0);
    s.objects.set(snap.archiveKey,Buffer.from(snap.ciphertext));
    s.objects.set(snap.manifestKey,Buffer.from("different"));
    await assert.rejects(publishSnapshot(snap,s,"apply"),/manifest differs/);
    assert.equal(s.puts.length,0);
});

test("pre-existing manifest without ciphertext requires manual investigation",async t=>{
    const f=fixture(t),snap=await readSnapshot(f.archive),s=new MemoryStore();
    s.objects.set(snap.manifestKey,snap.metadata);
    await assert.rejects(publishSnapshot(snap,s,"apply"),/manifest exists but ciphertext is missing/);
    assert.equal(s.puts.length,0);
});

test("atomic PUT race must be reconciled by a matching readback",async t=>{
    const f=fixture(t),snap=await readSnapshot(f.archive),s=new MemoryStore();
    s.race=true;
    const result=await publishSnapshot(snap,s,"apply");
    assert.equal(result.status,"verified");
    assert.equal(result.createdObjects,0);
    const second=new MemoryStore();
    second.omitCommittedRead=true;
    await assert.rejects(publishSnapshot(snap,second,"apply"),/could not be verified/);
    assert.equal(second.puts.length,1);
});

test("S3 signer uses the conditional header and validates confirmation of absent keys",async()=>{
    const requests:any[]=[];
    const config=recoveryConfig(environment);
    const store=new R2BackupStore(config,async (url:URL,init:RequestInit)=>{
        requests.push({url:String(url),init});
        if(init.method==="PUT") return new Response("",{status:200});
        return new Response("<Error><Code>NoSuchKey</Code></Error>",{status:404});
    });
    assert.equal(await store.get("postgres-backups/v1/test.dump.age",1024),null);
    assert.equal(await store.putIfAbsent("postgres-backups/v1/test.dump.age",Buffer.from("test")),true);
    assert.match(requests[0].url,/\/atlas-independent-db\/postgres-backups\/v1\/test.dump.age$/);
    assert.equal((requests[1].init.headers as Record<string,string>)["if-none-match"],"*");
    assert.match((requests[1].init.headers as Record<string,string>).authorization,/SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date/);
});

test("R2 HTTP 404 NoSuchBucket is an error, not permission to upload",async()=>{
    const config=recoveryConfig(environment);
    const store=new R2BackupStore(config,async()=>new Response("<Error><Code>NoSuchBucket</Code></Error>",{status:404}));
    await assert.rejects(store.get("postgres-backups/v1/test.dump.age",1024),/without confirming NoSuchKey/);
});

test("R2 412 returns false; malformed or oversized GET fails closed",async()=>{
    const config=recoveryConfig(environment);
    const precondition=new R2BackupStore(config,async()=>new Response("",{status:412}));
    assert.equal(await precondition.putIfAbsent("postgres-backups/v1/test.dump.age",Buffer.from("x")),false);
    const oversize=new R2BackupStore(config,async()=>new Response(Buffer.alloc(20),{status:200}));
    await assert.rejects(oversize.get("postgres-backups/v1/test.dump.age",10),/byte budget/);
});
