import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Provider } from 'react-redux';
import { Files } from './Files';
import { createAtlasStore } from './store';
import { atlasApi } from './atlasApi';

const response = (value: unknown) => ({ ok: true, status: 200, json: async () => value }) as Response;
const projectId = '00000000-0000-4000-8000-000000000001';
const nextProjectId = '00000000-0000-4000-8000-000000000002';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('Project browser refresh updates Project choices without fetching old owner catalogues', async () => {
    let projects = [{ id: projectId, name: 'Research' }];
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
        const action = url.split('/').pop()!;
        calls.push(action);
        if (action === 'list_projects') return response(projects.map(project => ({ ...project })));
        if (action === 'list') return response([]);
        if (action === 'folders-list') return response([]);
        throw new Error('Unexpected request: ' + action);
    });
    vi.stubGlobal('fetch', fetcher);
    const { store, unsubscribeMutations } = createAtlasStore();
    try {
        render(<Provider store={store}><Files /></Provider>);
        expect(await screen.findByRole('option', { name: 'Research' })).toBeInTheDocument();
        expect(calls).not.toContain('list_workspaces');
        expect(calls).not.toContain('list_all_applications');

        // Refresh is intentionally explicit so new Projects become visible
        // even when an earlier RTK Query catalogue has been cached.
        projects = [...projects, { id: nextProjectId, name: 'New Project' }];
        fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
        expect(await screen.findByRole('option', { name: 'New Project' })).toBeInTheDocument();
        fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: nextProjectId } });
        await waitFor(() => {
            const requests = fetcher.mock.calls.map(call => [call[0], call[1]?.body] as const);
            expect(requests.some(([url, body]) => url.endsWith('/api/files/folders-list') &&
                JSON.parse(String(body)).owner.id === nextProjectId)).toBe(true);
        });
    } finally {
        store.dispatch(atlasApi.util.resetApiState());
        unsubscribeMutations();
    }
});
