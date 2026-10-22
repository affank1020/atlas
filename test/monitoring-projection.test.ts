import assert from 'node:assert/strict';
import test from 'node:test';
import { projectMonitoringEvent } from '../apps/server/src/core/monitoring-projection.js';
import type { AuditEvent } from '../apps/server/src/types.js';

function audit(resulting: unknown, previous?: unknown): AuditEvent {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        occurredAt: '2026-10-22T12:00:00.000Z',
        client: 'atlas-test', operation: 'workspace.mutation_failed',
        projectId: '22222222-2222-4222-8222-222222222222',
        workspaceId: '33333333-3333-4333-8333-333333333333',
        resulting, previous,
    };
}
test('safe activity details remove nested snapshots, secrets, errors and arbitrary metadata without changing source', () => {
    const raw = audit({
        attemptId: 'attempt_1', operation: 'workspace.dev_invoked',
        nodeId: '44444444-4444-4444-8444-444444444444',
        task: 'test', durationMs: 210, exitCode: 1, success: false,
        timedOut: false, stderrTruncated: true, outcome: 'failed',
        error: 'postgres://credential@internal-host', path: '/home/person/secret',
        password: 'private', stdout: 'TOKEN=private', data: { nested: 'sensitive' },
    }, { data: { password: 'original-secret' } });
    const projected = projectMonitoringEvent(raw);
    assert.equal(projected.id, raw.id);
    assert.equal(projected.workspaceId, raw.workspaceId);
    assert.equal(projected.operation, raw.operation);
    assert.deepEqual(projected.resulting, {
        attemptId: 'attempt_1', operation: 'workspace.dev_invoked',
        nodeId: '44444444-4444-4444-8444-444444444444',
        task: 'test', durationMs: 210, exitCode: 1, success: false,
        timedOut: false, stderrTruncated: true, outcome: 'failed',
    });
    assert.ok(!Object.hasOwn(projected, 'previous'));
    assert.ok(!JSON.stringify(projected).includes('secret'));
    assert.ok(!JSON.stringify(projected).includes('private'));
    assert.ok(JSON.stringify(raw).includes('original-secret'), 'immutable original remains unchanged');
});
test('unknown, malformed, large or type-confused detail values are dropped rather than stringified', () => {
    const raw = audit({
        attemptId: 'secret:with spaces',
        task: 'password=something', command: '../path',
        operation: 'record.created', nodeId: 'not-a-uuid',
        outcome: 'credential=secret', error: { stack: 'SECRET' },
        exitCode: 1000000, durationMs: Number.POSITIVE_INFINITY,
        success: 'false', timedOut: null, previousNodeId: {},
        nested: { attemptId: 'valid-but-nested' },
    });
    const safe = projectMonitoringEvent(raw);
    assert.equal(safe.resulting, undefined);
    assert.ok(!Object.hasOwn(safe, 'previous'));
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    assert.doesNotThrow(() => projectMonitoringEvent(audit(cyclic)));
    assert.equal(projectMonitoringEvent(audit(['untrusted'])).resulting, undefined);
});
test('only bounded safe operation evidence necessary for correlation and failure status survives', () => {
    const raw = audit({
        attemptId: 'A'.repeat(129),
        operation: 'workspace.file_patched', outcome: 'failed_or_uncertain',
        nodeId: '44444444-4444-4444-8444-444444444444',
        sourceNodeId: '55555555-5555-4555-8555-555555555555',
        stderrTruncated: true,
    });
    assert.deepEqual(projectMonitoringEvent(raw).resulting, {
        operation: 'workspace.file_patched', outcome: 'failed_or_uncertain',
        nodeId: '44444444-4444-4444-8444-444444444444',
        sourceNodeId: '55555555-5555-4555-8555-555555555555',
        stderrTruncated: true,
    });
});

test('safe projection preserves workspace identity in the envelope but never relays arbitrary Workspace display text', () => {
    const raw = audit({ workspaceName: 'TOP_SECRET_DISPLAY_NAME', name: 'TOP_SECRET_NAME', task: 'build' });
    const projected = projectMonitoringEvent(raw);
    assert.equal(projected.workspaceId, raw.workspaceId);
    assert.deepEqual(projected.resulting, { task: 'build' });
    assert.ok(!JSON.stringify(projected).includes('TOP_SECRET'));
});
