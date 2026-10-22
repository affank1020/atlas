import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { projectMonitoringEvent } from '../apps/server/src/activity/safe-detail.js';
import { AuditService } from '../apps/server/src/core/audit.js';
import { ActivityService } from '../apps/server/src/activity/service.js';
import { cleanupDatabases, databaseFixture } from './database.js';
import type { AuditEvent } from '../apps/server/src/types.js';

after(cleanupDatabases);

const projectId = '11111111-1111-4111-8111-111111111111';
const checkoutId = '22222222-2222-4222-8222-222222222222';
const nodeId = '33333333-3333-4333-8333-333333333333';
const evt = (resulting: unknown): AuditEvent => ({
    id: '44444444-4444-4444-8444-444444444444',
    occurredAt: '2026-10-22T09:00:00.000Z', operation: 'workspace.dev_invoked',
    client: 'test-client', projectId, workspaceId: checkoutId,
    previous: { password: 'secret-before' },
    resulting,
});

test('opt-in projection preserves safe operational evidence but drops raw snapshots and arbitrary fields', () => {
    const payload = {
        attemptId: 'run-41', nodeId, operation: 'workspace.dev_invoked',
        task: 'build', outcome: 'failed', exitCode: 1, durationMs: 123,
        timedOut: false, success: false, stdoutTruncated: true,
        error: 'Authorization: Bearer SECRET_ERR', stderr: 'API_KEY=SECRET_STDERR',
        credential: 'SECRET_VALUE', nested: { password: 'SECRET_NESTED' },
        path: '/private/SECRET_PATH', unsafe: ['SECRET_ARRAY'],
        command: 'command with spaces containing a secret',
    };
    const sanitized = projectMonitoringEvent(evt(payload));
    assert.deepEqual(sanitized.resulting, {
        attemptId: 'run-41', nodeId, operation: 'workspace.dev_invoked',
        task: 'build', outcome: 'failed', exitCode: 1, durationMs: 123,
        timedOut: false, success: false, stdoutTruncated: true,
    });
    assert.equal(sanitized.previous, undefined);
    assert.equal(sanitized.projectId, projectId);
    assert.equal(sanitized.workspaceId, checkoutId);
    assert.equal(sanitized.id, evt(payload).id);
    assert.doesNotMatch(JSON.stringify(sanitized), /SECRET_|secret-before|Authorization:/);
    assert.deepEqual(evt(payload).resulting, payload, 'Original immutable audit payload not mutated');
});

test('malformed markers, oversized values and unexpected event additions cannot reach the projection', () => {
    const payload = { attemptId: 'A'.repeat(300), nodeId: 'malformed',
        operation: 'unknown.secret', task: 'secret=value',
        durationMs: Number.POSITIVE_INFINITY, exitCode: 900000,
        outcome: 'private-secret', success: 'yes', stderrTruncated: null };
    const original = { ...evt(payload), privateCredential: 'SECRET' } as AuditEvent;
    const sanitized = projectMonitoringEvent(original);
    assert.deepEqual(sanitized.resulting, {});
    assert.equal(Object.hasOwn(sanitized, 'privateCredential'), false);
    assert.equal(Object.hasOwn(sanitized, 'previous'), false);
    assert.equal(projectMonitoringEvent(evt(null)).resulting && Object.keys(projectMonitoringEvent(evt(null)).resulting as object).length, 0);
});

test('server-side filtering and grouped totals happen before safe projection; legacy queries are unchanged', async () => {
    const { catalog, store } = await databaseFixture();
    const project = await catalog.createProject({ name: 'Safe monitoring read model', client: 'setup' });
    const workspace = checkoutId;
    await store.pool.query(
        `INSERT INTO audit_events(id,client,operation,project_id,workspace_id,after_state,before_state,created_at)
         VALUES (gen_random_uuid(),'safety-audit','workspace.mutation_requested',$1,$2,$3::jsonb,$4::jsonb,'2026-10-22T09:00:00Z'),
                (gen_random_uuid(),'safety-audit','workspace.dev_invoked',$1,$2,$5::jsonb,$6::jsonb,'2026-10-22T09:01:00Z')`,
        [
            project.id, workspace,
            JSON.stringify({ attemptId:'safe-run', operation:'workspace.dev_invoked', password:'SECRET_REQUEST', task:'build' }),
            JSON.stringify({ token:'SECRET_BEFORE' }),
            JSON.stringify({ attemptId:'safe-run', nodeId, outcome:'failed', error:'SECRET_ERROR', task:'build' }),
            JSON.stringify({ credentials:'SECRET_PREVIOUS' }),
        ],
    );
    const activity = new ActivityService(new AuditService(store));
    const request = { groupOperations: true, projectId: project.id, client: 'safety-audit', outcome: 'failed' as const,
        search: 'SECRET_ERROR', limit: 1 };
    const safe = await activity.page({ ...request, safeDetails: true });
    assert.equal(safe.total, 1);
    assert.equal(safe.items.length, 2, 'Representative request/result rows still correlate');
    assert.ok(safe.items.every(item => item.previous === undefined));
    assert.ok(safe.items.every(item => !JSON.stringify(item).includes('SECRET_')));
    assert.deepEqual(safe.items.map(item => (item.resulting as any).attemptId), ['safe-run', 'safe-run']);
    const raw = await activity.page(request);
    assert.equal(raw.total, 1);
    assert.ok(raw.items.some(item => JSON.stringify(item).includes('SECRET_ERROR')));
    assert.ok(raw.items.some(item => JSON.stringify(item).includes('SECRET_BEFORE')));
    const notFound = await activity.page({ ...request, search: 'missing', safeDetails: true });
    assert.equal(notFound.total, 0);
});
