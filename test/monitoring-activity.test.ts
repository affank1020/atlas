import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { ActivityService } from '../apps/server/src/activity/service.js';
import { AuditService } from '../apps/server/src/core/audit.js';
import { cleanupDatabases, databaseFixture } from './database.js';
after(cleanupDatabases);

test('Monitoring filters and paginates over full PostgreSQL audit history', async () => {
    const { catalog, store } = await databaseFixture();
    const first = await catalog.createProject({ name: 'Monitoring A', client: 'client-one' });
    const second = await catalog.createProject({ name: 'Monitoring B', client: 'client-two' });
    await catalog.updateProject({ projectId: first.id, description: 'Changed', client: 'client-one' });
    const monitoring = new ActivityService(new AuditService(store));
    const scoped = await monitoring.page({ projectId: first.id, limit: 1, offset: 0 });
    assert.equal(scoped.total, 2);
    assert.equal(scoped.items.length, 1);
    assert.equal(scoped.items[0]?.operation, 'project.updated');
    const next = await monitoring.page({ projectId: first.id, limit: 1, offset: 1 });
    assert.equal(next.total, 2);
    assert.equal(next.items[0]?.operation, 'project.created');
    assert.notEqual(next.items[0]?.id, scoped.items[0]?.id);
    const byClient = await monitoring.page({ client: 'CLIENT-TWO' });
    assert.equal(byClient.total, 1);
    assert.equal(byClient.items[0]?.projectId, second.id);
    const searched = await monitoring.page({ search: 'project.updated', projectId: first.id });
    assert.equal(searched.total, 1);
    const missing = await monitoring.page({ projectId: second.id, operation: 'record.created' });
    assert.equal(missing.total, 0);
    assert.deepEqual(missing.items, []);
    // SQL three-valued logic: missing outcome/success must not discard normal rows.
    await store.pool.query(`INSERT INTO audit_events (id, client, operation, project_id, after_state, created_at)
        VALUES (gen_random_uuid(), 'monitoring-test', 'workspace.mutation_requested', $1, '{}'::jsonb, now()),
               (gen_random_uuid(), 'monitoring-test', 'workspace.mutation_requested', $1, NULL, now())`, [second.id]);
    const pending = await monitoring.page({ projectId: second.id, outcome: 'pending' });
    assert.equal(pending.total, 2);
    assert.ok(pending.items.every(item => item.operation === 'workspace.mutation_requested'));
    const completed = await monitoring.page({ projectId: first.id, outcome: 'completed' });
    assert.equal(completed.total, 2, 'Core rows without outcome metadata must be completed');
    const failed = await monitoring.page({ projectId: first.id, outcome: 'failed' });
    assert.equal(failed.total, 0);

    const legacy = await catalog.auditHistory({ projectId: first.id, limit: 200 });
    assert.equal(legacy.length, 2, 'Legacy MCP history stays unchanged');
});
