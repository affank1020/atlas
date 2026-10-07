#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
loadEnv({ path: new URL('../apps/server/.env', import.meta.url), quiet: true });
import pg from 'pg';
import { configureDevTasks, readDevTasks } from './lib/workspace-dev.mjs';
if (process.argv.length !== 4 || !process.env.DATABASE_URL) {
    console.error('Usage: node scripts/configure-workspace-dev-tasks.mjs <workspace-uuid> <trusted-json-file> (DATABASE_URL required)');
    process.exitCode = 2;
} else {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try { const tasks = await readDevTasks(process.argv[3]); await configureDevTasks(pool, process.argv[2], tasks); console.log(`Configured ${Object.keys(tasks).join(', ') || 'no'} tasks for Workspace ${process.argv[2]}.`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { await pool.end(); }
}
