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


test('operation mode correlates before filtering and paginates completed attempts atomically', async () => {
    const { catalog, store } = await databaseFixture();
    const first = await catalog.createProject({ name: 'Correlation one', client: 'setup' });
    const other = await catalog.createProject({ name: 'Correlation two', client: 'setup' });
    const nodeId = '00000000-0000-4000-8000-000000001234';
    async function put(projectId: string, operation: string, attemptId: string, at: string, extra: Record<string, unknown> = {}) {
        await store.pool.query(`INSERT INTO audit_events (id, client, operation, project_id, after_state, created_at)
            VALUES (gen_random_uuid(), 'correlation-test', $1, $2, $3::jsonb, $4::timestamptz)`,
            [operation, projectId, JSON.stringify({ attemptId, ...extra }), at]);
    }
    await put(first.id, 'workspace.mutation_requested', 'a', '2026-10-22T08:00:00Z',
        { operation: 'workspace.dev_invoked', task: 'build', nodeId });
    await put(first.id, 'workspace.dev_invoked', 'a', '2026-10-22T08:01:00Z',
        { outcome: 'completed', task: 'build' });
    await put(first.id, 'workspace.mutation_requested', 'b', '2026-10-22T09:00:00Z',
        { operation: 'workspace.git_committed', task: 'publish', nodeId });
    await put(first.id, 'workspace.mutation_failed', 'b', '2026-10-22T09:01:00Z',
        { operation: 'workspace.git_committed', outcome: 'failed_or_uncertain' });
    await put(first.id, 'workspace.mutation_requested', 'c', '2026-10-22T10:00:00Z',
        { operation: 'workspace.file_patched', nodeId });
    // Same attempt ID under a different Project must never be coalesced.
    await put(other.id, 'workspace.mutation_failed', 'a', '2026-10-22T12:00:00Z',
        { outcome: 'failed' });

    const audit = new ActivityService(new AuditService(store));
    const query = { projectId: first.id, client: 'correlation-test', groupOperations: true };
    const firstPage = await audit.page({ ...query, limit: 1 });
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0].operation, 'workspace.mutation_requested');
    const secondPage = await audit.page({ ...query, limit: 1, offset: 1 });
    assert.equal(secondPage.total, 3);
    assert.deepEqual(secondPage.items.map(e => e.operation).sort(),
        ['workspace.mutation_failed', 'workspace.mutation_requested']);
    const thirdPage = await audit.page({ ...query, limit: 1, offset: 2 });
    assert.equal(thirdPage.total, 3);
    assert.deepEqual(thirdPage.items.map(e => e.operation).sort(),
        ['workspace.dev_invoked', 'workspace.mutation_requested']);
    const completed = await audit.page({ ...query, outcome: 'completed' });
    assert.equal(completed.total, 1);
    assert.equal(completed.items.length, 2, 'A completed attempt retains its request');
    const failed = await audit.page({ ...query, outcome: 'failed', category: 'git' });
    assert.equal(failed.total, 1);
    assert.equal(failed.items.length, 2, 'A failed attempt retains its request');
    const pending = await audit.page({ ...query, outcome: 'pending' });
    assert.equal(pending.total, 1);
    assert.equal(pending.items[0].operation, 'workspace.mutation_requested');
    const searched = await audit.page({ ...query, search: 'publish', outcome: 'failed' });
    assert.equal(searched.total, 1, 'Search on the request must still include the failure');
    assert.equal(searched.items.length, 2);
    const byNode = await audit.page({ ...query, nodeId, outcome: 'completed' });
    assert.equal(byNode.total, 1, 'Node association on request must also retain the result');
    assert.equal(byNode.items.length, 2);
    const byTerminal = await audit.page({ ...query, operation: 'workspace.dev_invoked' });
    assert.equal(byTerminal.total, 1);
    assert.equal(byTerminal.items.length, 2, 'Operation matching a terminal event includes the request');
    const dated = await audit.page({ ...query, from: '2026-10-22T09:00:30Z', to: '2026-10-22T09:05:00Z' });
    assert.equal(dated.total, 1, 'Time scope uses the operation completion timestamp');
    const offPage = await audit.page({ ...query, limit: 1, offset: 99 });
    assert.equal(offPage.total, 3, 'Empty pages keep the filtered total');
    assert.deepEqual(offPage.items, []);
    const oldMode = await audit.page({ projectId: first.id, client: 'correlation-test' });
    assert.equal(oldMode.total, 5, 'Legacy row-based pagination is unchanged');
});


