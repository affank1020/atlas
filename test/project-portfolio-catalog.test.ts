import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { PortfolioMediaService, PORTFOLIO_PROJECT_ID } from "../apps/server/src/portfolio/index.js";
import { AtlasFilesService } from "../apps/server/src/server/atlas-files.js";
import { serveFilesRequest } from "../apps/server/src/api/http/files.js";
import type { ServerServices } from "../apps/server/src/server/composition.js";
import { AtlasError } from "../apps/server/src/shared/errors.js";
import { cleanupDatabases, databaseFixture } from "./database.js";

after(cleanupDatabases);

test("Project catalogue projects historic and new Portfolio originals/variants without touching source metadata or bytes", async () => {
    const fixture = await databaseFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-portfolio-catalog-"));
    const files = new AtlasFilesService(fixture.databaseUrl, root);
    const media = new PortfolioMediaService(fixture.databaseUrl, root);
    try {
        const otherProject = randomUUID();
        await files.pool.query(
            "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Portfolio',now(),now()),($2,'Unrelated',now(),now())",
            [PORTFOLIO_PROJECT_ID, otherProject],
        );
        const original = await sharp({ create: { width: 8, height: 7, channels: 4,
            background: { r: 15, g: 30, b: 70, alpha: 1 } } }).png().toBuffer();
        const uploaded = await media.upload({
            fileName: "Hero.png", mimeType: "image/png", base64: original.toString("base64"),
            altText: "Hero artwork", client: "catalog-test",
        });
        const storedBefore = await files.pool.query(
            "SELECT id,checksum,storage_key,original_name,status FROM media_assets WHERE id=$1", [uploaded.id]);
        const variantsBefore = await files.pool.query(
            "SELECT name,storage_key,mime_type,byte_size FROM media_variants WHERE asset_id=$1 ORDER BY name", [uploaded.id]);
        const legacyBytes = await media.file(uploaded.id, "preview");

        const projected = await files.portfolioCatalog(PORTFOLIO_PROJECT_ID);
        assert.equal(projected.length, 1);
        assert.equal(projected[0]?.id, uploaded.id);
        assert.equal(projected[0]?.projectId, PORTFOLIO_PROJECT_ID);
        assert.equal(projected[0]?.fileName, "Hero.png");
        assert.equal(projected[0]?.checksum, createHash("sha256").update(original).digest("hex"));
        assert.equal(projected[0]?.url, `/api/media/${uploaded.id}/original`);
        assert.deepEqual(projected[0]?.variants.map(variant => variant.name), ["preview", "thumbnail"]);
        assert.equal(await files.portfolioCatalog(otherProject).then(rows => rows.length), 0);
        const native = await files.upload({
            owner: { kind: "project", id: PORTFOLIO_PROJECT_ID }, fileName: "private.txt",
            mimeType: "text/plain", bytes: Buffer.from("private"),
        });
        const unified = await files.pool.query(
            `SELECT source,file_id,variant,storage_key,checksum,byte_size FROM atlas_project_storage_objects
              WHERE project_id=$1 ORDER BY source,file_id,variant`, [PORTFOLIO_PROJECT_ID]);
        assert.equal(unified.rows.length, 4);
        assert.equal(unified.rows.filter(row => row.source === "portfolio-media").length, 3);
        assert.equal(unified.rows.filter(row => row.source === "atlas-file").length, 1);
        assert.equal(unified.rows.find(row => row.source === "atlas-file")?.file_id, native.id);
        assert.deepEqual(unified.rows.filter(row => row.source === "portfolio-media" && row.variant !== "original")
            .map(row => row.checksum), [null, null], "variant checksums must not be invented");

        // Archival and new uploads are reflected automatically without any
        // backfill, INSERT into atlas_files, or migration of existing object keys.
        await media.update(uploaded.id, { status: "archived" });
        const archived = (await files.portfolioCatalog(PORTFOLIO_PROJECT_ID))[0]!;
        assert.equal(archived.status, "archived");
        assert.equal(archived.url, null);
        await assert.rejects(media.file(uploaded.id, "original"), /not found/);
        await media.update(uploaded.id, { status: "active" });
        assert.deepEqual((await media.file(uploaded.id, "preview")).bytes, legacyBytes.bytes);
        const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
        const next = await media.upload({ fileName: "CV.pdf", mimeType: "application/pdf", base64: pdf.toString("base64") });
        assert.deepEqual((await files.portfolioCatalog(PORTFOLIO_PROJECT_ID)).map(row => row.id).sort(),
            [uploaded.id, next.id].sort());
        assert.deepEqual((await files.pool.query(
            "SELECT id,checksum,storage_key,original_name,status FROM media_assets WHERE id=$1", [uploaded.id])).rows,
            storedBefore.rows);
        assert.deepEqual((await files.pool.query(
            "SELECT name,storage_key,mime_type,byte_size FROM media_variants WHERE asset_id=$1 ORDER BY name",
            [uploaded.id])).rows, variantsBefore.rows);
    } finally {
        await Promise.all([files.close(), media.close()]);
        await rm(root, { recursive: true, force: true });
    }
});

test("Private Files HTTP exposes Portfolio projection only under its authorised Project", async () => {
    const fixture = await databaseFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-portfolio-http-"));
    const files = new AtlasFilesService(fixture.databaseUrl, root);
    await files.pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Portfolio',now(),now())",
        [PORTFOLIO_PROJECT_ID]);
    const allowed = "https://atlas.example.test";
    const services = {
        config: { workspace: { origins: [allowed] } }, files,
        catalog: { getProject: async (id: string) => {
            if (id !== PORTFOLIO_PROJECT_ID) throw new AtlasError("Project not found.", "NOT_FOUND");
            return { id };
        } },
        workspaces: { repository: { getById: async () => ({ status: "active" }) } },
        applications: { listAll: () => [{ slug: "portfolio" }] },
    } as unknown as ServerServices;
    const server = createServer((request, response) => { void serveFilesRequest(request, response, services); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (owner: object, origin = allowed) => fetch(`${base}/api/files/portfolio-catalog`, {
        method: "POST", headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ owner }), signal: AbortSignal.timeout(5000),
    });
    try {
        const owner = { kind: "project", id: PORTFOLIO_PROJECT_ID };
        assert.equal((await post(owner, "https://unauthorised.example")).status, 403);
        const response = await post(owner);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), []);
        assert.equal((await post({ kind: "application", id: "portfolio" })).status, 400);
        assert.equal((await post({ kind: "project", id: randomUUID() })).status, 404);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await files.close();
        await rm(root, { recursive: true, force: true });
    }
});
