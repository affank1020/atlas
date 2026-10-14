#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
loadEnv({ path: new URL('../apps/server/.env', import.meta.url), quiet: true });
import pg from 'pg';
import { configureDevTasks, readDevTasks } from './lib/workspace-dev.mjs';
if (process.argv.length !== 4 || !process.env.DATABASE_URL) {
    console.error('Usage: node scripts/configure-workspace-dev-tasks.mjs <workspace-uuid> <trusted-json-file> (DATABASE_URL required)');
    process.exitCode = 2;
} else {
    // Diagnose missing credentials before pg's opaque SCRAM error; never print secrets.
    let databaseUrl;
    try {
        databaseUrl = new URL(process.env.DATABASE_URL);
        if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL.');
        if (!databaseUrl.username || !databaseUrl.password) throw new Error('DATABASE_URL is missing a username or password. Check apps/server/.env and any exported DATABASE_URL in your shell.');
    } catch (error) {
        console.error(error.message === 'Invalid URL' ? 'DATABASE_URL is not a valid URL.' : error.message);
        process.exit(1);
    }
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try { const tasks = await readDevTasks(process.argv[3]); await configureDevTasks(pool, process.argv[2], tasks); console.log(`Configured ${Object.keys(tasks).join(', ') || 'no'} tasks for Workspace ${process.argv[2]}.`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { await pool.end(); }
}
