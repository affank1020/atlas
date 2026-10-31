import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { runObservedR2Seed } from './operational-audit.js';
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
    // Allocate an ID before the first R2 read or PUT. A thrown operation may
    // have written externally before its acknowledgement failed, so both
    // successes and aborts need independent best-effort audit evidence.
    const runId = randomUUID();
    const result = await runObservedR2Seed(pool, runId, args.apply ? 'apply' : 'dry-run', () => seedR2Backup({
        database: pool, primary: createR2SeedPrimarySource(
            new R2ObjectStore(primaryConfig!), new LocalObjectStore(primaryStorage.mediaRoot)),
        backup: new R2ObjectStore(recoveryConfig), ...args,
    }));
    if (result.kind === 'aborted') {
        console.error('Atlas Files R2 backup seeding aborted or inconclusive; copies may exist. Inspect recovery storage before retrying.');
        process.exitCode = 1;
    } else {
        console.log(JSON.stringify({ runId, ...result.report }, null, 2));
        if (result.report.status === 'failed' || result.report.status === 'empty') process.exitCode = 2;
    }
    if (!result.auditRecorded) {
        console.error('R2 seed Monitoring audit unavailable; the reported or aborted operation may have written copies. Inspect recovery storage before retrying.');
        process.exitCode = 3;
    }
} catch {
    // Raw exceptions can contain endpoints, credentials, signed headers or
    // private metadata. Do not print them to CLI logs.
    console.error('Atlas Files R2 backup seeding aborted or inconclusive; inspect storage and credentials before retrying.');
    process.exitCode = 1;
} finally {
    await pool?.end();
}