test('grouped operation filter includes pending and failed-only request wrappers without trusting malformed metadata', async () => {
    const { catalog, store } = await databaseFixture();
    const project = await catalog.createProject({ name: 'Operation filter regression', client: 'setup' });
    const insert = async (operation: string, attemptId: string, requested: string | undefined, outcome?: string) => {
        await store.pool.query(`INSERT INTO audit_events (id, client, operation, project_id, after_state, created_at)
            VALUES (gen_random_uuid(), 'operation-filter-test', $1, $2, $3::jsonb, now())`,
            [operation, project.id, JSON.stringify({ attemptId, ...(requested && { operation: requested }), ...(outcome && { outcome }) })]);
    };
    await insert('workspace.mutation_requested', 'pending', 'workspace.git_committed');
    await insert('workspace.mutation_failed', 'failed-only', 'workspace.git_committed', 'failed_or_uncertain');
    await insert('workspace.git_committed', 'direct', undefined, 'completed');
    await insert('workspace.mutation_failed', 'malformed', 'workspace.git_committed;invalid', 'failed');
    await insert('workspace.mutation_failed', 'foreign', 'view.updated', 'failed');

    const audit = new ActivityService(new AuditService(store));
    const filter = { groupOperations: true, projectId: project.id, client: 'operation-filter-test' };
    const requested = await audit.page({ ...filter, operation: 'workspace.git_committed' });
    assert.equal(requested.total, 3, 'Match stored operations and validated requested operations');
    assert.deepEqual(requested.items.map(event => event.operation).sort(),
        ['workspace.git_committed', 'workspace.mutation_failed', 'workspace.mutation_requested']);

    const pending = await audit.page({ ...filter, operation: 'workspace.git_committed', outcome: 'pending' });
    assert.equal(pending.total, 1, 'Include pending-only requests');
    assert.equal(pending.items[0]?.operation, 'workspace.mutation_requested');
    const failed = await audit.page({ ...filter, operation: 'workspace.git_committed', outcome: 'failed' });
    assert.equal(failed.total, 1, 'Include failed-only wrappers without a successful operation row');
    assert.equal(failed.items[0]?.operation, 'workspace.mutation_failed');
    const completed = await audit.page({ ...filter, operation: 'workspace.git_committed', outcome: 'completed' });
    assert.equal(completed.total, 1, 'Continue matching the native operation event');

    const wrapper = await audit.page({ ...filter, operation: 'workspace.mutation_failed' });
    assert.equal(wrapper.total, 3, 'Explicit raw wrapper filtering must remain possible');
    assert.equal((await audit.page({ ...filter, operation: 'view.updated' })).total, 0,
        'Foreign wrapper metadata must never be reclassified as an operation');
    assert.equal((await audit.page({ ...filter, operation: 'workspace.git_committed;invalid' })).total, 0,
        'Malformed requested-operation metadata must not match');
});


test('grouped failed attempt uses latest event time after a contradictory later success', async () => {
    const { catalog, store } = await databaseFixture();
    const project = await catalog.createProject({ name: 'Correlation timestamp regression', client: 'setup' });
    const events = [
        { operation: 'workspace.mutation_requested', at: '2026-10-22T08:00:00Z',
          data: { attemptId: 'same', operation: 'workspace.git_committed' } },
        { operation: 'workspace.mutation_failed', at: '2026-10-22T08:01:00Z',
          data: { attemptId: 'same', operation: 'workspace.git_committed', outcome: 'failed', error: 'Rejected' } },
        { operation: 'workspace.git_committed', at: '2026-10-22T08:02:00Z',
          data: { attemptId: 'same', outcome: 'completed' } },
    ];
    for (const event of events) {
        await store.pool.query(`INSERT INTO audit_events (id, client, operation, project_id, after_state, created_at)
            VALUES (gen_random_uuid(), 'timestamp-test', $1, $2, $3::jsonb, $4::timestamptz)`,
            [event.operation, project.id, JSON.stringify(event.data), event.at]);
    }
    const query = { projectId: project.id, client: 'timestamp-test', groupOperations: true };
    const page = await new ActivityService(new AuditService(store)).page({
        ...query, outcome: 'failed', operation: 'workspace.git_committed',
        from: '2026-10-22T08:01:30Z', to: '2026-10-22T08:02:30Z',
    });
    assert.equal(page.total, 1, 'Time filters use latest event even when failure is older');
    assert.equal(page.items.length, 3, 'Request, failure and contradictory result stay correlated');
    assert.equal(page.items[0]?.occurredAt, '2026-10-22T08:02:00.000Z');
    assert.equal((await new ActivityService(new AuditService(store)).page({
        ...query, outcome: 'completed', from: '2026-10-22T08:01:30Z',
    })).total, 0, 'A later success must not conceal the earlier failure');
});
