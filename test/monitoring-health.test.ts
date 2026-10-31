import assert from 'node:assert/strict';
import test from 'node:test';
import { MonitoringHealthService } from '../apps/server/src/server/monitoring-health.js';
import type { AtlasNode } from '../apps/server/src/nodes/model.js';

const now = new Date('2026-10-22T12:00:00.000Z');
function node(id: string, status: AtlasNode['status'], lastSeen: string | null, extra: Partial<AtlasNode> = {}): AtlasNode {
    return {
        id, name: 'Node ' + id, status, lastSeen, capabilities: [],
        metadata: { token: 'must-not-be-exposed' }, platform: 'linux', version: '2.0.0',
        credentialState: 'active', credentialUpdatedAt: null, createdAt: now.toISOString(),
        updatedAt: now.toISOString(), hostedWorkspaceCount: 1, ...extra,
    };
}
function subject(nodes: AtlasNode[], query: () => Promise<unknown> = async () => ({ rows: [{ '?column?': 1 }] })) {
    const requests: unknown[] = [];
    const service = new MonitoringHealthService({ query: input => { requests.push(input); return query(); } },
        { list: async () => nodes }, () => now, () => 100);
    return { service, requests };
}

test('health uses actual database probe and Node effective connectivity/heartbeat freshness', async () => {
    const nodes = [
        node('one', 'online', '2026-10-22T11:59:40.000Z'),
        node('two', 'online', '2026-10-22T11:57:00.000Z'),
        node('three', 'offline', '2026-10-22T11:40:00.000Z'),
        node('four', 'unavailable', null),
        node('five', 'offline', null, { credentialState: 'revoked' }),
        node('six', 'online', null),
    ];
    const { service, requests } = subject(nodes);
    const value = await service.read({});
    assert.deepEqual(requests, [{ text: 'SELECT 1', query_timeout: 1500 }]);
    assert.equal(value.server.status, 'healthy');
    assert.equal(value.server.database.status, 'reachable');
    assert.equal(value.overall, 'degraded');
    assert.deepEqual(value.nodes.summary, { total: 6, healthy: 1, stale: 1, offline: 1,
        unavailable: 1, revoked: 1, unknown: 1 });
    assert.deepEqual(value.nodes.items.map(item => item.state),
        ['healthy', 'stale', 'offline', 'unavailable', 'revoked', 'unknown']);
    assert.equal(value.nodes.items[0]?.ageSeconds, 20);
    assert.ok(value.nodes.items.every(item => !Object.hasOwn(item, 'metadata')
        && !Object.hasOwn(item, 'credentialState')));
    assert.ok(!JSON.stringify(value).includes('must-not-be-exposed'));
    assert.equal(value.checkedAt, now.toISOString());
    assert.equal(value.server.uptimeSeconds, 0);
});

test('database failure and Node registry failure are reported without exception content or false green states', async () => {
    const unavailableDb = subject([], async () => { throw new Error('postgres://secret@private-host'); });
    const result = await unavailableDb.service.read();
    assert.equal(result.server.database.status, 'unavailable');
    assert.equal(result.overall, 'degraded');
    assert.ok(!JSON.stringify(result).includes('secret'));
    const brokenRegistry = new MonitoringHealthService(
        { query: async () => ({}) }, { list: async () => { throw new Error('db secret'); } }, () => now);
    const unknown = await brokenRegistry.read();
    assert.equal(unknown.nodes.available, false);
    assert.equal(unknown.overall, 'unknown');
    assert.equal(unknown.nodes.summary.total, 0);
    assert.ok(!JSON.stringify(unknown).includes('secret'));
});

test('an empty registry is not an outage; missing heartbeat makes online Node unknown', async () => {
    const empty = await subject([]).service.read();
    assert.equal(empty.overall, 'healthy');
    const uncertain = await subject([node('one', 'online', null)]).service.read();
    assert.equal(uncertain.overall, 'unknown');
    const fresh = await subject([node('one', 'online', '2026-10-22T11:58:40.000Z')]).service.read();
    assert.equal(fresh.overall, 'healthy');
    const justStale = await subject([node('one', 'online', '2026-10-22T11:58:29.000Z')]).service.read();
    assert.equal(justStale.nodes.items[0]?.state, 'stale');
});

test('health input rejects arbitrary probe parameters', async () => {
    const { service } = subject([]);
    await assert.rejects(() => service.read({ sql: 'SELECT * FROM users' }));
});

