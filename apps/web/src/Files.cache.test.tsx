import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Provider } from 'react-redux';
import { Files } from './Files';
import { callTool } from './api';
import { createAtlasStore } from './store';
import { atlasApi } from './atlasApi';

// Keep real RTK Query and the operational callTool mutation notification:
// mocking useApplicationRead would hide the stale-cache regression.
const response = (value: unknown) => ({ ok: true, status: 200, json: async () => value }) as Response;
const projectId = '00000000-0000-4000-8000-000000000001';
const rootId = '00000000-0000-4000-8000-000000000002';
const createdId = '00000000-0000-4000-8000-000000000003';
const worktreeId = '00000000-0000-4000-8000-000000000004';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('new Workspaces and worktrees become selectable after navigation without a page reload', async () => {
    const workspaces = [{ id: rootId, name: 'Initial Workspace', status: 'active' }];
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
        const action = url.split('/').pop()!;
        calls.push(action);
        if (action === 'list_projects') return response([{ id: projectId, name: 'Research' }]);
        if (action === 'list_all_applications') return response([]);
        if (action === 'list_workspaces') return response([...workspaces]);
        if (action === 'create_workspace') {
            workspaces.push({ id: createdId, name: 'New Workspace', status: 'active' });
            return response(workspaces[workspaces.length - 1]);
        }
        if (action === 'workspace_git_create_worktree') {
            workspaces.push({ id: worktreeId, name: 'Feature Worktree', status: 'active' });
            return response({ workspace: workspaces[workspaces.length - 1] });
        }
        if (action === 'archive_workspace') {
            const row = workspaces.find(item => item.id === createdId);
            if (row) row.status = 'archived';
            return response({});
        }
        if (action === 'list') return response([]);
        throw new Error('Unexpected request: ' + action);
    });
    vi.stubGlobal('fetch', fetcher);
    const { store, unsubscribeMutations } = createAtlasStore();
    const renderFiles = () => render(<Provider store={store}><Files /></Provider>);
    try {
        const initial = renderFiles();
        fireEvent.change(screen.getByRole('combobox', { name: 'Owner type' }), { target: { value: 'workspace' } });
        expect(await screen.findByRole('option', { name: 'Initial Workspace' })).toBeInTheDocument();
        initial.unmount();

        // Workspaces page creates a Workspace using direct callTool, not RTK mutate.
        await callTool('create_workspace', { nodeId: 'node', rootPath: '/tmp/new', name: 'New Workspace' });
        renderFiles();
        fireEvent.change(screen.getByRole('combobox', { name: 'Owner type' }), { target: { value: 'workspace' } });
        expect(await screen.findByRole('option', { name: 'New Workspace' })).toBeInTheDocument();

        // Creating a managed worktree is also an owner-list mutation.
        await callTool('workspace_git_create_worktree', { workspaceId: rootId, branch: 'atlas/feature' });
        expect(await screen.findByRole('option', { name: 'Feature Worktree' })).toBeInTheDocument();

        // An archived Workspace must disappear from owner choices.
        await callTool('archive_workspace', { workspaceId: createdId });
        await waitFor(() => expect(screen.queryByRole('option', { name: 'New Workspace' })).not.toBeInTheDocument());

        const beforeRefresh = calls.filter(name => name === 'list_workspaces').length;
        await waitFor(() => expect(screen.getByRole('button', { name: /Refresh/ })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
        await waitFor(() => expect(calls.filter(name => name === 'list_workspaces').length).toBeGreaterThan(beforeRefresh));
        expect(calls.filter(name => name === 'list_workspaces').length).toBeGreaterThanOrEqual(4);
    } finally {
        store.dispatch(atlasApi.util.resetApiState());
        unsubscribeMutations();
    }
});
