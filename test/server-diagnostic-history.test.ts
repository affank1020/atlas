import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ServerDiagnostics } from '../apps/server/src/server/diagnostics.js';
import { ServerDiagnosticHistory } from '../apps/server/src/server/diagnostic-history.js';
import { cleanupDatabases, databaseFixture } from './database.js';
after(cleanupDatabases);

test('Server history retains only fixed event codes across process replacement', async () => {
    const { store } = await databaseFixture();
    const archive = new ServerDiagnosticHistory(store.pool);
    const diagnostics = new ServerDiagnostics(true, () => new Date(), e => archive.record(e));
    diagnostics.record('server_initialised');
    diagnostics.record('tool_request_failed');
    await archive.flush();
    const restarted = new ServerDiagnosticHistory(store.pool);
    const result = await restarted.read({ limit: 10 });
    assert.equal(result.source, 'atlas-server-history');
    assert.equal(result.retention, 'best-effort');
    assert.equal(result.coverage, 'incomplete-possible');
    assert.equal(result.available, true);
    assert.deepEqual(result.events.map(e => e.code), ['tool_request_failed', 'server_initialised']);
    assert.ok(result.events.every(e => !('instanceId' in e) && !('error' in e)));
    await assert.rejects(() => restarted.read({ limit: 101 }));
    await assert.rejects(() => restarted.read({ unexpected: true }));
    await assert.rejects(store.pool.query(
        "INSERT INTO atlas_server_diagnostic_events (occurred_at, instance_id, code) VALUES (now(), gen_random_uuid(), 'unapproved_code')"));
    await archive.close();
});

test('Server history retains only last 14 days and enforces a bounded page', async () => {
    const { store } = await databaseFixture();
    const archive = new ServerDiagnosticHistory(store.pool);
    await store.pool.query(
        "INSERT INTO atlas_server_diagnostic_events (occurred_at, instance_id, code) VALUES " +
        "(now() - interval '15 days', gen_random_uuid(), 'tool_request_failed'), " +
        "(now(), gen_random_uuid(), 'server_initialised'), " +
        "(now(), gen_random_uuid(), 'background_task_failed')"
    );
    const one = await archive.read({ limit: 1 });
    assert.equal(one.events.length, 1);
    assert.equal(one.truncated, true);
    const all = await archive.read({ limit: 10 });
    assert.deepEqual(new Set(all.events.map(e => e.code)),
        new Set(['server_initialised', 'background_task_failed']));
    assert.equal(all.truncated, false);
});

test('failed writes have bounded backoff and do not change normal diagnostics', async () => {
    let requests = 0;
    const archive = new ServerDiagnosticHistory({
        query: async () => { requests++; throw new Error('database unavailable'); },
    }, true, () => 0);
    const diagnostics = new ServerDiagnostics(true, () => new Date(), e => archive.record(e));
    diagnostics.record('background_task_failed');
    await archive.flush();
    diagnostics.record('tool_request_failed');
    await archive.flush();
    assert.equal(requests, 1);
    const result = await archive.read();
    assert.equal(result.available, false);
    assert.equal(result.droppedSinceStart, 2);
    assert.deepEqual(result.events, []);
    assert.equal(diagnostics.read().events.length, 2);
});

test('disabled Server history does not write and cannot show stored data', async () => {
    let queried = false;
    const archive = new ServerDiagnosticHistory({
        query: async () => { queried = true; return { rows: [] }; },
    }, false);
    archive.record({ at: new Date().toISOString(), code: 'server_initialised', level: 'info' });
    assert.equal((await archive.read()).available, false);
    assert.equal(queried, false);
});


test('archive status probes only the fixed table and distinguishes unavailable, disabled, and write backoff', async () => {
    const statements: string[] = [];
    const archive = new ServerDiagnosticHistory({
        query: async (sql: string) => {
            statements.push(sql);
            if (sql.startsWith('INSERT')) throw new Error('postgres://SECRET at internal host');
            if (sql.startsWith('SELECT 1')) return { rows: [] };
            throw new Error('Unexpected operation');
        },
    }, true, () => 1000);
    const before = await archive.status();
    assert.equal(before.state, 'available');
    assert.equal(before.coverage, 'incomplete-possible');
    assert.equal(before.pending, 0);
    assert.equal(before.writePaused, false);
    archive.record({ code: 'background_task_failed', level: 'warning', at: new Date().toISOString() });
    await archive.flush();
    const after = await archive.status();
    assert.equal(after.state, 'available', 'reads can work while writes are backing off');
    assert.equal(after.droppedSinceStart, 1);
    assert.equal(after.writePaused, true);
    assert.deepEqual(statements.filter(sql => sql.startsWith('SELECT')), [
        'SELECT 1 FROM atlas_server_diagnostic_events LIMIT 1',
        'SELECT 1 FROM atlas_server_diagnostic_events LIMIT 1',
    ]);
    assert.ok(!JSON.stringify(after).includes('SECRET'));
    await archive.close();

    let disabledQueries = 0;
    const disabled = new ServerDiagnosticHistory({
        query: async () => { disabledQueries++; throw new Error('secret'); },
    }, false);
    assert.equal((await disabled.status()).state, 'disabled');
    assert.equal(disabledQueries, 0);

    const unavailable = new ServerDiagnosticHistory({
        query: async () => { throw new Error('secret hostname and password'); },
    });
    const status = await unavailable.status();
    assert.equal(status.state, 'unavailable');
    assert.equal(status.coverage, 'incomplete-possible');
    assert.ok(!JSON.stringify(status).includes('secret'));
    await unavailable.close();
});

test('retained fixed-code history ignores far-future entries rather than treating them as current evidence', async () => {
    const { store } = await databaseFixture();
    await store.pool.query(
        "INSERT INTO atlas_server_diagnostic_events (occurred_at,instance_id,code) VALUES " +
        "(now(),gen_random_uuid(),'server_initialised')," +
        "(now() + interval '7 days',gen_random_uuid(),'tool_request_failed')",
    );
    const history = new ServerDiagnosticHistory(store.pool);
    const read = await history.read({ limit: 10 });
    assert.deepEqual(read.events.map(event => event.code), ['server_initialised']);
    assert.equal(read.truncated, false);
    assert.equal((await history.status()).state, 'available');
    await history.close();
});
