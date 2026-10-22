import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditService } from '../apps/server/src/core/audit.js';
import type { AtlasRepository } from '../apps/server/src/core/repository.js';
import type { AuditEvent } from '../apps/server/src/types.js';

test('snapshot Monitoring category filters honour original mutations and preserve immutable wrappers', async () => {
    const operations: Array<{ audit: AuditEvent['operation']; original?: string; outcome?: string }> = [
        { audit: 'workspace.mutation_failed', original: 'workspace.git_committed', outcome: 'failed_or_uncertain' },
        { audit: 'workspace.mutation_failed', original: 'workspace.file_patched', outcome: 'failed_or_uncertain' },
        { audit: 'workspace.mutation_failed', original: 'workspace.dev_invoked', outcome: 'failed_or_uncertain' },
        { audit: 'workspace.mutation_requested', original: 'workspace.git_committed' },
        { audit: 'workspace.mutation_failed', original: 'view.updated', outcome: 'failed_or_uncertain' },
        { audit: 'workspace.mutation_failed', outcome: 'failed_or_uncertain' },
        { audit: 'workspace.mutation_failed', original: 'workspace.git_invalid;DROP TABLE audit_events', outcome: 'failed_or_uncertain' },
        { audit: 'project.created' },
    ];
    const events: AuditEvent[] = operations.map(({ audit, original, outcome }, i) => ({
        id: String(i), occurredAt: new Date(Date.UTC(2026, 9, 21, 10, i)).toISOString(),
        client: 'test', projectId: 'p', operation: audit,
        resulting: { ...(original !== undefined && { operation: original }), ...(outcome !== undefined && { outcome }) },
    }));
    const repository = { snapshot: async () => ({ auditEvents: events }) } as unknown as AtlasRepository;
    const audit = new AuditService(repository);
    for (const [category, expectedOperation] of [
        ['git', 'workspace.git_committed'],
        ['files', 'workspace.file_patched'],
        ['dev', 'workspace.dev_invoked'],
    ] as const) {
        const result = await audit.monitoring({ projectId: 'p', category, outcome: 'failed', limit: 1 });
        assert.equal(result.total, 1, category);
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0].operation, 'workspace.mutation_failed');
        assert.deepEqual((result.items[0].resulting as { operation?: string })?.operation, expectedOperation);
    }
    const gitPending = await audit.monitoring({ category: 'git', outcome: 'pending' });
    assert.equal(gitPending.total, 1);
    assert.equal(gitPending.items[0].operation, 'workspace.mutation_requested');
    const invalid = await audit.monitoring({ category: 'workspace', outcome: 'failed' });
    assert.equal(invalid.total, 3, 'Missing, foreign and malformed operations retain wrapper category');
    const native = await audit.monitoring({ category: 'core', outcome: 'completed' });
    assert.equal(native.total, 1);
    assert.equal(native.items[0].operation, 'project.created');
});

test('snapshot Monitoring filters both sharing endpoints without broadening unrelated operations', async () => {
    const sender = '00000000-0000-4000-8000-000000000001';
    const receiver = '00000000-0000-4000-8000-000000000002';
    const unrelated = '00000000-0000-4000-8000-000000000003';
    const events: AuditEvent[] = [
        { id:'1',occurredAt:'2026-10-22T10:01:00.000Z',client:'atlas-mcp',
          operation:'node.share.approved',resulting:{sourceNodeId:sender,targetNodeId:receiver} },
        { id:'2',occurredAt:'2026-10-22T10:02:00.000Z',client:'atlas-http',
          operation:'node.share.revoked',resulting:{sourceNodeId:sender,targetNodeId:receiver} },
        { id:'3',occurredAt:'2026-10-22T10:03:00.000Z',client:'test',
          operation:'node.created',resulting:{sourceNodeId:sender,targetNodeId:receiver} },
    ];
    const store = {snapshot:async () => ({auditEvents:events})} as unknown as AtlasRepository;
    const audit = new AuditService(store);
    for (const nodeId of [sender,receiver]) {
        const result = await audit.monitoring({nodeId,category:'node'});
        assert.equal(result.total,2);
        assert.deepEqual(result.items.map(x => x.operation).sort(),['node.share.approved','node.share.revoked']);
    }
    assert.equal((await audit.monitoring({nodeId:unrelated,category:'node'})).total,0);
});


