import { describe, expect, it } from 'vitest';
import { clientName, filterActivity, presentActivity } from './activity';
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
