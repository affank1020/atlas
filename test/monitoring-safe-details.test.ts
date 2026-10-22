import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { AuditService } from '../apps/server/src/core/audit.js';
import type { AtlasRepository } from '../apps/server/src/core/repository.js';
import type { AuditEvent } from '../apps/server/src/types.js';
import { databaseFixture, cleanupDatabases } from './database.js';

after(cleanupDatabases);

const marker = 'TOP_SECRET_MONITORING_DETAILS';
function assertions(page: Awaited<ReturnType<AuditService['monitoring']>>) {
    assert.equal(page.total, 1, 'Correlated operation count remains correct');
    assert.equal(page.items.length, 2, 'Both request and failure evidence remain correlated');
    assert.ok(page.items.every(event => !Object.hasOwn(event, 'previous')));
    assert.ok(page.items.every(event => !JSON.stringify(event).includes(marker)));
    assert.deepEqual(new Set(page.items.map(e => (e.resulting as any)?.attemptId)), new Set(['operation-1']));
    assert.ok(page.items.some(e => (e.resulting as any)?.outcome === 'failed'));
    assert.ok(page.items.some(e => (e.resulting as any)?.operation === 'workspace.file_patched'));
}

test('PostgreSQL safeDetails projects only selected audit rows after filtering and grouping', async () => {
    const { catalog, store } = await databaseFixture();
    const project = await catalog.createProject({ name: 'Safe operation audit' });
    await store.pool.query(
        `INSERT INTO audit_events(id,client,operation,project_id,before_state,after_state,created_at)
         VALUES
          (gen_random_uuid(),'safe-details-test','workspace.mutation_requested',$1,$2::jsonb,$3::jsonb,'2026-10-22T12:00:00Z'::timestamptz),
          (gen_random_uuid(),'safe-details-test','workspace.mutation_failed',$1,$4::jsonb,$5::jsonb,'2026-10-22T12:00:01Z'::timestamptz)`,
        [
            project.id,
            JSON.stringify({ password: marker }),
            JSON.stringify({ attemptId: 'operation-1', operation: 'workspace.file_patched', path: '/private/' + marker, token: marker }),
            JSON.stringify({ prior: marker }),
            JSON.stringify({ attemptId: 'operation-1', operation: 'workspace.file_patched', outcome: 'failed', error: marker, nodeId: '11111111-1111-4111-8111-111111111111' }),
        ],
    );
    const service = new AuditService(store);
    const filters = { projectId: project.id, client: 'safe-details-test',
        groupOperations: true, search: marker, outcome: 'failed' as const };
    // Filtering retains full DB evidence; projection happens only on returned page.
    const full = await service.monitoring(filters);
    assert.equal(full.total, 1);
    assert.ok(full.items.some(event => JSON.stringify(event).includes(marker)));
    const safe = await service.monitoring({ ...filters, safeDetails: true });
    assertions(safe);
    assert.deepEqual(safe.items.map(e => e.id).sort(), full.items.map(e => e.id).sort());
    assert.equal((await service.monitoring({ ...filters, search: 'does-not-exist', safeDetails: true })).total, 0);
    const history = await service.history({ projectId: project.id });
    assert.ok(history.some(event => JSON.stringify(event).includes(marker)),
        'Legacy full audit history keeps its original contract');
    const ungrouped = await service.monitoring({ projectId: project.id, client: 'safe-details-test',
        safeDetails: true, groupOperations: false });
    assert.equal(ungrouped.total, 2);
    assert.ok(ungrouped.items.every(event => !JSON.stringify(event).includes(marker)));
});

test('snapshot adapter and PostgreSQL produce the same safe correlated projection', async () => {
    const event = (id: string, operation: AuditEvent['operation'], resulting: Record<string, unknown>): AuditEvent => ({
        id, occurredAt: '2026-10-22T12:00:00Z', client: 'safe-details-test',
        operation, projectId: '22222222-2222-4222-8222-222222222222',
        workspaceId: '33333333-3333-4333-8333-333333333333',
        previous: { credential: marker }, resulting,
    });
    const snapshot = {
        schemaVersion: 1 as const, projects: [], stores: [], records: [], views: [],
        auditEvents: [
            event('request', 'workspace.mutation_requested', { attemptId: 'operation-1',
                operation: 'workspace.file_patched', path: marker }),
            event('failure', 'workspace.mutation_failed', { attemptId: 'operation-1',
                operation: 'workspace.file_patched', outcome: 'failed', error: marker }),
        ],
    };
    const store = { snapshot: async () => snapshot } as unknown as AtlasRepository;
    const service = new AuditService(store);
    const filters = { groupOperations: true, client: 'safe-details-test',
        projectId: snapshot.auditEvents[0]!.projectId, search: marker, outcome: 'failed' as const };
    assertions(await service.monitoring({ ...filters, safeDetails: true }));
    const full = await service.monitoring(filters);
    assert.ok(full.items.some(event => JSON.stringify(event).includes(marker)));
});
