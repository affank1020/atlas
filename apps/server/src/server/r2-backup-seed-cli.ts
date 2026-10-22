import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';
import { loadPortfolioConfig, requireDatabaseUrl } from './config.js';
import { R2ObjectStore } from './file-storage.js';
import { loadRecoveryR2Config } from './r2-recovery-verification.js';
import { parseR2SeedArgs, seedR2Backup } from './r2-backup-seeding.js';

// Manual operator-only command. No HTTP/MCP entry point and no scheduler.
// Defaults to dry-run. --apply requires a separate exact confirmation token.
loadEnv({ path: 'apps/server/.env', quiet: true });
let pool: Pool | undefined;
try {
    const args = parseR2SeedArgs(process.argv.slice(2));
    const primaryConfig = loadPortfolioConfig().r2;
    const recoveryConfig = loadRecoveryR2Config(process.env, primaryConfig);
    pool = new Pool({ connectionString: requireDatabaseUrl(), connectionTimeoutMillis: 5000 });
    const report = await seedR2Backup({
        database: pool, primary: new R2ObjectStore(primaryConfig!),
        backup: new R2ObjectStore(recoveryConfig), ...args,
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'failed' || report.status === 'empty') process.exitCode = 2;
} catch {
    // Raw exceptions can contain endpoints, credentials, signed headers or
    // private metadata. Do not print them to CLI logs.
    console.error('Atlas Files R2 backup seeding aborted or inconclusive; inspect storage and credentials before retrying.');
    process.exitCode = 1;
} finally {
    await pool?.end();
}
