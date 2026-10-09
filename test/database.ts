import { randomUUID } from "node:crypto";
import { readFile,readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { AtlasCatalog } from "../apps/server/src/catalog.js";
import { AtlasStore } from "../apps/server/src/store.js";

// Default to the disposable local PostgreSQL container in infra/docker-compose.yml.
// CI and other environments can override this using TEST_DATABASE_URL or DATABASE_URL.
const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://atlas:atlas@127.0.0.1:5432/atlas";
const schemas: string[] = [];
const stores: AtlasStore[] = [];
export async function databaseFixture(throughMigration?: string) {
    const schema = `atlas_test_${randomUUID().replaceAll("-", "")}`; schemas.push(schema);
    const admin = new Pool({ connectionString: baseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const client = await admin.connect();
    try { await client.query(`SET search_path TO ${schema},public`); for(const file of (await readdir(path.join(process.cwd(),"apps/server/migrations"))).filter((x)=>x.endsWith(".sql") && (!throughMigration || x <= throughMigration)).sort()) await client.query(await readFile(path.join(process.cwd(),"apps/server/migrations",file),"utf8")); } finally { client.release(); await admin.end(); }
    const url = new URL(baseUrl); url.searchParams.set("options", `-csearch_path=${schema}`);
    const store = new AtlasStore(url.toString()); stores.push(store);
    return { catalog: new AtlasCatalog(store), store, databaseUrl: url.toString() };
}
export async function cleanupDatabases() { await Promise.all(stores.map((store)=>store.close().catch(()=>undefined))); const admin=new Pool({connectionString:baseUrl}); try { for(const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); } }
