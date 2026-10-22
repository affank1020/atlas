import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { databaseFixture, cleanupDatabases } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { NodeService } from '../apps/server/src/nodes/service.js';
import { PostgresNodeRepository } from '../apps/server/src/infrastructure/database/nodes.js';
import { MonitoringHealthService } from '../apps/server/src/server/monitoring-health.js';

after(cleanupDatabases);

test('migrated unassigned Local Node is inert, but enrolled or checkout-owning Nodes remain visible', async () => {
    const { catalog, store } = await databaseFixture();
    const repository = new PostgresNodeRepository(store.pool);
    const service = new NodeService(repository);
    const identity = new NodeIdentity(store.pool);
    const localId = (await store.pool.query("SELECT id FROM nodes WHERE local_key='local'")).rows[0].id as string;
    assert.equal((await repository.list()).length, 1, 'Default registry still has the seeded Local Node');

    const ticket = await identity.ticket();
    const remote = await identity.enrol({ token: ticket.enrolmentToken, name: 'Remote VPS', platform: 'linux' });
    await repository.registerRemote(remote.nodeId, 'Remote VPS', [], 'health-test-session', 'linux', '2.0.0');
    service.attachRemote(remote.nodeId, { getCapabilities: () => [] } as Parameters<NodeService['attachRemote']>[1]);
    const health = new MonitoringHealthService(store.pool, { list: () => service.listForMonitoring() });
    const first = await health.read();
    assert.equal(first.overall, 'healthy');
    assert.equal(first.nodes.summary.total, 1);
    assert.deepEqual(first.nodes.items.map(node => node.id), [remote.nodeId]);
    assert.equal((await repository.list()).length, 2, 'Ordinary Node management still lists the legacy identity');

    const project = await catalog.createProject({ name: 'Legacy ownership' });
    const logical = randomUUID();
    await store.pool.query("INSERT INTO logical_workspaces(id,name) VALUES($1,'Legacy checkout')", [logical]);
    const workspace = randomUUID();
    await store.pool.query(
        "INSERT INTO workspaces(id,project_id,name,root_path,kind,adapter,node_id,logical_workspace_id) VALUES($1,$2,'Legacy checkout','/tmp/health-legacy-checkout','generic',NULL,$3,$4)",
        [workspace, project.id, localId, logical],
    );
    const assigned = await health.read();
    assert.equal(assigned.overall, 'degraded', 'Legacy Node with a real binding requires attention');
    assert.ok(assigned.nodes.items.some(node => node.id === localId && node.state === 'offline'));

    await store.pool.query('UPDATE workspaces SET archived_at=now() WHERE id=$1', [workspace]);
    const archived = await health.read();
    assert.equal(archived.overall, 'degraded', 'Archived checkouts still belong to the legacy Node');

    await store.pool.query('UPDATE workspaces SET node_id=$1 WHERE id=$2', [remote.nodeId, workspace]);
    assert.equal((await health.read()).overall, 'healthy', 'Unassigned migration placeholder is inert again');

    await store.pool.query("UPDATE nodes SET credential_state='pending' WHERE id=$1", [localId]);
    assert.equal((await health.read()).overall, 'degraded', 'Operator-managed pending legacy identity is not hidden');
});

test('a saturated database pool returns a bounded unavailable health snapshot without queued leftover work', async () => {
    const { databaseUrl } = await databaseFixture();
    const limited = new Pool({ connectionString: databaseUrl, max: 1,
        connectionTimeoutMillis: 90, query_timeout: 200, statement_timeout: 200 });
    const held = await limited.connect();
    try {
        const repository = new PostgresNodeRepository(limited, limited);
        const health = new MonitoringHealthService(limited,
            { list: () => repository.listForMonitoring() }, () => new Date(), () => performance.now(), 450);
        const started = performance.now();
        const snapshot = await health.read();
        assert.ok(performance.now() - started < 900, 'Pool exhaustion should not wait on HTTP timeout');
        assert.equal(snapshot.server.database.status, 'unavailable');
        assert.equal(snapshot.nodes.available, false);
        assert.equal(snapshot.overall, 'degraded');
        // Queued pg.Pool acquisition requests must time out and be removed,
        // not execute later after the held connection is returned.
        assert.equal(limited.waitingCount, 0);
    } finally {
        held.release();
        await limited.end();
    }
});
