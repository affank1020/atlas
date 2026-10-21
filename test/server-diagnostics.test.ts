import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerDiagnostics } from '../apps/server/src/server/diagnostics.js';
import { createDispatcher } from '../apps/server/src/server/dispatch.js';

test('server diagnostics retain only fixed allowlisted operational events', () => {
    let ticks = 0;
    const diagnostics = new ServerDiagnostics(true, () => new Date(1761090000000 + ticks++ * 1000));
    diagnostics.record('server_initialised');
    diagnostics.record('background_task_failed');
    const result = diagnostics.read({ limit: 10 });
    assert.equal(result.available, true);
    assert.equal(result.source, 'atlas-server-process');
    assert.equal(result.retention, 'current-process');
    assert.equal(result.events.length, 2);
    assert.deepEqual(result.events.map(event => event.code), ['background_task_failed', 'server_initialised']);
    assert.equal(result.events[0]!.level, 'warning');
    assert.doesNotMatch(JSON.stringify(result), /password=|credential=|Authorization:/i);
    assert.throws(() => diagnostics.read({ limit: 101 }), /too_big|100|maximum/i);
    assert.throws(() => diagnostics.read({ limit: 5, path: '/var/run/docker.sock' }), /unrecognized|unknown|strict/i);
});

test('server diagnostic ring is bounded, signals truncation and excludes prior process history', () => {
    const diagnostics = new ServerDiagnostics();
    for (let i = 0; i < 205; i++) diagnostics.record('tool_request_failed');
    const limited = diagnostics.read({ limit: 7 });
    assert.equal(limited.events.length, 7);
    assert.equal(limited.truncated, true);
    assert.equal(diagnostics.read({ limit: 100 }).events.length, 100);
    const newProcess = new ServerDiagnostics();
    assert.deepEqual(newProcess.read().events, []);
});

test('disabled server diagnostics fail closed without retaining events', () => {
    const diagnostics = new ServerDiagnostics(false);
    diagnostics.record('tool_request_failed');
    assert.deepEqual(diagnostics.read().events, []);
    assert.equal(diagnostics.read().available, false);
});

test('dispatch logs fixed failure codes without exposing exception messages, arguments, or names', async () => {
    const diagnostics = new ServerDiagnostics();
    const secrets = 'CREDENTIAL=do-not-record-this';
    const services = {
        diagnostics,
        catalog: { listProjects: async () => { throw new Error(secrets); } },
        applications: { hasTool: () => false },
    } as any;
    const dispatch = createDispatcher(services);
    await assert.rejects(dispatch('list_projects', { token: secrets }), /do-not-record-this/);
    const result = diagnostics.read();
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.code, 'tool_request_failed');
    assert.doesNotMatch(JSON.stringify(result), /do-not-record-this|list_projects|token/i);
    const inspected = await dispatch('read_server_diagnostics', { limit: 5 }) as ReturnType<ServerDiagnostics['read']>;
    assert.deepEqual(inspected.events, result.events);
});
