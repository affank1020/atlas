import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");
const pool = new pg.Pool({ connectionString: url });
const mode = process.argv[2] ?? "migrate";
const directory = path.join(process.cwd(), "migrations");
try {
  await pool.query("CREATE TABLE IF NOT EXISTS atlas_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = (await readdir(directory)).filter((x) => /^\d+.*\.sql$/.test(x)).sort();
  const applied = new Set((await pool.query("SELECT name FROM atlas_migrations")).rows.map((x) => x.name));
  if (mode === "status") {
    for (const file of files) console.log(`${applied.has(file) ? "applied" : "pending"} ${file}`);
  } else if (mode === "migrate") {
    for (const file of files) {
      if (applied.has(file)) continue;
      const client = await pool.connect();
      try { await client.query("BEGIN"); await client.query(await readFile(path.join(directory,file),"utf8")); await client.query("INSERT INTO atlas_migrations(name) VALUES($1)",[file]); await client.query("COMMIT"); console.log(`applied ${file}`); }
      catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
  } else throw new Error(`Unknown database command '${mode}'.`);
} finally { await pool.end(); }