test('snapshot operation paging retains terminal outcomes across boundaries and searches', async () => {
    const rows: AuditEvent[] = [
        { id: 'r1', operation: 'workspace.mutation_requested', projectId: 'p', workspaceId: 'w',
            client: 'test', occurredAt: '2026-10-22T08:00:00Z',
            resulting: { attemptId: 'one', operation: 'workspace.dev_invoked', task: 'build' } },
        { id: 'c1', operation: 'workspace.dev_invoked', projectId: 'p', workspaceId: 'w',
            client: 'test', occurredAt: '2026-10-22T08:01:00Z',
            resulting: { attemptId: 'one', outcome: 'completed' } },
        { id: 'r2', operation: 'workspace.mutation_requested', projectId: 'p', workspaceId: 'w',
            client: 'test', occurredAt: '2026-10-22T09:00:00Z',
            resulting: { attemptId: 'two', operation: 'workspace.git_committed', task: 'push' } },
        { id: 'f2', operation: 'workspace.mutation_failed', projectId: 'p', workspaceId: 'w',
            client: 'test', occurredAt: '2026-10-22T09:01:00Z',
            resulting: { attemptId: 'two', operation: 'workspace.git_committed', outcome: 'failed' } },
    ];
    const repo = { snapshot: async () => ({ auditEvents: rows }) } as unknown as AtlasRepository;
    const audit = new AuditService(repo);
    const first = await audit.monitoring({ projectId: 'p', groupOperations: true, limit: 1 });
    assert.equal(first.total, 2);
    assert.deepEqual(first.items.map(e => e.id).sort(), ['f2','r2']);
    const next = await audit.monitoring({ projectId: 'p', groupOperations: true, limit: 1, offset: 1 });
    assert.equal(next.total, 2);
    assert.deepEqual(next.items.map(e => e.id).sort(), ['c1','r1']);
    const filtered = await audit.monitoring({ projectId: 'p', groupOperations: true, category: 'git', outcome: 'failed', search: 'push' });
    assert.equal(filtered.total, 1);
    assert.deepEqual(filtered.items.map(e => e.id).sort(), ['f2','r2']);
    assert.equal((await audit.monitoring({ groupOperations: true, outcome: 'pending' })).total, 0);
});


test('snapshot grouped operation filter matches validated wrapper names and retains raw wrapper querying', async () => {
    const event = (id: string, operation: AuditEvent['operation'], requested?: string, outcome?: string): AuditEvent => ({
        id, operation, projectId: 'p', workspaceId: 'w', client: 'test',
        occurredAt: '2026-10-22T10:00:00Z',
        resulting: { attemptId: id, ...(requested && { operation: requested }), ...(outcome && { outcome }) },
    });
    const rows: AuditEvent[] = [
        event('pending', 'workspace.mutation_requested', 'workspace.git_committed'),
        event('failure', 'workspace.mutation_failed', 'workspace.git_committed', 'failed_or_uncertain'),
        event('direct', 'workspace.git_status', undefined, 'completed'),
        event('foreign', 'workspace.mutation_failed', 'view.updated', 'failed'),
        event('malformed', 'workspace.mutation_failed', 'workspace.git_committed;invalid', 'failed'),
    ];
    const repo = { snapshot: async () => ({ auditEvents: rows }) } as unknown as AtlasRepository;
    const audit = new AuditService(repo);
    const options = { groupOperations: true, projectId: 'p' };
    const grouped = await audit.monitoring({ ...options, operation: 'workspace.git_committed' });
    assert.equal(grouped.total, 2);
    assert.deepEqual(grouped.items.map(e => e.id).sort(), ['failure', 'pending']);
    assert.equal((await audit.monitoring({ ...options, operation: 'workspace.git_committed', outcome: 'pending' })).total, 1);
    assert.equal((await audit.monitoring({ ...options, operation: 'workspace.git_committed', outcome: 'failed' })).total, 1);
    assert.equal((await audit.monitoring({ ...options, operation: 'workspace.mutation_failed' })).total, 3);
    assert.equal((await audit.monitoring({ ...options, operation: 'view.updated' })).total, 0);
    assert.equal((await audit.monitoring({ ...options, operation: 'workspace.git_committed;invalid' })).total, 0);
});
