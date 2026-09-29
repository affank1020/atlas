import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { AtlasCatalog } from "../src/catalog.js";
import { AtlasStore } from "../src/store.js";

const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://localhost/postgres";
const schemas: string[] = [];
const stores: AtlasStore[] = [];
export async function databaseFixture() {
    const schema = `atlas_test_${randomUUID().replaceAll("-", "")}`; schemas.push(schema);
    const admin = new Pool({ connectionString: baseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const sql = await readFile(path.join(process.cwd(), "migrations", "001_initial.sql"), "utf8");
    const client = await admin.connect();
    try { await client.query(`SET search_path TO ${schema}`); await client.query(sql); } finally { client.release(); await admin.end(); }
    const url = new URL(baseUrl); url.searchParams.set("options", `-csearch_path=${schema}`);
    const store = new AtlasStore(url.toString()); stores.push(store);
    return { catalog: new AtlasCatalog(store), store, databaseUrl: url.toString() };
}
export async function cleanupDatabases() { await Promise.all(stores.map((store)=>store.close().catch(()=>undefined))); const admin=new Pool({connectionString:baseUrl}); try { for(const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); } }
