import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';
import { loadPortfolioConfig, requireDatabaseUrl } from './config.js';
import { R2ObjectStore } from './file-storage.js';
import { loadRecoveryR2Config, parseRecoveryVerifyArgs, verifyR2Recovery } from './r2-recovery-verification.js';

// Operator-only read-only drill. No HTTP/MCP endpoint and no mutating S3 call.
loadEnv({ path: 'apps/server/.env', quiet: true });
let pool: Pool | undefined;
try {
    const args = parseRecoveryVerifyArgs(process.argv.slice(2));
    const primary = loadPortfolioConfig().r2;
    const recovery = loadRecoveryR2Config(process.env,primary);
    pool = new Pool({ connectionString: requireDatabaseUrl(), connectionTimeoutMillis: 5000 });
    const report = await verifyR2Recovery({
        database:pool,primary:new R2ObjectStore(primary!),backup:new R2ObjectStore(recovery),
        maxFiles:args.maxFiles,cursor:args.cursor,
    });
    console.log(JSON.stringify(report,null,2));
    // "partial" and "empty" never count as a successful recovery proof.
    if (report.status !== 'passed') process.exitCode = 2;
} catch {
    // Never print R2 secrets, database URLs, raw response bodies or filenames.
    console.error('Atlas Files recovery verification failed or was inconclusive; no objects were modified.');
    process.exitCode = 1;
} finally {
    await pool?.end();
}
