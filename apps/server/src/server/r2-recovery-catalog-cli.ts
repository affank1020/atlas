import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';
import { loadPortfolioConfig, requireDatabaseUrl } from './config.js';
import { LocalObjectStore, R2ObjectStore } from './file-storage.js';
import { createR2SeedPrimarySource } from './r2-backup-seeding.js';
import {
    loadRecoveryR2Config, parseRecoveryCatalogArgs, verifyR2RecoveryCatalog,
} from './r2-recovery-verification.js';

// Operator-only, SELECT + bounded R2 GET verification. No HTTP/MCP route,
// object mutation or scheduler. One catalog statement snapshot, one report.
loadEnv({ path: 'apps/server/.env', quiet: true });
let pool: Pool | undefined;
try {
    const args = parseRecoveryCatalogArgs(process.argv.slice(2));
    const files = loadPortfolioConfig();
    const primary = files.r2;
    const backup = loadRecoveryR2Config(process.env, primary);
    // Match live Atlas Files/seeder read precedence. A confirmed NoSuchKey
    // alone may fall back to the bounded legacy local object. The verifier
    // reports the number of *checksum-verified* local fallback objects.
    const source = createR2SeedPrimarySource(
        new R2ObjectStore(primary!), new LocalObjectStore(files.mediaRoot));
    pool = new Pool({ connectionString: requireDatabaseUrl(), connectionTimeoutMillis: 5000 });
    const result = await verifyR2RecoveryCatalog({
        database: pool, primary: source,
        backup: new R2ObjectStore(backup), ...args,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'passed') process.exitCode = 2;
} catch {
    // Raw errors can contain sensitive DB URLs, signed headers or endpoints.
    console.error('Atlas Files recovery catalog verification failed or was inconclusive; no storage changes were made.');
    process.exitCode = 1;
} finally {
    await pool?.end();
}
