import { describe, expect, it } from 'vitest';
import { activityEvidence, clientName, filterActivity, presentActivity } from './activity';
import type { AuditEvent } from './types';
export const event = (id: string, operation: string, resulting: unknown = {}, extra: Partial<AuditEvent> = {}): AuditEvent => ({ id, operation, resulting, occurredAt: '2026-10-06T19:52:37Z', client: 'chatgpt', projectId: 'project', workspaceId: 'workspace', ...extra });
describe('activity presentation', () => {
    it.each([['editor_play', 'Started Play Mode'], ['editor_stop', 'Stopped Play Mode'], ['console', 'Read Unity console'], ['get_component_properties', 'Read component properties'], ['capture_game_view', 'Captured Game View'], ['future_command', 'Future command']])('labels %s', (command, title) => {
        expect(presentActivity([event('a', 'workspace.unity_invoked', { command, outcome: 'completed' })])[0]).toMatchObject({ title, category: 'unity', status: 'completed', client: 'chatgpt' });
    });
    it.each([['file_created', 'Created'], ['file_patched', 'Updated'], ['file_deleted', 'Deleted']])('labels %s', (op, verb) => {
        expect(presentActivity([event('a', `workspace.${op}`, { path: 'Assets/Agent.cs' })])[0].title).toBe(`${verb} Assets/Agent.cs`);
    });
    it('groups out-of-order requests/results, prefers final status and keeps a stable key', () => {
        const request = event('r', 'workspace.mutation_requested', { attemptId: 'try', operation: 'workspace.unity_invoked', command: 'editor_play' });
        const result = event('s', 'workspace.unity_invoked', { attemptId: 'try', outcome: 'completed' });
        const pending = presentActivity([request])[0];
        expect(pending.status).toBe('pending');
        const items = presentActivity([result, request, result]);
        expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ id: pending.id, title: 'Started Play Mode', status: 'completed' });
        expect(presentActivity([request, { ...result, workspaceId: 'other' }])).toHaveLength(2);
    });
    it('collapses failures and preserves reason, and recognizes Unity editor errors', () => {
        const items = presentActivity([event('r', 'workspace.mutation_requested', { attemptId: 'try' }), event('f', 'workspace.mutation_failed', { attemptId: 'try', operation: 'workspace.file_patched', path: 'a.cs', error: 'SHA mismatch' }), event('u', 'workspace.unity_invoked', { outcome: 'editor_error' })]);
        expect(items).toHaveLength(2); expect(items.every(i => i.status === 'failed')).toBe(true);
        expect(items.find(i => i.category === 'files')).toMatchObject({ description: 'SHA mismatch', kind: 'failure' });
        expect(filterActivity(items, 'error')).toHaveLength(2);
    });
    it('retains Core/View activity, handles unknown adapters and scopes workspaces and clients', () => {
        const items = presentActivity([event('c', 'record.updated', {}, { workspaceId: undefined }), event('v', 'view.created', {}, { workspaceId: undefined }), event('w', 'workspace.future_invoked', { command: 'new_action' }, { client: 'codex' })], { workspace: 'AI Football' });
        expect(items.map(i => i.category).sort()).toEqual(['core', 'view', 'workspace']);
        expect(filterActivity(items, 'workspace', 'codex', 'workspace')[0]).toMatchObject({ workspaceName: 'AI Football', title: 'Workspace future invoked · New action' });
        expect(filterActivity(items, '', '', 'other')).toHaveLength(0);
        expect(clientName('chatgpt')).toBe('ChatGPT'); expect(clientName('codex')).toBe('Codex'); expect(clientName('custom-client')).toBe('custom-client');
    });
});

it('handles prototype-like and markup command names as plain text', () => {
    for (const command of ['constructor', '__proto__', '<img src=x>']) {
        const item = presentActivity([event('a', 'workspace.unity_invoked', { command }, { client: 'constructor' })])[0];
        expect(typeof item.title).toBe('string'); expect(clientName(item.client)).toBe('constructor');
    }
    expect(presentActivity([event('a', 'workspace.constructor')])[0].category).toBe('workspace');
});
it('uses lifecycle names and groups differently capitalized known client names in filters', () => {
    const items = presentActivity([event('w', 'workspace.created', { name: 'AI Football' }), event('u', 'workspace.unity_invoked', { command: 'console' }, { client: 'ChatGPT' })]);
    expect(items.every(i => i.workspaceName === 'AI Football')).toBe(true);
    expect(filterActivity(items, '', 'ChatGPT')).toHaveLength(2);
});

it('shows development outcomes with Node, task and duration without output blobs', () => {
    const attempt = event('r', 'workspace.mutation_requested', { attemptId: 'dev-1', operation: 'workspace.dev_invoked', task: 'test', nodeId: 'node' });
    const result = event('s', 'workspace.dev_invoked', { attemptId: 'dev-1', task: 'test', nodeId: 'node', durationMs: 4200, exitCode: 1, success: false, outcome: 'failed' });
    const items = presentActivity([attempt, result]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'dev', title: 'test · 4.2s', status: 'failed' });
    expect(items[0].details).toMatchObject({ nodeId: 'node', task: 'test', exitCode: 1, durationMs: 4200 });
    expect(filterActivity(items, 'dev')).toHaveLength(1);
});

