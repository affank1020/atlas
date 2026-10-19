import { cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, test, vi } from 'vitest';
import { Bootstrap } from './AppBootstrap';
import { createAtlasStore } from './store';
import { atlasApi } from './atlasApi';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); location.hash = ''; });

test('deep link mounts shell and selected route while project list never resolves', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit) => {
        const name = url.split('/').pop()!;
        const input = JSON.parse(String(options.body));
        calls.push(`${name}:${input.projectId ?? 'all'}`);
        return new Promise(() => {});
    }));
    location.hash = '#/projects/selected/data';
    const { store, unsubscribeMutations } = createAtlasStore();
    render(<Provider store={store}><Bootstrap /></Provider>);
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Project sections' })).toBeInTheDocument();
    expect(calls.sort()).toEqual(['get_project:selected', 'list_projects:all', 'list_stores:selected']);
    expect(screen.queryByText('Preparing your workspace')).not.toBeInTheDocument();
    cleanup(); store.dispatch(atlasApi.util.resetApiState()); unsubscribeMutations();
});
