import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { recordR2SeedObservation } from './operational-audit.js';
import { Pool } from 'pg';
import { loadPortfolioConfig, requireDatabaseUrl } from './config.js';
import { LocalObjectStore, R2ObjectStore } from './file-storage.js';
import { loadRecoveryR2Config } from './r2-recovery-verification.js';
import { createR2SeedPrimarySource, parseR2SeedArgs, seedR2Backup } from './r2-backup-seeding.js';

// Manual operator-only command. No HTTP/MCP entry point and no scheduler.
// Defaults to dry-run. --apply requires a separate exact confirmation token.
loadEnv({ path: 'apps/server/.env', quiet: true });
let pool: Pool | undefined;
try {
    const args = parseR2SeedArgs(process.argv.slice(2));
    const primaryStorage = loadPortfolioConfig();
    const primaryConfig = primaryStorage.r2;
    const recoveryConfig = loadRecoveryR2Config(process.env, primaryConfig);
    pool = new Pool({ connectionString: requireDatabaseUrl(), connectionTimeoutMillis: 5000 });
    const report = await seedR2Backup({
        database: pool, primary: createR2SeedPrimarySource(
            new R2ObjectStore(primaryConfig!), new LocalObjectStore(primaryStorage.mediaRoot)),
        backup: new R2ObjectStore(recoveryConfig), ...args,
    });
    // R2 writes and PostgreSQL audit cannot commit atomically. Record only
    // a bounded observation, and surface audit failure without asserting that
    // any already-completed copy was rolled back.
    const runId = randomUUID();
    console.log(JSON.stringify({ runId, ...report }, null, 2));
    try {
        await recordR2SeedObservation(pool, runId, report);
    } catch {
        console.error('R2 seed outcome recorded by CLI but Monitoring audit unavailable; copies may exist. Check recovery storage before retrying.');
        process.exitCode = 3;
    }
    if ((report.status === 'failed' || report.status === 'empty') && process.exitCode !== 3) process.exitCode = 2;
} catch {
    // Raw exceptions can contain endpoints, credentials, signed headers or
    // private metadata. Do not print them to CLI logs.
    console.error('Atlas Files R2 backup seeding aborted or inconclusive; inspect storage and credentials before retrying.');
    process.exitCode = 1;
} finally {
    await pool?.end();
}
