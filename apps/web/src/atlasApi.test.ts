import { afterEach, expect, test, vi } from 'vitest';
import { atlasApi } from './atlasApi';
import { createAtlasStore } from './store';
import { callTool } from './api';

const response = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data }) as Response;
afterEach(() => vi.unstubAllGlobals());

test('deduplicates subscribers, retains project data across sections, and isolates projects', async () => {
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
        const input = JSON.parse(String(options.body));
        return response({ id: input.projectId, name: input.projectId });
    });
    vi.stubGlobal('fetch', fetcher);
    const { store, unsubscribeMutations } = createAtlasStore();
    const p = { projectId: 'p', includeArchived: true };
    const first = store.dispatch(atlasApi.endpoints.getProject.initiate(p));
    const duplicate = store.dispatch(atlasApi.endpoints.getProject.initiate(p));
    expect((await first.unwrap()).name).toBe('p');
    await duplicate.unwrap();
    first.unsubscribe(); duplicate.unsubscribe();
    const revisit = store.dispatch(atlasApi.endpoints.getProject.initiate(p));
    expect((await revisit.unwrap()).name).toBe('p');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const other = store.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'q', includeArchived: true }));
    expect((await other.unwrap()).name).toBe('q');
    expect(fetcher).toHaveBeenCalledTimes(2);
    revisit.unsubscribe(); other.unsubscribe(); unsubscribeMutations();
});

test('a representative two-project section flow makes six requests', async () => {
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
        const name = url.split('/').pop();
        const input = JSON.parse(String(options.body));
        return response(name === 'get_project' ? { id: input.projectId, name: input.projectId } : []);
    });
    vi.stubGlobal('fetch', fetcher);
    const { store, unsubscribeMutations } = createAtlasStore();
    const requests: Array<{ unsubscribe: () => void }> = [];
    const visit = async <T extends { unsubscribe: () => void; unwrap: () => Promise<unknown> }>(request: T) => { requests.push(request); await request.unwrap(); };
    await visit(store.dispatch(atlasApi.endpoints.listProjects.initiate({ includeArchived: false }))); // sidebar
    await visit(store.dispatch(atlasApi.endpoints.listProjects.initiate({ includeArchived: false }))); // listing
    await visit(store.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'p', includeArchived: true })));
    await visit(store.dispatch(atlasApi.endpoints.listViews.initiate({ projectId: 'p', includeArchived: true })));
    await visit(store.dispatch(atlasApi.endpoints.listStores.initiate({ projectId: 'p', includeArchived: true })));
    await visit(store.dispatch(atlasApi.endpoints.listViews.initiate({ projectId: 'p', includeArchived: true })));
    await visit(store.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'q', includeArchived: true })));
    await visit(store.dispatch(atlasApi.endpoints.listViews.initiate({ projectId: 'q', includeArchived: true })));
    await visit(store.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'p', includeArchived: true })));
    expect(fetcher).toHaveBeenCalledTimes(6);
    requests.forEach(request => request.unsubscribe()); unsubscribeMutations();
});

test('manual refresh and failed background revalidation keep the last usable project', async () => {
    let version = 0;
    const fetcher = vi.fn(async () => ++version === 3 ? response({ message: 'offline' }, false) : response({ id: 'p', name: `version ${version}` }));
    vi.stubGlobal('fetch', fetcher);
    const { store, unsubscribeMutations } = createAtlasStore();
    const arg = { projectId: 'p' };
    const mounted = store.dispatch(atlasApi.endpoints.getProject.initiate(arg));
    await mounted.unwrap();
    const refreshed = store.dispatch(atlasApi.endpoints.getProject.initiate(arg, { forceRefetch: true }));
    expect(store.getState().atlasApi.queries[refreshed.queryCacheKey]?.data).toMatchObject({ name: 'version 1' });
    await refreshed.unwrap();
    expect(store.getState().atlasApi.queries[refreshed.queryCacheKey]?.data).toMatchObject({ name: 'version 2' });
    const failed = store.dispatch(atlasApi.endpoints.getProject.initiate(arg, { forceRefetch: true }));
    await expect(failed.unwrap()).rejects.toBeTruthy();
    expect(store.getState().atlasApi.queries[failed.queryCacheKey]?.data).toMatchObject({ name: 'version 2' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    mounted.unsubscribe(); refreshed.unsubscribe(); failed.unsubscribe(); unsubscribeMutations();
});

test('a record write invalidates its store and project View previews only', async () => {
    const counts = new Map<string, number>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const name = url.split('/').pop()!;
        counts.set(name, (counts.get(name) ?? 0) + 1);
        return response(name === 'list_records' ? { items: [], total: 0, limit: 25, offset: 0 } : name === 'list_projects' ? [] : { runtimeId: 'r' });
    }));
    const { store, unsubscribeMutations } = createAtlasStore();
    const projects = store.dispatch(atlasApi.endpoints.listProjects.initiate({ includeArchived: false }));
    const records = store.dispatch(atlasApi.endpoints.listRecords.initiate({ projectId: 'p', storeId: 's', limit: 25, offset: 0 }));
    const otherRecords = store.dispatch(atlasApi.endpoints.listRecords.initiate({ projectId: 'q', storeId: 's', limit: 25, offset: 0 }));
    const preview = store.dispatch(atlasApi.endpoints.renderView.initiate({ projectId: 'p', viewId: 'v', params: {} }));
    await Promise.all([projects, records, otherRecords, preview]);
    await callTool('create_record', { projectId: 'p', storeId: 's', data: {} });
    await Promise.all([store.dispatch(atlasApi.endpoints.listRecords.initiate({ projectId: 'p', storeId: 's', limit: 25, offset: 0 })), store.dispatch(atlasApi.endpoints.renderView.initiate({ projectId: 'p', viewId: 'v', params: {} }))]);
    expect(counts.get('list_records')).toBe(3); // p twice, q once
    expect(counts.get('render_view')).toBe(2);
    expect(counts.get('list_projects')).toBe(1);
    projects.unsubscribe(); records.unsubscribe(); otherRecords.unsubscribe(); preview.unsubscribe(); unsubscribeMutations();
});

