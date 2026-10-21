import { createApi, fakeBaseQuery, defaultSerializeQueryArgs } from '@reduxjs/toolkit/query/react';
import { callTool, type ToolMutation } from './api';
import type { AtlasStatus, AtlasRecord, AuditEvent, Page, Project, Store, View, ViewRenderResult } from './types';

export type StorageUsage = {
    postgres: { state: 'ready' | 'unavailable'; measuredAt?: string; databaseBytes?: number; tableBytes?: number; indexBytes?: number; tableCount?: number;
        tables?: { schema: string; name: string; tableBytes: number; indexBytes: number; totalBytes: number }[] };
    r2: { state: 'ready' | 'not_configured' | 'unavailable'; bucket?: string; measuredAt?: string; refreshedAt?: string;
        storageBytes?: number; objectCount?: number; classA?: number; classB?: number; otherOperations?: number; monthStart?: string;
        accountWideOperations?: boolean; storageAllowanceBytes: number; classAAllowance: number; classBAllowance: number };
};
type ProjectScope = { projectId: string; includeArchived?: boolean };
type StoreScope = ProjectScope & { storeId: string };
type RecordScope = StoreScope & { limit: number; offset: number };
type ViewScope = ProjectScope & { viewId: string };
type RenderScope = ViewScope & { params: Record<string, string> };
type Tag = { type: 'ApplicationData' | 'Projects' | 'Project' | 'Stores' | 'Store' | 'Records' | 'Views' | 'View' | 'ViewRender'; id: string };
export type AtlasMutation = ToolMutation;
const tag = (type: Tag['type'], id: string): Tag => ({ type, id });
const scoped = (projectId: string, id: string) => `${projectId}/${id}`;
const projectScope = (projectId: string) => `project:${projectId}`;

/** Explicit dependencies keep writes within their project or store. */
export function mutationTags({ name, input }: AtlasMutation): Tag[] {
    if (name.includes('portfolio')) return [tag('ApplicationData', 'portfolio')];
    // Files retains the owner list across navigation. Every operation that can
    // add, rename, move or retire a Workspace must invalidate that cached list.
    if (['create_workspace', 'update_workspace', 'archive_workspace', 'link_workspace_project', 'unlink_workspace_project',
        'assign_workspace_node', 'workspace_git_clone_repository', 'workspace_git_create_worktree',
        'workspace_git_remove_worktree'].includes(name)) return [tag('ApplicationData', 'workspaces')];
    const projectId = String(input.projectId ?? '');
    const storeId = String(input.storeId ?? '');
    const viewId = String(input.viewId ?? '');
    if (/_project$/.test(name)) return [tag('Projects', 'LIST'), ...(projectId ? [tag('Project', projectId), tag('ApplicationData', projectId), tag('Stores', projectId), tag('Views', projectId), tag('Records', projectScope(projectId)), tag('ViewRender', projectScope(projectId))] : [])];
    if (/_store$|_store_schema$/.test(name)) return [tag('Projects', 'LIST'), tag('Stores', projectId), ...(storeId ? [tag('Store', scoped(projectId, storeId)), tag('Records', scoped(projectId, storeId))] : []), tag('ViewRender', projectScope(projectId))];
    if (/_record$|_records$/.test(name)) return [tag('Projects', 'LIST'), tag('Records', scoped(projectId, storeId)), tag('ViewRender', projectScope(projectId))];
    if (/_view$/.test(name)) return [tag('Projects', 'LIST'), tag('Views', projectId), ...(viewId ? [tag('View', scoped(projectId, viewId)), tag('ViewRender', scoped(projectId, viewId))] : [])];
    if (name === 'execute_view_action') return [tag('ViewRender', projectScope(projectId)), tag('ViewRender', scoped(projectId, viewId)), tag('Records', projectScope(projectId))];
    return [];
}

async function read<T>(name: string, input: Record<string, unknown>, signal: AbortSignal) {
    try { return { data: await callTool<T>(name, input, signal) }; }
    catch (error) { return { error: { message: error instanceof Error ? error.message : String(error) } }; }
}

