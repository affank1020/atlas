import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPortfolioConfig } from "../apps/server/src/server/config.js";
import {
    LocalMediaObjectStore, R2MediaObjectStore, R2WithLocalFallback, MediaObjectNotFound,
} from "../apps/server/src/portfolio/storage.js";

const key = "a".repeat(64) + ".png";
const config = {
    endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
    bucket: "atlas-files",
    accessKeyId: "example-access-key",
    secretAccessKey: "example-secret-key",
};

test("R2 PUT/GET use signed requests with the correct bucket path", async () => {
    const seen: { url: string; method: string; headers: Record<string,string> }[] = [];
    const remote = new R2MediaObjectStore(config, (async (url, init) => {
        seen.push({
            url: String(url),
            method: init!.method!,
            headers: init!.headers as Record<string, string>,
        });
        return init!.method === "GET" ?
            new Response(Buffer.from("abcde"), { status: 200 }) :
            new Response("", { status: 200 });
    }) as typeof fetch);
    await remote.put(key, Buffer.from("abcde"), "image/png");
    assert.equal((await remote.get(key)).toString(), "abcde");
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map(s => s.method), ["PUT", "GET"]);
    for (const item of seen) {
        assert.match(item.url, /r2\.cloudflarestorage\.com\/atlas-files\/a{64}\.png$/);
        assert.match(item.headers.authorization, /^AWS4-HMAC-SHA256 Credential=example-access-key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
        assert.match(item.headers["x-amz-date"], /^\d{8}T\d{6}Z$/);
        assert.equal(JSON.stringify(item).includes(config.secretAccessKey), false);
    }
});

test("R2 reads legacy local objects on 404 but sends new writes to R2", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-r2-"));
    let puts = 0;
    const remote = new R2MediaObjectStore(config, (async (_url, init) => {
        if (init!.method === "GET") return new Response(
            '<Error><Code>NoSuchKey</Code><Message>Missing object</Message></Error>',
            { status: 404, headers: { "content-type": "application/xml" } });
        puts++;
        return new Response("", { status: 200 });
    }) as typeof fetch);
    const local = new LocalMediaObjectStore(root);
    try {
        await local.put(key, Buffer.from("legacy"), "image/png");
        const storage = new R2WithLocalFallback(remote, local);
        assert.equal((await storage.get(key)).toString(), "legacy");
        await storage.put("b".repeat(64) + ".png", Buffer.from("new"), "image/png");
        assert.equal(puts, 1);
        await assert.rejects(storage.get("c".repeat(64) + ".png"), MediaObjectNotFound);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("R2 rejects unsafe keys and non-Cloudflare endpoints", async () => {
    const local = new LocalMediaObjectStore(os.tmpdir());
    await assert.rejects(local.get("../secret"), /Invalid Atlas media object key/);
    assert.throws(() => new R2MediaObjectStore({ ...config, endpoint: "http://127.0.0.1:9000" }), /Cloudflare R2 HTTPS/);
    assert.throws(() => new R2MediaObjectStore({ ...config, endpoint: "https://example.com" }), /Cloudflare R2 HTTPS/);
    assert.doesNotThrow(() => new R2MediaObjectStore({ ...config, endpoint: "https://0123456789abcdef.eu.r2.cloudflarestorage.com" }));
});

test("R2 activation is all-or-nothing; local remains default", () => {
    const disabled = loadPortfolioConfig({} as NodeJS.ProcessEnv);
    assert.equal(disabled.r2, null);
    assert.throws(() => loadPortfolioConfig({ ATLAS_R2_BUCKET: "atlas-files" } as NodeJS.ProcessEnv), /must all be set together/);
    const enabled = loadPortfolioConfig({
        ATLAS_R2_BUCKET: config.bucket,
        ATLAS_R2_ENDPOINT: config.endpoint,
        ATLAS_R2_ACCESS_KEY_ID: config.accessKeyId,
        ATLAS_R2_SECRET_ACCESS_KEY: config.secretAccessKey,
    } as NodeJS.ProcessEnv);
    assert.equal(enabled.r2?.bucket, "atlas-files");
});