test('RTK project mutations refresh the sidebar and affected project only', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
        const name = url.split('/').pop()!;
        const input = JSON.parse(String(options.body));
        calls.push(`${name}:${input.projectId ?? 'all'}`);
        return response(name === 'list_projects' ? [] : { id: input.projectId, name: 'Project' });
    }));
    const { store, unsubscribeMutations } = createAtlasStore();
    const projects = store.dispatch(atlasApi.endpoints.listProjects.initiate({ includeArchived: false }));
    const p = store.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'p' }));
    const q = store.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'q' }));
    await Promise.all([projects, p, q]);
    await store.dispatch(atlasApi.endpoints.mutate.initiate({ name: 'update_project', input: { projectId: 'p', name: 'Renamed' } })).unwrap();
    await Promise.all([store.dispatch(atlasApi.endpoints.listProjects.initiate({ includeArchived: false })), store.dispatch(atlasApi.endpoints.getProject.initiate({ projectId: 'p' }))]);
    expect(calls.filter(call => call === 'list_projects:all')).toHaveLength(2);
    expect(calls.filter(call => call === 'get_project:p')).toHaveLength(2);
    expect(calls.filter(call => call === 'get_project:q')).toHaveLength(1);
    projects.unsubscribe(); p.unsubscribe(); q.unsubscribe(); unsubscribeMutations();
});

test('omitted archived flag shares a key and session retention survives hours without subscribers', async () => {
    const fetcher = vi.fn(async () => response({ id:'p', name:'Cached' }));
    vi.stubGlobal('fetch',fetcher);
    const {store,unsubscribeMutations}=createAtlasStore();
    try {
        const first=store.dispatch(atlasApi.endpoints.getProject.initiate({projectId:'p'}));
        await first.unwrap();first.unsubscribe();
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(3*60*60*1000);
        const second=store.dispatch(atlasApi.endpoints.getProject.initiate({projectId:'p',includeArchived:false}));
        expect(await second.unwrap()).toMatchObject({name:'Cached'});
        expect(fetcher).toHaveBeenCalledTimes(1);
        second.unsubscribe();
        vi.useRealTimers();
        const refresh=store.dispatch(atlasApi.endpoints.getProject.initiate({projectId:'p'}, {forceRefetch:true}));
        await refresh.unwrap();expect(fetcher).toHaveBeenCalledTimes(2);refresh.unsubscribe();
    } finally { vi.useRealTimers();store.dispatch(atlasApi.util.resetApiState());unsubscribeMutations(); }
});

test('application reads deduplicate and portfolio mutations leave other applications cached', async () => {
    const calls:string[]=[];
    vi.stubGlobal('fetch', vi.fn(async(url:string)=>{calls.push(url.split('/').pop()!);return response([])}));
    const {store,unsubscribeMutations}=createAtlasStore();
    const arg={name:'list_portfolio_entries' as const,input:{}};
    const one=store.dispatch(atlasApi.endpoints.applicationRead.initiate(arg));
    const two=store.dispatch(atlasApi.endpoints.applicationRead.initiate(arg));
    const other=store.dispatch(atlasApi.endpoints.applicationRead.initiate({name:'list_applications',input:{projectId:'other'}}));
    await Promise.all([one,two,other]);
    expect(calls.filter(x=>x==='list_portfolio_entries')).toHaveLength(1);
    await callTool('restore_portfolio_revision',{recordId:'record',revisionId:'revision'});
    await store.dispatch(atlasApi.endpoints.applicationRead.initiate(arg));
    expect(calls.filter(x=>x==='list_portfolio_entries')).toHaveLength(2);
    expect(calls.filter(x=>x==='list_applications')).toHaveLength(1);
    one.unsubscribe();two.unsubscribe();other.unsubscribe();store.dispatch(atlasApi.util.resetApiState());unsubscribeMutations();
});
