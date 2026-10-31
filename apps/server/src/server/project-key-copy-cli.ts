import { config as loadEnv } from "dotenv";
import { Pool } from "pg";
import { loadPortfolioConfig, requireDatabaseUrl } from "./config.js";
import { LocalObjectStore, R2ObjectStore } from "./file-storage.js";
import { createR2SeedPrimarySource } from "./r2-backup-seeding.js";
import { copyProjectKeys, parseKeyCopyArgs } from "./project-key-migration.js";

// Operator-only. No HTTP or MCP route, no scheduler, no automatic cutover.
// Dry-run is the default. Apply requires scoped confirmation AND a separate
// default-off environment gate. Source objects and all DB rows are retained.
loadEnv({ path: "apps/server/.env", quiet: true });
let pool: Pool | undefined;
try {
    const options = parseKeyCopyArgs(process.argv.slice(2));
    if (options.apply && process.env.ATLAS_PROJECT_KEY_COPY_ENABLED !== "1")
        throw new Error("Explicit Project key copy environment gate is disabled.");
    const config = loadPortfolioConfig();
    if (!config.r2) throw new Error("Primary R2 is not configured.");
    const remote = new R2ObjectStore(config.r2);
    const source = createR2SeedPrimarySource(remote, new LocalObjectStore(config.mediaRoot));
    pool = new Pool({ connectionString: requireDatabaseUrl(), connectionTimeoutMillis: 5000 });
    const report = await copyProjectKeys({ database: pool, source, destination: remote, ...options });
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "failed" || report.status === "empty") process.exitCode = 2;
} catch {
    // Never print raw network, SQL or credential errors.
    console.error("Project key copy failed or was inconclusive; no source objects or database rows were deleted. Check the destination before retrying.");
    process.exitCode = 1;
} finally {
    await pool?.end();
}
