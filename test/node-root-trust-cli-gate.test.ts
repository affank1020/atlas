import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// The actual compiled CLI must run under a terminal: otherwise its TTY guard
// would reject the command before testing the per-invocation safety gate.
const terminalAvailable = process.platform === 'linux' &&
    spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
const cli = resolve('apps/server/dist/server/node-root-trust-cli.js');
const nodeId = '01234567-89ab-4cde-8fab-0123456789ab';
const intentId = '12345678-90ab-4cde-8fab-1234567890ab';
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

test('reconcile CLI ignores persistent .env opt-in; explicit launch env enables only that invocation',
    { skip: !terminalAvailable }, () => {
        const root = mkdtempSync(join(tmpdir(), 'atlas-reconcile-gate-'));
        try {
            mkdirSync(join(root, 'apps/server'), { recursive: true });
            // This saved setting could be left behind by deployment tooling.
            // The dummy DB URL is intentionally unreachable, but the test
            // declines the operation BEFORE making any database connection.
            writeFileSync(join(root, 'apps/server/.env'),
                'ATLAS_NODE_UPDATE_RECONCILIATION_ENABLED=1\\n' +
                'DATABASE_URL=postgres://nobody:nobody@127.0.0.1:1/not-used\\n');
            const { ATLAS_NODE_UPDATE_RECONCILIATION_ENABLED: _flag,
                DATABASE_URL: _db, ...cleanEnv } = process.env;
            const cmd = [
                quote(process.execPath), quote(cli), 'reconcile',
                nodeId, intentId, '2.0.1+bbbbbbbbbbbb', '4242',
                'HOST-DRILL-1234',
            ].join(' ');

            const launch = (flag: string | undefined) => spawnSync(
                'script', ['-q', '-e', '-c', cmd, '/dev/null'], {
                    cwd: root, input: 'DECLINE\\n', encoding: 'utf8', timeout: 20_000,
                    env: { ...cleanEnv, ...(flag === undefined
                        ? {} : { ATLAS_NODE_UPDATE_RECONCILIATION_ENABLED: flag }) },
                });
            const persistedOnly = launch(undefined);
            assert.equal(persistedOnly.error, undefined, String(persistedOnly.error));
            assert.notEqual(persistedOnly.status, 0);
            assert.match(persistedOnly.stdout + persistedOnly.stderr,
                /Manual reconciliation disabled: explicitly opt in for this CLI invocation/);
            assert.doesNotMatch(persistedOnly.stdout + persistedOnly.stderr,
                /THIS ACTION WILL CLOSE A CLAIMED UPDATE/);

            const explicit = launch('1');
            assert.equal(explicit.error, undefined, String(explicit.error));
            assert.notEqual(explicit.status, 0, 'deliberately declined operation must fail');
            assert.match(explicit.stdout + explicit.stderr,
                /THIS ACTION WILL CLOSE A CLAIMED UPDATE/);
            assert.doesNotMatch(explicit.stdout + explicit.stderr,
                /Manual reconciliation disabled/);
            assert.match(explicit.stdout + explicit.stderr,
                /Root-trust operator action failed or acknowledgment is uncertain/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
