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


test('operation query plans keep large audit snapshots out of the materialized history scan', async () => {
    const { catalog, store } = await databaseFixture();
    const projectA = await catalog.createProject({ name: 'Monitoring benchmark A', client: 'bench-setup' });
    const projectB = await catalog.createProject({ name: 'Monitoring benchmark B', client: 'bench-setup' });

    // 10,000 immutable rows / 5,000 correlated operations, each with an 8 KiB
    // historical snapshot. Synthetic plan regression, not a production latency SLA.
    await store.pool.query([
        'INSERT INTO audit_events (id, client, operation, project_id, before_state, after_state, created_at)',
        "SELECT gen_random_uuid(), 'monitoring-plan-test',",
        "CASE WHEN n % 2 = 1 THEN 'workspace.mutation_requested' ELSE 'workspace.dev_invoked' END,",
        'CASE WHEN n <= 6000 THEN $1::uuid ELSE $2::uuid END,',
        "jsonb_build_object('snapshot', repeat(md5(n::text), 256)),",
        "jsonb_build_object('attemptId', ((n+1)/2)::text,",
        "'operation', 'workspace.dev_invoked',",
        "'outcome', CASE WHEN n % 2 = 0 THEN 'completed' ELSE NULL END),",
        "'2026-10-22T08:00:00Z'::timestamptz + n * interval '1 second'",
        'FROM generate_series(1, 10000) AS n',
    ].join(' '), [projectA.id, projectB.id]);
    await store.pool.query('ANALYZE audit_events');

    // Capture the exact SQL the application executes instead of a stale approximation.
    type QueryResponse = { rows: Record<string, unknown>[] };
    const adapter = store as unknown as { query: (sql: string, values?: unknown[]) => Promise<QueryResponse> };
    const original = adapter.query;
    const captured: Array<{ sql: string; values: unknown[] }> = [];
    adapter.query = (sql, values) => {
        if (sql.includes('WITH base AS MATERIALIZED')) captured.push({ sql, values: values ?? [] });
        return original.call(store, sql, values);
    };
    try {
        const audit = new ActivityService(new AuditService(store));
        const global = await audit.page({ groupOperations: true, limit: 30, client: 'monitoring-plan-test' });
        const scoped = await audit.page({ groupOperations: true, projectId: projectA.id, limit: 30, client: 'monitoring-plan-test' });
        assert.equal(global.total, 5000);
        assert.equal(global.items.length, 60, 'Each operation has a request and a result');
        assert.equal(scoped.total, 3000);
        assert.equal(scoped.items.length, 60);
    } finally {
        adapter.query = original;
    }
    assert.equal(captured.length, 2);

    for (const [i, request] of captured.entries()) {
        assert.match(request.sql, /WITH base AS MATERIALIZED/);
        assert.match(request.sql, /SELECT a\.id, a\.created_at/);
        assert.doesNotMatch(request.sql, /SELECT a\.\*/);
        assert.match(request.sql, /LEFT JOIN audit_events d ON d\.id=r\.id/,
            'Wide JSON snapshots must be fetched only after the operation page is chosen');
        const planResult = await store.pool.query(
            'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + request.sql, request.values,
        );
        const plan = planResult.rows[0]['QUERY PLAN'][0] as {
            Plan: Record<string, unknown>; 'Execution Time': number;
        };
        const nodes: Record<string, unknown>[] = [];
        const walk = (node: Record<string, unknown>) => {
            nodes.push(node);
            for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
        };
        walk(plan.Plan);
        const baseScans = nodes.filter(node => node['Node Type'] === 'CTE Scan' && node['CTE Name'] === 'base');
        assert.ok(baseScans.length >= 1, 'EXPLAIN should show a materialized base CTE');
        assert.ok(baseScans.every(node => typeof node['Plan Width'] === 'number' && (node['Plan Width'] as number) < 512),
            'Materialized base rows should consist of narrow scalar fields, not 8-KiB snapshots');
        const mode = i === 0 ? 'global' : 'project-scoped';
        console.log('Monitoring operation EXPLAIN profile:', JSON.stringify({
            mode, historyRows: 10000, matchedOperations: i === 0 ? 5000 : 3000,
            executionMs: plan['Execution Time'],
            baseScanEstimatedWidths: baseScans.map(node => node['Plan Width']),
            sharedHitBlocks: plan.Plan['Shared Hit Blocks'],
            tempWrittenBlocks: plan.Plan['Temp Written Blocks'],
        }));
    }
});