export const atlasApi = createApi({
    reducerPath: 'atlasApi',
    baseQuery: fakeBaseQuery<{ message: string }>(),
    tagTypes: ['ApplicationData', 'Projects', 'Project', 'Stores', 'Store', 'Records', 'Views', 'View', 'ViewRender'],
    // Session-scoped browsing: loaded responses remain in Redux until the browser
    // reloads. Explicit Refresh and successful writes are the freshness triggers.
    keepUnusedDataFor: Infinity,
    serializeQueryArgs: args => {
        const queryArgs = args.queryArgs as Record<string, unknown>;
        return defaultSerializeQueryArgs({ ...args, queryArgs: ['listProjects','getProject','listStores','getStore','listRecords','listViews','getView'].includes(args.endpointName) ? { ...queryArgs, includeArchived: queryArgs.includeArchived ?? false } : queryArgs });
    },
    refetchOnMountOrArgChange: false,
    refetchOnFocus: false,
    refetchOnReconnect: false,
    endpoints: build => ({
        workspaceStatus: build.query<AtlasStatus, void>({
            queryFn: (_arg, api) => read<AtlasStatus>('get_atlas_status', {}, api.signal),
        }),
        storageUsage: build.query<StorageUsage, { refreshToken: number }>({
            queryFn: ({ refreshToken }, api) => read<StorageUsage>('get_storage_usage', { refresh: refreshToken > 0 }, api.signal),
        }),
        workspaceNodes: build.query<import('./Nodes').AtlasNode[], void>({
            queryFn: (_arg, api) => read<import('./Nodes').AtlasNode[]>('list_nodes', {}, api.signal),
        }),
        applicationRead: build.query<unknown, { name: ApplicationReadName; input: Record<string, unknown> }>({
            queryFn: ({ name, input }, api) => read(name, input, api.signal),
            providesTags: (_result, _error, { name, input }) => [tag('ApplicationData', name === 'list_workspaces' ? 'workspaces' : name.includes('portfolio') ? 'portfolio' : String(input.projectId ?? 'football'))],
        }),
        listProjects: build.query<Project[], { includeArchived?: boolean; withMetrics?: boolean }>({
            queryFn: (arg, api) => read<Project[]>('list_projects', arg, api.signal),
            providesTags: result => [tag('Projects', 'LIST'), ...(result ?? []).map(project => tag('Project', project.id))],
        }),
        getProject: build.query<Project, ProjectScope>({
            queryFn: (arg, api) => read<Project>('get_project', arg, api.signal),
            providesTags: (_result, _error, arg) => [tag('Project', arg.projectId)],
        }),
        listStores: build.query<Store[], ProjectScope>({
            queryFn: (arg, api) => read<Store[]>('list_stores', arg, api.signal),
            providesTags: (result, _error, arg) => [tag('Stores', arg.projectId), ...(result ?? []).map(store => tag('Store', scoped(arg.projectId, store.id)))],
        }),
        getStore: build.query<Store, StoreScope>({
            queryFn: (arg, api) => read<Store>('get_store', arg, api.signal),
            providesTags: (_result, _error, arg) => [tag('Store', scoped(arg.projectId, arg.storeId)), tag('Project', arg.projectId)],
        }),
        listRecords: build.query<Page<AtlasRecord>, RecordScope>({
            queryFn: (arg, api) => read<Page<AtlasRecord>>('list_records', arg, api.signal),
            providesTags: (_result, _error, arg) => [tag('Records', scoped(arg.projectId, arg.storeId)), tag('Records', projectScope(arg.projectId))],
        }),
        listViews: build.query<View[], ProjectScope>({
            queryFn: (arg, api) => read<View[]>('list_views', arg, api.signal),
            providesTags: (result, _error, arg) => [tag('Views', arg.projectId), ...(result ?? []).map(view => tag('View', scoped(arg.projectId, view.id)))],
        }),
        getView: build.query<View, ViewScope>({
            queryFn: (arg, api) => read<View>('get_view', arg, api.signal),
            providesTags: (_result, _error, arg) => [tag('View', scoped(arg.projectId, arg.viewId)), tag('Project', arg.projectId)],
        }),
        getViewHistory: build.query<AuditEvent[], ViewScope>({
            queryFn: (arg, api) => read<AuditEvent[]>('get_view_history', arg, api.signal),
            providesTags: (_result, _error, arg) => [tag('View', scoped(arg.projectId, arg.viewId)), tag('Project', arg.projectId)],
        }),
        renderView: build.query<ViewRenderResult, RenderScope>({
            queryFn: (arg, api) => read<ViewRenderResult>('render_view', arg, api.signal),
            providesTags: (_result, _error, arg) => [tag('ViewRender', scoped(arg.projectId, arg.viewId)), tag('ViewRender', projectScope(arg.projectId))],
        }),
        mutate: build.mutation<unknown, AtlasMutation>({
            queryFn: async ({ name, input }) => {
                try { return { data: await callTool(name, input, undefined, false) }; }
                catch (error) { return { error: { message: error instanceof Error ? error.message : String(error) } }; }
            },
            invalidatesTags: (_result, error, mutation) => error ? [] : mutationTags(mutation),
        }),
    }),
});

export const { useWorkspaceStatusQuery, useStorageUsageQuery, useWorkspaceNodesQuery, useApplicationReadQuery, useListProjectsQuery, useGetProjectQuery, useListStoresQuery, useGetStoreQuery,
    useListRecordsQuery, useListViewsQuery, useGetViewQuery, useGetViewHistoryQuery, useRenderViewQuery, useMutateMutation } = atlasApi;

export function useAtlasMutation() {
    const [mutate] = useMutateMutation();
    return <T = unknown>(name: string, input: Record<string, unknown>) => mutate({ name, input }).unwrap() as Promise<T>;
}

// Explicit allowlist: operational commands can never accidentally enter this cache.
export type ApplicationReadName = 'list_applications' | 'list_all_applications' | 'get_application' | 'list_workspaces' |
    'get_portfolio_schemas' | 'list_portfolio_entries' | 'get_portfolio_dashboard' | 'list_portfolio_media' | 'list_portfolio_revisions' |
    'football_generalist_manifest' | 'football_generalist_runs' | 'football_generalist_policies' | 'football_generalist_activity' | 'football_generalist_assessments';
export function useApplicationRead<T>(name: ApplicationReadName, input: Record<string, unknown> = {}, live = false, skip = false) {
    const query = useApplicationReadQuery({ name, input }, { refetchOnMountOrArgChange: live, skip });
    return { ...query, isLoading: query.isFetching && query.currentData === undefined, data: query.currentData as T | undefined };
}