test('a Node directory that never settles returns unknown within the independent deadline', async () => {
    let lateReject!: (reason: Error) => void;
    const pending = new Promise<AtlasNode[]>((_, reject) => { lateReject = reject; });
    const health = new MonitoringHealthService(
        { query: async () => ({ rows: [{ '?column?': 1 }] }) },
        { list: () => pending }, () => now, () => 100, 15);
    const started = performance.now();
    const response = await health.read();
    assert.ok(performance.now() - started < 1000);
    assert.equal(response.nodes.available, false);
    assert.equal(response.nodes.summary.total, 0);
    assert.equal(response.overall, 'unknown');
    assert.equal(response.server.database.status, 'reachable');
    lateReject(new Error('late registry secret'));
    await Promise.resolve(); // Late failures remain handled and cannot alter the returned response.
    assert.ok(!JSON.stringify(response).includes('secret'));
});


test('far-future heartbeat cannot make a Node appear healthy', async () => {
    const future = await subject([node('wrong-clock', 'online', '2026-10-22T12:10:00.000Z')]).service.read();
    assert.equal(future.overall, 'unknown');
    assert.equal(future.nodes.items[0]?.state, 'unknown');
    assert.equal(future.nodes.items[0]?.ageSeconds, null);
    const minorSkew = await subject([node('minor-skew', 'online', '2026-10-22T12:00:10.000Z')]).service.read();
    assert.equal(minorSkew.nodes.items[0]?.state, 'healthy');
});


test('diagnostic archive availability adds independent uncertainty but does not overwrite database or Node failures', async () => {
    const status = (state: 'available' | 'unavailable' | 'disabled', drops = 0, paused = false) => ({
        state, coverage: 'incomplete-possible' as const, retentionDays: 14 as const,
        droppedSinceStart: drops, pending: 0, writePaused: paused,
        retentionCleanup: 'caught-up' as const,
    });
    const archive = (value: ReturnType<typeof status>) => ({ status: async () => value });
    const read = async (value: ReturnType<typeof status>, dbOk = true, nodes: AtlasNode[] = []) =>
        new MonitoringHealthService(
            { query: async () => { if (!dbOk) throw new Error('secret db URL'); return {}; } },
            { list: async () => nodes }, () => now, () => 100, 100, archive(value),
        ).read();
    const healthy = await read(status('available'));
    assert.equal(healthy.overall, 'healthy');
    assert.equal(healthy.diagnostics.status, 'available');
    assert.equal(healthy.diagnostics.coverage, 'incomplete-possible');
    assert.equal(healthy.diagnostics.droppedSinceStart, 0);
    assert.equal((await read(status('disabled'))).overall, 'healthy',
        'deliberately disabled optional history does not mean database is unhealthy');
    assert.equal((await read(status('unavailable'))).overall, 'unknown',
        'archive unavailable should never be presented as fully healthy');
    assert.equal((await read(status('available', 2))).overall, 'unknown',
        'known lost writes must be reflected in snapshot uncertainty');
    assert.equal((await read(status('available', 0, true))).overall, 'unknown',
        'diagnostic writer in backoff may be losing evidence');
    assert.equal((await read(status('unavailable'), false)).overall, 'degraded',
        'database failure takes precedence');
    assert.equal((await read(status('unavailable'), true, [node('x', 'offline', null)])).overall,
        'degraded', 'Node failures take precedence');
});

test('archive probe failures or a never-ending probe settle to unknown without leaking private diagnostics', async () => {
    const broken = new MonitoringHealthService(
        { query: async () => ({}) }, { list: async () => [] }, () => now, () => 100, 15,
        { status: async () => { throw new Error('credential=secret'); } },
    );
    const result = await broken.read();
    assert.equal(result.diagnostics.status, 'unknown');
    assert.equal(result.overall, 'unknown');
    assert.ok(!JSON.stringify(result).includes('credential=secret'));
    const stalled = new MonitoringHealthService(
        { query: async () => ({}) }, { list: async () => [] }, () => now, () => 100, 15,
        { status: () => new Promise(() => {}) },
    );
    const before = performance.now();
    const timed = await stalled.read();
    assert.ok(performance.now() - before < 1000);
    assert.equal(timed.diagnostics.status, 'unknown');
    assert.equal(timed.overall, 'unknown');
});

test('retention cleanup status is independent of archive reachability and uses unknown aggregate', async () => {
    const retention = async (cleanup: 'caught-up' | 'more-possible' | 'unavailable' | 'not-checked') =>
        new MonitoringHealthService(
            { query: async () => ({}) },
            { list: async () => [] }, () => now, () => 100, 50,
            { status: async () => ({
                state: 'available' as const, coverage: 'incomplete-possible' as const,
                retentionDays: 14 as const, droppedSinceStart: 0,
                pending: 0, writePaused: false, retentionCleanup: cleanup,
            }) },
        ).read();
    assert.equal((await retention('caught-up')).overall, 'healthy');
    for (const cleanup of ['more-possible', 'unavailable', 'not-checked'] as const) {
        const result = await retention(cleanup);
        assert.equal(result.server.database.status, 'reachable');
        assert.equal(result.diagnostics.status, 'available');
        assert.equal(result.diagnostics.retentionCleanup, cleanup);
        assert.equal(result.overall, 'unknown');
    }
});
