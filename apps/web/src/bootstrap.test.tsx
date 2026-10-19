import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Bootstrap } from './AppBootstrap';
import { BOOTSTRAP_CONCURRENCY, preloadProjects, releaseBootstrapSubscriptions, type BootstrapProgress } from './bootstrap';
import { atlasApi } from './atlasApi';
import { createAtlasStore, store } from './store';
import { getToolRequestCount } from './api';

vi.mock('./App', () => ({ default: () => <div>Atlas ready</div> }));

const projects = [
    { id: 'p', name: 'One' },
    { id: 'q', name: 'Two' },
    { id: 'archived', name: 'Old', archivedAt: '2026-01-01T00:00:00Z' },
];
const response = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data }) as Response;

afterEach(() => {
    cleanup();
    releaseBootstrapSubscriptions(store.dispatch);
    store.dispatch(atlasApi.util.resetApiState());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

test('startup completes real request progress and skips archived projects and heavy endpoints', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
        const name = url.split('/').pop()!;
        const arg = JSON.parse(String(options.body));
        calls.push(`${name}:${arg.projectId ?? 'all'}`);
        return response(name === 'list_projects' ? projects : name === 'get_project' ? { id: arg.projectId, name: arg.projectId } : []);
    }));
    render(<Bootstrap />);
    expect(screen.getByRole('heading', { name: 'Preparing your workspace' })).toBeInTheDocument();
    expect(await screen.findByText('Atlas ready')).toBeInTheDocument();
    expect(calls).toHaveLength(7);
    expect(calls).not.toContain('get_project:archived');
    expect(calls.every(call => !call.startsWith('render_view:') && !call.startsWith('list_records:'))).toBe(true);
});

test('bounded prefetch fills normal query cache for immediate repeat navigation', async () => {
    let inFlight = 0; let maxInFlight = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 4));
        inFlight--;
        const name = url.split('/').pop();
        const arg = JSON.parse(String(options.body));
        return response(name === 'list_projects' ? projects : name === 'get_project' ? { id: arg.projectId, name: arg.projectId } : []);
    }));
    const { store: testStore, unsubscribeMutations } = createAtlasStore();
    const progress: BootstrapProgress[] = [];
    const result = await preloadProjects(testStore.dispatch, next => progress.push(next));
    expect(result.failedTasks).toHaveLength(0);
    expect(result.metrics.requestCount).toBe(7);
    expect(result.metrics.durationMs).toBeGreaterThan(0);
    expect(progress.at(-1)).toEqual({ completed: 7, total: 7, activeProjects: 2, failed: 0 });
    expect(maxInFlight).toBeLessThanOrEqual(BOOTSTRAP_CONCURRENCY);
    const before = getToolRequestCount();
    const cachedProject = testStore.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'p', includeArchived: true }));
    const cachedStores = testStore.dispatch(atlasApi.endpoints.listStores.initiate({ projectId: 'p', includeArchived: true }));
    const cachedViews = testStore.dispatch(atlasApi.endpoints.listViews.initiate({ projectId: 'p', includeArchived: true }));
    await Promise.all([cachedProject.unwrap(), cachedStores.unwrap(), cachedViews.unwrap()]);
    expect(getToolRequestCount()).toBe(before);
    cachedProject.unsubscribe(); cachedStores.unsubscribe(); cachedViews.unsubscribe(); releaseBootstrapSubscriptions(testStore.dispatch); unsubscribeMutations();
});

test('an optional failure permits partial start and retry only the failed query', async () => {
    let viewsAttempts = 0;
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
        const name = url.split('/').pop();
        const arg = JSON.parse(String(options.body));
        if (name === 'list_views' && arg.projectId === 'q' && ++viewsAttempts === 1) return response({ message: 'temporarily unavailable' }, false);
        return response(name === 'list_projects' ? projects : name === 'get_project' ? { id: arg.projectId, name: arg.projectId } : []);
    });
    vi.stubGlobal('fetch', fetcher);
    render(<Bootstrap />);
    expect(await screen.findByRole('heading', { name: 'Some projects are unavailable' })).toBeInTheDocument();
    expect(screen.getByText('7 of 7 requests complete')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed requests' }));
    expect(await screen.findByText('Atlas ready')).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(8);
});

test('a failed project list offers retry and partial-start recovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ message: 'offline' }, false)));
    render(<Bootstrap />);
    expect(await screen.findByRole('heading', { name: 'Atlas is unavailable' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with available data' }));
    expect(screen.getByText('Atlas ready')).toBeInTheDocument();
});

test('mutation invalidation after preload refetches only the affected project', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
        const name = url.split('/').pop()!;
        const arg = JSON.parse(String(options.body));
        calls.push(`${name}:${arg.projectId ?? 'all'}`);
        return response(name === 'list_projects' ? projects : name === 'get_project' ? { id: arg.projectId, name: arg.projectId } : []);
    }));
    const { store: testStore, unsubscribeMutations } = createAtlasStore();
    await preloadProjects(testStore.dispatch, () => {});
    const qBefore = calls.filter(call => call === 'get_project:q').length;
    await testStore.dispatch(atlasApi.endpoints.mutate.initiate({ name: 'update_project', input: { projectId: 'p', name: 'Updated' } })).unwrap();
    const p = testStore.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'p', includeArchived: true }));
    const q = testStore.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'q', includeArchived: true }));
    await Promise.all([p.unwrap(), q.unwrap()]);
    expect(calls.filter(call => call === 'get_project:p')).toHaveLength(2);
    expect(calls.filter(call => call === 'get_project:q')).toHaveLength(qBefore);
    p.unsubscribe(); q.unsubscribe(); releaseBootstrapSubscriptions(testStore.dispatch); unsubscribeMutations();
});

test('preloaded project data remains available hours later without silent revalidation', async () => {
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
        const name = url.split('/').pop();
        const arg = JSON.parse(String(options.body));
        return response(name === 'list_projects' ? projects : name === 'get_project' ? { id: arg.projectId, name: arg.projectId } : []);
    });
    vi.stubGlobal('fetch', fetcher);
    const { store: testStore, unsubscribeMutations } = createAtlasStore();
    try {
        await preloadProjects(testStore.dispatch, () => {});
        const initialRequests = fetcher.mock.calls.length;
        expect(initialRequests).toBe(7);

        // Both mounted and later-unmounted components reuse the initial data
        // even well beyond the previous 60s freshness and 10m eviction periods.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
        const project = testStore.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'p', includeArchived: true }));
        const views = testStore.dispatch(atlasApi.endpoints.listViews.initiate({ projectId: 'p', includeArchived: true }));
        const stores = testStore.dispatch(atlasApi.endpoints.listStores.initiate({ projectId: 'q', includeArchived: true }));
        await Promise.all([project.unwrap(), views.unwrap(), stores.unwrap()]);
        expect(fetcher).toHaveBeenCalledTimes(initialRequests);

        project.unsubscribe(); views.unsubscribe(); stores.unsubscribe();
        const revisit = testStore.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'p', includeArchived: true }));
        await revisit.unwrap();
        expect(fetcher).toHaveBeenCalledTimes(initialRequests);

        // Manual Refresh explicitly overrides the cache.
        const refreshed = testStore.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'p', includeArchived: true }, { forceRefetch: true }));
        await refreshed.unwrap();
        expect(fetcher).toHaveBeenCalledTimes(initialRequests + 1);
        revisit.unsubscribe(); refreshed.unsubscribe();
    } finally {
        vi.useRealTimers();
        releaseBootstrapSubscriptions(testStore.dispatch);
        unsubscribeMutations();
    }
});
