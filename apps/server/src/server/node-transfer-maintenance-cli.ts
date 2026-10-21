import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';
import { requireDatabaseUrl } from './config.js';
import {
    expireNodeTransferCheckpoints,parseNodeTransferMaintenanceArgs,
    previewNodeTransferCleanup,
} from './node-transfer-maintenance.js';

// Explicit trusted-host operator tool: never a Node API, public HTTP/MCP
// endpoint or scheduled job. Default mode previews without any mutations.
loadEnv({ path: 'apps/server/.env', quiet: true });
const args = parseNodeTransferMaintenanceArgs(process.argv.slice(2));
const pool = new Pool({ connectionString: requireDatabaseUrl(), connectionTimeoutMillis: 5000 });
try {
    const result = args.apply
        ? await expireNodeTransferCheckpoints(pool, { maxSessions: args.maxSessions })
        : await previewNodeTransferCleanup(pool);
    console.log(JSON.stringify(result,null,2));
} catch {
    // Never echo PostgreSQL URLs or credentials in CLI error output.
    console.error('Atlas Node staging maintenance failed; see server diagnostics.');
    process.exitCode = 1;
} finally {
    await pool.end();
}
