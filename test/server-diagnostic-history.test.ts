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


test('archive status samples loss and backoff after an in-flight INSERT fails while the SELECT waits', async () => {
    let rejectInsert!: (cause: Error) => void;
    let beganSelect!: () => void;
    const insert = new Promise<never>((_resolve, reject) => { rejectInsert = reject; });
    const selectCalled = new Promise<void>(resolve => { beganSelect = resolve; });
    let archive!: ServerDiagnosticHistory;
    const sql: string[] = [];
    archive = new ServerDiagnosticHistory({
        query: async (statement: string) => {
            sql.push(statement);
            if (statement.startsWith('INSERT')) return insert;
            if (statement.startsWith('SELECT 1')) {
                beganSelect();
                // Model a single-connection pool: this SELECT cannot finish until
                // the preceding INSERT has failed and its loss is accounted for.
                await archive.flush();
                return { rows: [] };
            }
            throw new Error('Unexpected diagnostic query');
        },
    }, true, () => 1000);

    archive.record({ code: 'tool_request_failed', level: 'warning',
        at: '2026-10-31T10:40:00Z' });
    const probe = archive.status();
    await selectCalled;
    rejectInsert(new Error('postgres://secret-after-insert-failure'));
    const state = await probe;
    assert.equal(state.state, 'available');
    assert.equal(state.droppedSinceStart, 1, 'loss during the probe must be visible');
    assert.equal(state.pending, 0);
    assert.equal(state.writePaused, true);
    assert.deepEqual(sql.map(statement => statement.startsWith('INSERT') ? 'INSERT' : 'SELECT'), ['INSERT','SELECT']);
    assert.ok(!JSON.stringify(state).includes('secret'));
    await archive.close();
});

test('archive status samples loss after a SELECT failure and retained reads do not return stale counters', async () => {
    let rejectInsert!: (reason: Error) => void;
    const pendingInsert = new Promise<never>((_resolve, reject) => { rejectInsert = reject; });
    let archive!: ServerDiagnosticHistory;
    archive = new ServerDiagnosticHistory({
        query: async (statement: string) => {
            if (statement.startsWith('INSERT')) return pendingInsert;
            await archive.flush();
            throw new Error('postgres://private diagnostic read failure');
        },
    }, true, () => 1000);
    archive.record({ code: 'background_task_failed', level: 'warning',
        at: '2026-10-31T10:40:00Z' });
    const pendingStatus = archive.status();
    const pendingRead = archive.read();
    rejectInsert(new Error('private diagnostic insert failure'));
    const [state, history] = await Promise.all([pendingStatus, pendingRead]);
    assert.equal(state.state, 'unavailable');
    assert.equal(state.droppedSinceStart, 1);
    assert.equal(state.writePaused, true);
    assert.equal(history.available, false);
    assert.equal(history.droppedSinceStart, 1);
    assert.equal(history.writePaused, true);
    assert.ok(!JSON.stringify({ state, history }).includes('private'));
    await archive.close();
});


test('diagnostic history keyset pages preserve PostgreSQL microsecond ties without gaps or duplicates', async () => {
    const { store } = await databaseFixture();
    const history = new ServerDiagnosticHistory(store.pool);
    // Multiple rows share the same millisecond, some the same microsecond.
    // A JavaScript Date cursor would round timestamps and skip events.
    await store.pool.query(
        "INSERT INTO atlas_server_diagnostic_events(occurred_at,instance_id,code) " +
        "SELECT now() - interval '2 hours' + (n / 2) * interval '1 microsecond', " +
        "gen_random_uuid(), CASE n % 3 WHEN 0 THEN 'server_initialised' " +
        "WHEN 1 THEN 'tool_request_failed' ELSE 'background_task_failed' END " +
        "FROM generate_series(0,8) AS n",
    );
    const expected = (await store.pool.query(
        "SELECT occurred_at,code FROM atlas_server_diagnostic_events " +
        "ORDER BY occurred_at DESC,id DESC",
    )).rows.map(row => ({ at: new Date(row.occurred_at).toISOString(), code: row.code }));
    const actual: Array<{ at: string; code: string }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
        const response = await history.read({ limit: 2, ...(cursor ? { cursor } : {}) });
        assert.equal(response.available, true);
        assert.ok(response.events.length <= 2);
        assert.equal(response.truncated, Boolean(response.nextCursor));
        assert.ok(response.events.every(event => !('instanceId' in event) && !('id' in event)));
        actual.push(...response.events.map(({ at, code }) => ({ at, code })));
        cursor = response.nextCursor;
        pages++;
        assert.ok(pages <= 6, 'pagination must terminate');
    } while (cursor);
    assert.equal(pages, 5);
    assert.deepEqual(actual, expected);
    await history.close();
});

