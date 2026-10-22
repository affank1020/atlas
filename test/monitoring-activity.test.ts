import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { ActivityService } from '../apps/server/src/activity/service.js';
import { AuditService } from '../apps/server/src/core/audit.js';
import { cleanupDatabases, databaseFixture } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { NodeShareApprovals } from '../apps/server/src/nodes/share-approvals.js';
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

    // A failed mutation is stored under a wrapper operation; category filters
    // must classify the original operation and preserve the immutable wrapper.
    const wrapped: Array<{ name: string; operation?: string; outcome?: string }> = [
        { name: 'failed git', operation: 'workspace.git_committed', outcome: 'failed_or_uncertain' },
        { name: 'failed files', operation: 'workspace.file_patched', outcome: 'failed_or_uncertain' },
        { name: 'failed dev', operation: 'workspace.dev_invoked', outcome: 'failed_or_uncertain' },
        { name: 'pending git', operation: 'workspace.git_committed' },
        { name: 'invalid metadata', operation: 'record.updated', outcome: 'failed_or_uncertain' },
        { name: 'missing metadata', outcome: 'failed_or_uncertain' },
    ];
    for (const row of wrapped) {
        await store.pool.query(`INSERT INTO audit_events (id, client, operation, project_id, after_state, created_at)
            VALUES (gen_random_uuid(), 'monitoring-test', $1, $2, $3::jsonb, now())`, [
            row.name === 'pending git' ? 'workspace.mutation_requested' : 'workspace.mutation_failed',
            second.id, JSON.stringify({ ...(row.operation ? { operation: row.operation } : {}), ...(row.outcome ? { outcome: row.outcome } : {}) }),
        ]);
    }
    for (const category of ['git', 'files', 'dev']) {
        const matches = await monitoring.page({ projectId: second.id, category, outcome: 'failed' });
        assert.equal(matches.total, 1, `failed ${category} mutation must be included`);
        assert.equal(matches.items[0]?.operation, 'workspace.mutation_failed', 'Original immutable operation is preserved');
    }
    const requestedGit = await monitoring.page({ projectId: second.id, category: 'git', outcome: 'pending' });
    assert.equal(requestedGit.total, 1);
    assert.equal(requestedGit.items[0]?.operation, 'workspace.mutation_requested');
    const unmatched = await monitoring.page({ projectId: second.id, category: 'workspace', outcome: 'failed' });
    assert.equal(unmatched.total, 2, 'Invalid/missing original metadata remains in workspace category');
    const paginated = await monitoring.page({ projectId: second.id, category: 'git', outcome: 'failed', limit: 1 });
    assert.equal(paginated.total, 1);
    assert.equal(paginated.items.length, 1);

    const legacy = await catalog.auditHistory({ projectId: first.id, limit: 200 });
    assert.equal(legacy.length, 2, 'Legacy MCP history stays unchanged');
});

test('PostgreSQL Monitoring Node filter includes sender and recipient sharing events but no unrelated Node rows', async () => {
    const f = await databaseFixture();
    const identity = new NodeIdentity(f.store.pool);
    const a = await identity.enrol({token:(await identity.ticket()).enrolmentToken,name:'Sender',platform:'android'});
    const b = await identity.enrol({token:(await identity.ticket()).enrolmentToken,name:'Receiver',platform:'darwin'});
    const c = await identity.enrol({token:(await identity.ticket()).enrolmentToken,name:'Other',platform:'linux'});
    const sharing = new NodeShareApprovals(f.store.pool);
    await sharing.update({sourceNodeId:a.nodeId,targetNodeId:b.nodeId,enabled:true});
    await sharing.update({sourceNodeId:a.nodeId,targetNodeId:b.nodeId,enabled:false});
    await f.store.pool.query(`INSERT INTO audit_events(id,client,operation,after_state,created_at)
        VALUES(gen_random_uuid(),'test','node.updated',$1::jsonb,now())`,
        [JSON.stringify({sourceNodeId:a.nodeId,targetNodeId:b.nodeId})]);
    const monitoring = new ActivityService(new AuditService(f.store));
    for (const nodeId of [a.nodeId,b.nodeId]) {
        const filtered = await monitoring.page({nodeId,category:'node'});
        const events = filtered.items.filter(item => item.operation.startsWith('node.share.'));
        assert.equal(filtered.total,3,'Each Node also retains its own legitimate enrolment event');
        assert.equal(events.length,2,'Both sharing events are visible for either endpoint');
        assert.deepEqual(events.map(e => e.operation).sort(),['node.share.approved','node.share.revoked']);
        assert.equal(filtered.items.filter(e => e.operation === 'node.enrolled').length,1);
        assert.equal(filtered.items.filter(e => e.operation === 'node.updated').length,0,
            'Unrelated operations cannot match their sourceNodeId/targetNodeId metadata');
        const grants = await monitoring.page({nodeId,operation:'node.share.approved'});
        assert.equal(grants.total,1);
    }
    assert.equal((await monitoring.page({nodeId:c.nodeId,operation:'node.share.approved'})).total,0);
});
