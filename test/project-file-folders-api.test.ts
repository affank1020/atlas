import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { AtlasFilesService } from "../apps/server/src/server/atlas-files.js";
import { serveFilesRequest } from "../apps/server/src/api/http/files.js";
import type { ServerServices } from "../apps/server/src/server/composition.js";
import { AtlasError } from "../apps/server/src/shared/errors.js";
import { cleanupDatabases, databaseFixture } from "./database.js";

after(cleanupDatabases);

test("Project folders isolate nested metadata, guard archival, and move Files without copying bytes", async () => {
    const fixture = await databaseFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-project-files-"));
    const files = new AtlasFilesService(fixture.databaseUrl, root);
    try {
        const a = randomUUID(), b = randomUUID();
        await files.pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Folder A',now(),now()),($2,'Folder B',now(),now())", [a, b]);
        const parent = await files.folders.create(a, null, "Coursework");
        const child = await files.folders.create(a, parent.id, "Week 4");
        await assert.rejects(files.folders.create(a, null, "coursework"), /already exists/);
        await assert.rejects(files.folders.create(b, parent.id, "Hijack"), /not found/);
        await assert.rejects(files.folders.create(a, parent.id, "../escape"), /name/);
        await assert.rejects(files.folders.rename(b, parent.id, "Other"), /not found/);
        assert.equal((await files.folders.list(b)).length, 0);
        const data = Buffer.from("folder content for integrity");
        const file = await files.upload({
            owner: { kind: "project", id: a }, folderId: child.id,
            fileName: "week.txt", mimeType: "text/plain", bytes: data,
        });
        assert.equal(file.folderId, child.id);
        assert.deepEqual((await files.list({ kind: "project", id: a }, "active", child.id)).map(f => f.id), [file.id]);
        assert.deepEqual(await files.list({ kind: "project", id: a }, "active", null), []);
        const original = await files.pool.query("SELECT storage_key FROM atlas_files WHERE id=$1", [file.id]);
        await assert.rejects(files.folders.archive(a, child.id), /Move or archive/);
        await assert.rejects(files.folders.archive(a, parent.id), /Move or archive/);
        await assert.rejects(files.folders.moveFile(b, file.id, null), /not found/);
        await assert.rejects(files.folders.moveFile(a, file.id, randomUUID()), /not found/);
        await files.folders.moveFile(a, file.id, null);
        assert.equal((await files.list({ kind: "project", id: a }, "active", null))[0]?.id, file.id);
        assert.equal((await files.pool.query("SELECT storage_key FROM atlas_files WHERE id=$1", [file.id])).rows[0]?.storage_key,
            original.rows[0]?.storage_key, "relocation is metadata-only");
        await files.folders.archive(a, child.id);
        await files.folders.archive(a, parent.id);
        await assert.rejects(files.folders.create(a, parent.id, "Week 5"), /not found/);
        await assert.rejects(files.folders.moveFile(a, file.id, child.id), /not found/);
        await assert.rejects(files.upload({
            owner: { kind: "project", id: a }, folderId: child.id,
            fileName: "bad.txt", mimeType: "text/plain", bytes: Buffer.from("new"),
        }), /not found/);
        await files.folders.restore(a, parent.id);
        const sibling = await files.folders.create(a, parent.id, "Week 4");
        await assert.rejects(files.folders.restore(a, child.id), /already exists/);
        await files.folders.rename(a, sibling.id, "Week 5");
        await files.folders.restore(a, child.id);
        await files.folders.moveFile(a, file.id, child.id);
        await files.archive({ kind: "project", id: a }, file.id);
        await files.folders.archive(a, child.id);
        await assert.rejects(files.restore({ kind: "project", id: a }, file.id), /Restore the containing/);
        await files.folders.restore(a, child.id);
        await files.restore({ kind: "project", id: a }, file.id);
        assert.deepEqual((await files.download({ kind: "project", id: a }, file.id)).bytes, data);
    } finally {
        await files.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("Project folder HTTP actions are scoped and legacy owner writes are denied", async () => {
    const fixture = await databaseFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-project-folder-http-"));
    const files = new AtlasFilesService(fixture.databaseUrl, root);
    const a = randomUUID(), b = randomUUID();
    const origin = "https://atlas.example.test";
    await files.pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Folder HTTP A',now(),now()),($2,'Folder HTTP B',now(),now())", [a, b]);
    const services = {
        files, config: { workspace: { origins: [origin] } },
        catalog: { getProject: async (id: string) => {
            if (id !== a && id !== b) throw new AtlasError("Project not found.", "NOT_FOUND");
            return { id };
        } },
        workspaces: { repository: { getById: async () => ({ status: "active" }) } },
        applications: { listAll: () => [{ slug: "portfolio" }] },
    } as unknown as ServerServices;
    const server = createServer((req, res) => { void serveFilesRequest(req, res, services); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (action: string, body: object, sentOrigin = origin) =>
        fetch(`${url}/api/files/${action}`, {
            method: "POST", headers: { "content-type": "application/json", origin: sentOrigin },
            body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
        });
    const owner = { kind: "project", id: a };
    const other = { kind: "project", id: b };
    try {
        assert.equal((await post("folders-create", { owner, parentId: null, name: "Private" }, "https://evil.example")).status, 403);
        const created = await post("folders-create", { owner, parentId: null, name: "Private" });
        assert.equal(created.status, 201);
        const folder = await created.json() as { id: string };
        assert.equal((await (await post("folders-list", { owner })).json() as unknown[]).length, 1);
        assert.equal((await post("folders-rename", { owner: other, folderId: folder.id, name: "Stolen" })).status, 404);
        assert.equal((await post("folders-create", { owner, parentId: randomUUID(), name: "Bad" })).status, 404);
        assert.equal((await post("folders-create", { owner, parentId: null, name: "../Bad" })).status, 400);
        assert.equal((await post("folders-list", { owner: { kind: "workspace", id: randomUUID() } })).status, 400);
        const bytes = Buffer.from("hello");
        const uploaded = await post("upload", { owner, folderId: folder.id, fileName: "hello.txt", mimeType: "text/plain", base64: bytes.toString("base64") });
        assert.equal(uploaded.status, 201);
        const file = await uploaded.json() as { id: string; folderId: string };
        assert.equal(file.folderId, folder.id);
        assert.equal((await (await post("list", { owner, folderId: folder.id })).json() as unknown[]).length, 1);
        assert.equal((await (await post("list", { owner, folderId: null })).json() as unknown[]).length, 0);
        assert.equal((await post("file-move", { owner: other, fileId: file.id, folderId: null })).status, 404);
        assert.equal((await post("file-move", { owner, fileId: file.id, folderId: null })).status, 200);
        assert.equal((await post("folders-archive", { owner, folderId: folder.id })).status, 200);
        assert.equal((await post("folders-restore", { owner, folderId: folder.id })).status, 200);
        // Old web clients can still manage legacy owner Files until the UI migration.
        const legacyOwner = { kind: "application", id: "portfolio" };
        const legacyUpload = await post("upload", { owner: legacyOwner,
            fileName: "legacy.txt", mimeType: "text/plain", base64: bytes.toString("base64") });
        assert.equal(legacyUpload.status, 201);
        const legacyFile = await legacyUpload.json() as { id: string };
        assert.equal((await post("folders-list", { owner: legacyOwner })).status, 400);
        assert.equal((await post("upload", { owner: legacyOwner, folderId: folder.id,
            fileName: "illegal.txt", mimeType: "text/plain", base64: bytes.toString("base64") })).status, 400);
        assert.equal((await post("archive", { owner: legacyOwner, fileId: legacyFile.id })).status, 200);
        assert.equal((await post("restore", { owner: legacyOwner, fileId: legacyFile.id })).status, 200);
        assert.deepEqual(Buffer.from(await (await post("download", { owner, fileId: file.id })).arrayBuffer()), bytes);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await files.close();
        await rm(root, { recursive: true, force: true });
    }
});