it('does not hide a correlated failure behind a later successful event', () => {
    const request = event('request', 'workspace.mutation_requested', { attemptId: 'retry', operation: 'workspace.git_committed' });
    const failure = event('failure', 'workspace.mutation_failed', { attemptId: 'retry', operation: 'workspace.git_committed', outcome: 'failed', error: 'Push rejected' },
        { occurredAt: '2026-10-22T08:00:00Z' });
    const later = event('result', 'workspace.git_committed', { attemptId: 'retry', outcome: 'completed' },
        { occurredAt: '2026-10-22T08:01:00Z' });
    const items = presentActivity([later, request, failure]);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('failed');
    expect(items[0].description).toBe('Push rejected');
    expect(items[0].timestamp).toBe('2026-10-22T08:01:00Z');
    expect(items[0].details).toMatchObject({
        timestamp: '2026-10-22T08:01:00Z',
        evidenceTimestamp: '2026-10-22T08:00:00Z',
    });
});


it('sorts correlated activity by latest member time, not selected failure evidence time', () => {
    const request = event('r', 'workspace.mutation_requested',
        { attemptId: 'correlated', operation: 'workspace.git_committed' },
        { occurredAt: '2026-10-22T08:00:00Z' });
    const failure = event('f', 'workspace.mutation_failed',
        { attemptId: 'correlated', operation: 'workspace.git_committed', outcome: 'failed', error: 'Rejected' },
        { occurredAt: '2026-10-22T08:00:30Z' });
    const result = event('c', 'workspace.git_committed',
        { attemptId: 'correlated', outcome: 'completed' },
        { occurredAt: '2026-10-22T08:02:00Z' });
    const unrelated = event('other', 'record.updated', {},
        { workspaceId: undefined, occurredAt: '2026-10-22T08:01:00Z' });
    const items = presentActivity([failure, unrelated, request, result]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
        status: 'failed', timestamp: '2026-10-22T08:02:00Z',
        description: 'Rejected',
    });
    expect(items[1].timestamp).toBe('2026-10-22T08:01:00Z');
});

it('presents Node-control provenance as recorded metadata, not operator identity', () => {
    const result = presentActivity([event('n', 'node.update_outcome_reported', {
        transport: 'mcp', actorKind: 'node-credential',
        nodeId: '11111111-1111-4111-8111-111111111111',
        sourceNodeId: '22222222-2222-4222-8222-222222222222',
        targetNodeId: '33333333-3333-4333-8333-333333333333',
        intentId: '44444444-4444-4444-8444-444444444444',
        reportedState: 'activated', status: 'reconciled',
        approved: true, verified: false, clearsClaim: false,
    }, { client: 'atlas-node' })])[0];
    expect(activityEvidence(result)).toEqual(expect.arrayContaining([
        { label: 'Recorded client', value: 'atlas-node' },
        { label: 'Transport', value: 'mcp' },
        { label: 'Credential class', value: 'node-credential' },
        { label: 'Node-reported activation', value: 'activated' },
        { label: 'Verification flag', value: 'false' },
        { label: 'Source Node', value: '22222222-2222-4222-8222-222222222222' },
        { label: 'Target Node', value: '33333333-3333-4333-8333-333333333333' },
    ]));
    expect(activityEvidence(result).some(row => /user|human|operator identity/i.test(row.label))).toBe(false);
});

it('rejects forged identity-like provenance on unrelated operations and malformed IDs', () => {
    const raw = presentActivity([event('m', 'record.updated', {
        transport: 'http', actorKind: 'admin', verified: true,
        intentId: 'not-a-uuid', sourceNodeId: 'bad-source', targetNodeId: 'bad-target',
        status: 'reconciled', reportedState: 'activated', source: 'operator-cli',
    }, { workspaceId: undefined, client: 'browser' })])[0];
    expect(activityEvidence(raw)).toEqual([{ label: 'Recorded client', value: 'browser' }]);
});

it('labels trusted Files triggers and backup CLI sources without creating human attribution', () => {
    const files = presentActivity([event('f', 'files.record_updated', {
        source: 'database-trigger', actorKind: 'person', transport: 'shell',
    }, { client: 'atlas-files-db', workspaceId: undefined })])[0];
    const backup = presentActivity([event('b', 'backup.r2_seed_observed', {
        source: 'operator-cli', runId: '55555555-5555-4555-8555-555555555555',
    }, { client: 'atlas-backup-cli', workspaceId: undefined })])[0];
    expect(activityEvidence(files)).toContainEqual({ label: 'Recorded source', value: 'database-trigger' });
    expect(activityEvidence(backup)).toContainEqual({ label: 'Recorded source', value: 'operator-cli' });
    expect(activityEvidence(backup)).toContainEqual({ label: 'Backup run', value: '55555555-5555-4555-8555-555555555555' });
    expect(activityEvidence(files).some(row => row.label === 'Credential class')).toBe(false);
});
