import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';
import { loadPortfolioConfig, requireDatabaseUrl } from './config.js';
import { R2ObjectStore } from './file-storage.js';
import { auditAtlasFiles, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT } from './files-inventory.js';

// Manual operator-only command. No HTTP/MCP endpoint, scheduler or deletion.
loadEnv({ path: 'apps/server/.env', quiet: true });
const args = process.argv.slice(2);
const specified = args.find(value => value.startsWith('--max-objects='));
if (!args.includes('--dry-run') || args.some(value => value !== '--dry-run' && value !== specified))
    throw new Error('Usage: files-audit-cli --dry-run [--max-objects=2000] (read only)');
const limit = specified ? Number(specified.slice('--max-objects='.length)) : AUDIT_DEFAULT_LIMIT;
if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT)
    throw new Error('max-objects must be between 1 and ' + AUDIT_MAX_LIMIT);
const config = loadPortfolioConfig();
const pool = new Pool({ connectionString: requireDatabaseUrl(), connectionTimeoutMillis: 5000 });
try {
    const r2 = config.r2 ? new R2ObjectStore(config.r2) : null;
    const result = await auditAtlasFiles({ pool, localRoot: config.mediaRoot, r2, maxObjects: limit });
    console.log(JSON.stringify(result, null, 2));
} catch {
    // Do not leak raw endpoint URLs, query strings or secrets through error detail.
    console.error('Atlas Files inventory audit failed; no objects were modified.');
    process.exitCode = 1;
} finally {
    await pool.end();
}