test('newer insert after first page does not shift historical pages or repeat records', async () => {
    const { store } = await databaseFixture();
    const history = new ServerDiagnosticHistory(store.pool);
    await store.pool.query(
        "INSERT INTO atlas_server_diagnostic_events(occurred_at,instance_id,code) VALUES " +
        "(now()-interval '4 hours',gen_random_uuid(),'server_initialised')," +
        "(now()-interval '3 hours',gen_random_uuid(),'tool_request_failed')," +
        "(now()-interval '2 hours',gen_random_uuid(),'background_task_failed')",
    );
    const first = await history.read({ limit: 1 });
    assert.deepEqual(first.events.map(e => e.code), ['background_task_failed']);
    assert.ok(first.nextCursor);
    await store.pool.query(
        "INSERT INTO atlas_server_diagnostic_events(occurred_at,instance_id,code) " +
        "VALUES(now(),gen_random_uuid(),'server_initialised')",
    );
    const second = await history.read({ limit: 1, cursor: first.nextCursor });
    const third = await history.read({ limit: 1, cursor: second.nextCursor });
    assert.deepEqual([...first.events, ...second.events, ...third.events].map(e => e.code),
        ['background_task_failed','tool_request_failed','server_initialised']);
    assert.equal(third.nextCursor, undefined);
    assert.equal(third.truncated, false);
    const fresh = await history.read({ limit: 1 });
    assert.deepEqual(fresh.events.map(e => e.code), ['server_initialised'],
        'a fresh first page is not pinned to the old cursor');
    await history.close();
});

test('diagnostic cursor input is strict, bounded, canonical and never interpolated into SQL', async () => {
    const calls: unknown[][] = [];
    const history = new ServerDiagnosticHistory({
        query: async (_sql, values) => { calls.push(values ?? []); return { rows: [] }; },
    }, true);
    const badTokens = [
        '', '!!', 'a'.repeat(161),
        Buffer.from(JSON.stringify(['2026-10-31T11:00:00.123456Z', "1);DROP TABLE secrets;"])).toString('base64url'),
        Buffer.from(JSON.stringify(['not-a-date', '1'])).toString('base64url'),
        Buffer.from(JSON.stringify(['2026-02-31T11:00:00.123456Z', '1'])).toString('base64url'),
        Buffer.from(JSON.stringify(['2026-10-31T11:00:00.123456Z', '9223372036854775808'])).toString('base64url'),
        Buffer.from(JSON.stringify(['2026-10-31T11:00:00.123456Z', '01'])).toString('base64url'),
    ];
    for (const token of badTokens) {
        await assert.rejects(() => history.read({ limit: 1, cursor: token }));
    }
    await assert.rejects(() => history.read({ limit: 1, cursor: 'abc', sql: 'DROP TABLE x' }));
    assert.equal(calls.length, 0, 'invalid cursors must be rejected before database access');
    await history.close();
});

test('expired rows and future-dated rows stay excluded across diagnostic history pages', async () => {
    const { store } = await databaseFixture();
    const history = new ServerDiagnosticHistory(store.pool);
    await store.pool.query(
        "INSERT INTO atlas_server_diagnostic_events(occurred_at,instance_id,code) VALUES " +
        "(now() - interval '17 days',gen_random_uuid(),'server_initialised')," +
        "(now() - interval '3 days',gen_random_uuid(),'tool_request_failed')," +
        "(now() - interval '2 days',gen_random_uuid(),'background_task_failed')," +
        "(now() - interval '1 day',gen_random_uuid(),'server_initialised')," +
        "(now() + interval '3 days',gen_random_uuid(),'tool_request_failed')",
    );
    const first = await history.read({ limit: 2 });
    assert.equal(first.events.length, 2);
    assert.ok(first.nextCursor);
    const second = await history.read({ limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.events.map(e => e.code), ['tool_request_failed']);
    assert.equal(second.truncated, false);
    assert.equal(second.nextCursor, undefined);
    await history.close();
});
