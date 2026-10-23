import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Pool } from "pg";
import { cleanupDatabases, databaseFixture } from "./database.js";

after(cleanupDatabases);

async function addProject(pool: Pool, name: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,$2,now(),now())",
        [id, name]);
    return id;
}

async function addFolder(pool: Pool, projectId: string, name: string, parentId: string | null = null): Promise<string> {
    const id = randomUUID();
    await pool.query(
        "INSERT INTO atlas_file_folders(id,project_id,parent_id,name,created_by) VALUES($1,$2,$3,$4,'test')",
        [id, projectId, parentId, name]);
    return id;
}

async function addFile(pool: Pool, kind: string, ownerId: string, folderId: string | null): Promise<string> {
    const id = randomUUID();
    const checksum = "a".repeat(64);
    const key = "files-" + id.replaceAll("-", "") + "-" + checksum;
    await pool.query(
        `INSERT INTO atlas_files
            (id,owner_kind,owner_id,folder_id,storage_key,checksum,file_name,mime_type,byte_size,created_by)
          VALUES($1,$2,$3,$4,$5,$6,'notes.txt','text/plain',3,'test')`,
        [id, kind, ownerId, folderId, key, checksum]);
    return id;
}

test("Project folders enforce nested scope, safe names and active sibling uniqueness", async () => {
    const { store } = await databaseFixture();
    const db = store.pool;
    const a = await addProject(db, "Folder project A");
    const b = await addProject(db, "Folder project B");
    const root = await addFolder(db, a, "Lecture Notes");
    const child = await addFolder(db, a, "Week 4", root);
    assert.equal((await db.query("SELECT parent_id FROM atlas_file_folders WHERE id=$1", [child])).rows[0]?.parent_id, root);

    // Root NULL-parent uniqueness must be handled separately from child uniqueness.
    await assert.rejects(addFolder(db, a, "lecture notes"), { code: "23505" });
    await assert.rejects(addFolder(db, a, "week 4", root), { code: "23505" });
    assert.ok(await addFolder(db, b, "Lecture Notes"));
    assert.ok(await addFolder(db, a, "Week 4")); // Different parent: Project root.

    for (const unsafe of [".", "..", " bad", "bad ", "bad/name", "bad\\name", "bad\nname"]) {
        await assert.rejects(addFolder(db, a, unsafe), { code: "23514" });
    }
    await assert.rejects(addFolder(db, b, "cross-project", root), { code: "23503" });
    await assert.rejects(db.query(
        "UPDATE atlas_file_folders SET parent_id=$1 WHERE id=$2", [child, root]),
    { code: "23514" });

    // A single multi-row INSERT can otherwise satisfy both self-FKs and form a cycle.
    const first = randomUUID(), second = randomUUID();
    await assert.rejects(db.query(
        `INSERT INTO atlas_file_folders(id,project_id,parent_id,name,created_by)
           VALUES($1,$3,$2,'Cycle 1','test'),($2,$3,$1,'Cycle 2','test')`,
        [first, second, a]),
    { code: "23514" });
});

test("Project file folder references reject cross-Project and legacy-owner scope escalation", async () => {
    const { store } = await databaseFixture();
    const db = store.pool;
    const a = await addProject(db, "File project A");
    const b = await addProject(db, "File project B");
    const folderA = await addFolder(db, a, "Documents");
    const folderB = await addFolder(db, b, "Documents");

    const id = await addFile(db, "project", a, folderA);
    await assert.rejects(addFile(db, "project", b, folderA), { code: "23514" });
    await assert.rejects(addFile(db, "project", a, folderB), { code: "23514" });
    await assert.rejects(addFile(db, "workspace", randomUUID(), folderA), { code: "23514" });
    await assert.rejects(addFile(db, "application", "portfolio", folderA), { code: "23514" });
    // Old records and their flat object keys continue to be valid.
    const legacy = await addFile(db, "application", "portfolio", null);
    assert.equal((await db.query("SELECT folder_id FROM atlas_files WHERE id=$1", [legacy])).rows[0]?.folder_id, null);

    await assert.rejects(db.query("UPDATE atlas_files SET owner_id=$1 WHERE id=$2", [b, id]), { code: "23514" });
    await assert.rejects(db.query("UPDATE atlas_files SET folder_id=$1 WHERE id=$2", [folderB, id]), { code: "23514" });
    const original = await db.query("SELECT owner_kind,owner_id,folder_id,storage_key FROM atlas_files WHERE id=$1", [id]);
    assert.equal(original.rows[0]?.owner_kind, "project");
    assert.equal(original.rows[0]?.owner_id, a);
    assert.equal(original.rows[0]?.folder_id, folderA);
    assert.match(original.rows[0]?.storage_key, /^files-[a-f0-9]{32}-a{64}$/);

    await db.query("UPDATE atlas_files SET status='archived' WHERE id=$1", [id]);
    const archived = await db.query("SELECT folder_id FROM atlas_files WHERE id=$1", [id]);
    assert.equal(archived.rows[0]?.folder_id, folderA);
    await assert.rejects(db.query("DELETE FROM atlas_file_folders WHERE id=$1", [folderA]), { code: "23503" });
});