test('logical Workspace Monitoring unifies physical checkouts across Nodes without broadening unrelated audit rows', async () => {
    const { catalog, store } = await databaseFixture();
    const project = await catalog.createProject({ name: 'Logical Monitoring', client: 'setup' });
    const otherProject = await catalog.createProject({ name: 'Unrelated Monitoring', client: 'setup' });
    const group = '11111111-1111-4111-8111-111111111111';
    const foreignGroup = '22222222-2222-4222-8222-222222222222';
    const first = '33333333-3333-4333-8333-333333333333';
    const second = '44444444-4444-4444-8444-444444444444';
    const unrelated = '55555555-5555-4555-8555-555555555555';
    const host = '66666666-6666-4666-8666-666666666666';
    const local = await store.pool.query("SELECT id FROM nodes WHERE local_key='local'");
    const localId = local.rows[0].id as string;
    await store.pool.query("INSERT INTO nodes(id,name,status) VALUES($1,'Monitoring test remote','offline')", [host]);
    await store.pool.query("INSERT INTO logical_workspaces(id,name) VALUES($1,'Shared Repository'),($2,'Unrelated Repository')",
        [group, foreignGroup]);
    for (const [id, nodeId, logicalId, root, archived] of [
        [first, localId, group, '/tmp/monitoring-a', false],
        [second, host, group, '/tmp/monitoring-b', true],
        [unrelated, host, foreignGroup, '/tmp/monitoring-c', false],
    ] as const) {
        await store.pool.query(`INSERT INTO workspaces
            (id,node_id,logical_workspace_id,project_id,name,root_path,kind,status,archived_at)
            VALUES($1,$2,$3,$4,$5,$6,'generic',$7,$8)`,
        [id, nodeId, logicalId, project.id, root, root, archived ? 'archived' : 'active',
            archived ? new Date('2026-10-21T10:00:00Z') : null]);
    }
    const addEvent = async (checkoutId: string, projectId: string, attempt: string, operation: string) => {
        await store.pool.query(`INSERT INTO audit_events
            (id,client,operation,project_id,workspace_id,after_state,created_at)
            VALUES(gen_random_uuid(),'logical-monitor-test',$1,$2,$3,$4::jsonb,now())`,
            [operation, projectId, checkoutId,
                JSON.stringify({ attemptId: attempt, task: 'test', error: 'CONFIDENTIAL_ERROR' })]);
    };
    await addEvent(first, project.id, 'first', 'workspace.mutation_requested');
    await addEvent(first, project.id, 'first', 'workspace.dev_invoked');
    await addEvent(second, project.id, 'second', 'workspace.dev_invoked');
    await addEvent(unrelated, project.id, 'other', 'workspace.dev_invoked');
    await addEvent(first, otherProject.id, 'outside-project', 'workspace.dev_invoked');
    const monitoring = new ActivityService(new AuditService(store));
    const shared = { logicalWorkspaceId: group, client: 'logical-monitor-test' };

    const rows = await monitoring.page(shared);
    assert.equal(rows.total, 4, 'Ordinary row pagination includes all events from registered member checkouts');
    assert.ok(rows.items.every(item => [first, second].includes(item.workspaceId!)));
    const grouped = await monitoring.page({ ...shared, groupOperations: true, safeDetails: true });
    assert.equal(grouped.total, 3, 'One checkout attempt counts once, across physical members and project scopes');
    assert.deepEqual(new Set(grouped.items.map(item => item.workspaceId)), new Set([first, second]));
    assert.ok(grouped.items.every(item => !JSON.stringify(item).includes('CONFIDENTIAL_ERROR')),
        'The logical filter must not bypass the safe Monitoring projection');
    const scoped = await monitoring.page({ ...shared, projectId: project.id, groupOperations: true });
    assert.equal(scoped.total, 2, 'Explicit Project filters are intersected, never replaced');
    assert.equal((await monitoring.page({ ...shared, checkoutId: second, groupOperations: true })).total, 1,
        'Explicit checkout scope intersects logical membership');
    assert.equal((await monitoring.page({ ...shared, checkoutId: unrelated, groupOperations: true })).total, 0,
        'A foreign checkout cannot escape the logical scope');
    assert.equal((await monitoring.page({ logicalWorkspaceId: foreignGroup, client: 'logical-monitor-test' })).total, 1);
    assert.equal((await monitoring.page({
        logicalWorkspaceId: '77777777-7777-4777-8777-777777777777', client: 'logical-monitor-test',
    })).total, 0, 'Unknown logical IDs return no rows');
});
