import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AtlasFilesService } from "../apps/server/src/server/atlas-files.js";
import { LocalObjectStore, R2ObjectStore } from "../apps/server/src/server/file-storage.js";
import { databaseFixture, cleanupDatabases } from "./database.js";

after(cleanupDatabases);

const portfolio = { kind: "application", id: "portfolio" } as const;
const otherApp = { kind: "application", id: "other-app" } as const;

test("Shared Atlas Files default to private and isolate owner-scoped reads, listings and archives", async () => {
    const fixture = await databaseFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-files-"));
    const files = new AtlasFilesService(fixture.databaseUrl, root);
    try {
        const saved = await files.upload({
            owner: portfolio, fileName: "notes.txt", mimeType: "text/plain",
            bytes: Buffer.from("Test artifact"), client: "test-suite",
        });
        assert.equal(saved.visibility, "private");
        assert.equal(saved.owner.id, "portfolio");
        assert.equal(saved.byteSize, 13);
        assert.equal((await files.download(portfolio, saved.id)).bytes.toString(), "Test artifact");
        assert.deepEqual((await files.list(portfolio)).map(file => file.id), [saved.id]);
        assert.deepEqual(await files.list(otherApp), []);
        await assert.rejects(files.metadata(otherApp, saved.id), /not found/);
        await assert.rejects(files.download(otherApp, saved.id), /not found/);
        await assert.rejects(files.archive(otherApp, saved.id), /not found/);
        await files.archive(portfolio, saved.id);
        assert.deepEqual(await files.list(portfolio), []);
        assert.deepEqual((await files.list(portfolio, "archived")).map(file => file.id), [saved.id]);
        assert.deepEqual(await files.list(otherApp, "archived"), []);
        await assert.rejects(files.download(portfolio, saved.id), /not found/);
        await assert.rejects(files.restore(otherApp, saved.id), /not found/);
        await assert.rejects(files.restore(portfolio, randomUUID()), /not found/);
        const restored = await files.restore(portfolio, saved.id);
        assert.equal(restored.status, "active");
        assert.deepEqual((await files.list(portfolio)).map(file => file.id), [saved.id]);
        assert.deepEqual(await files.list(portfolio, "archived"), []);
        assert.equal((await files.download(portfolio, saved.id)).bytes.toString(), "Test artifact");
        await assert.rejects(files.restore(portfolio, saved.id), /not found/);
        await files.archive(portfolio, saved.id);
        await assert.rejects(files.list(portfolio, "active' OR 1=1 --" as "active"), /status/);
    } finally {
        await files.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("Shared Atlas Files reject unsafe metadata and cannot use arbitrary object keys", async () => {
    const fixture = await databaseFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-files-validation-"));
    const files = new AtlasFilesService(fixture.databaseUrl, root);
    try {
        const base = { owner: portfolio, fileName: "safe.txt", mimeType: "text/plain", bytes: Buffer.from("ok") };
        await assert.rejects(files.upload({ ...base, owner: { kind: "application", id: "../private" } }), /ownership scope/);
        await assert.rejects(files.upload({ ...base, fileName: "../secrets.txt" }), /file name/);
        await assert.rejects(files.upload({ ...base, visibility: "everyone" as "private" }), /visibility/);
        await assert.rejects(files.upload({ ...base, bytes: Buffer.alloc(0) }), /nonempty buffers/);
        const objects = new LocalObjectStore(root);
        await assert.rejects(objects.get("../../secret"), /Invalid Atlas media object key/);
        const file = await files.upload({ ...base, visibility: "public" });
        assert.equal(file.visibility, "public");
        // Visibility is metadata only in PR1; there is no public file-serving route.
        assert.equal((await files.download(portfolio, file.id)).bytes.toString(), "ok");
    } finally {
        await files.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("Downloads reject corrupted or truncated local objects before returning bytes", async () => {
    const fixture = await databaseFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-files-integrity-"));
    const files = new AtlasFilesService(fixture.databaseUrl, root);
    try {
        const original = Buffer.from("Hello Atlas Files");
        const saved = await files.upload({ owner: portfolio, fileName: "screenshot.png",
            mimeType: "image/png", bytes: original });
        const row = await files.pool.query("SELECT storage_key FROM atlas_files WHERE id=$1", [saved.id]);
        const objectPath = path.join(root, String(row.rows[0]!.storage_key));
        await writeFile(objectPath, Buffer.from("hello Atlas Files")); // Same size, different hash.
        await assert.rejects(files.download(portfolio, saved.id), /integrity verification failed/);
        await writeFile(objectPath, Buffer.from("truncated"));
        await assert.rejects(files.download(portfolio, saved.id), /integrity verification failed/);
        await files.archive(portfolio, saved.id);
        await assert.rejects(files.restore(portfolio, saved.id), /integrity verification failed/,
            "corrupt archived bytes cannot become active again");
        await writeFile(objectPath, original);
        await files.restore(portfolio, saved.id);
        assert.deepEqual((await files.download(portfolio, saved.id)).bytes, original);
    } finally {
        await files.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("Shared R2 object adapter accepts opaque server-generated Files keys", async () => {
    let observedUrl = "";
    const store = new R2ObjectStore({
        endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
        bucket: "atlas-files", accessKeyId: "test-id", secretAccessKey: "test-secret",
    }, (async (url) => {
        observedUrl = String(url);
        return new Response("", { status: 200 });
    }) as typeof fetch);
    await store.put("files-" + "a".repeat(32) + "-" + "b".repeat(64), Buffer.from("abc"), "text/plain");
    assert.match(observedUrl, /\/atlas-files\/files-a{32}-b{64}$/);
});
