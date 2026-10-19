import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { callTool, type ToolMutation } from './api';
import type { AtlasRecord, Page, Project, Store, View, ViewRenderResult } from './types';

type ProjectScope = { projectId: string; includeArchived?: boolean };
type StoreScope = ProjectScope & { storeId: string };
type RecordScope = StoreScope & { limit: number; offset: number };
type ViewScope = ProjectScope & { viewId: string };
type RenderScope = ViewScope & { params: Record<string, string> };
type Tag = { type: 'Projects' | 'Project' | 'Stores' | 'Store' | 'Records' | 'Views' | 'View' | 'ViewRender'; id: string };
export type AtlasMutation = ToolMutation;
const tag = (type: Tag['type'], id: string): Tag => ({ type, id });
const scoped = (projectId: string, id: string) => `${projectId}/${id}`;
const projectScope = (projectId: string) => `project:${projectId}`;

/** Explicit dependencies keep writes within their project or store. */
export function mutationTags({ name, input }: AtlasMutation): Tag[] {
    const projectId = String(input.projectId ?? '');
    const storeId = String(input.storeId ?? '');
    const viewId = String(input.viewId ?? '');
    if (/_project$/.test(name)) return [tag('Projects', 'LIST'), ...(projectId ? [tag('Project', projectId), tag('Stores', projectId), tag('Views', projectId), tag('Records', projectScope(projectId)), tag('ViewRender', projectScope(projectId))] : [])];
    if (/_store$|_store_schema$/.test(name)) return [tag('Stores', projectId), ...(storeId ? [tag('Store', scoped(projectId, storeId)), tag('Records', scoped(projectId, storeId))] : []), tag('ViewRender', projectScope(projectId))];
    if (/_record$|_records$/.test(name)) return [tag('Records', scoped(projectId, storeId)), tag('ViewRender', projectScope(projectId))];
    if (/_view$/.test(name)) return [tag('Views', projectId), ...(viewId ? [tag('View', scoped(projectId, viewId)), tag('ViewRender', scoped(projectId, viewId))] : []), tag('ViewRender', projectScope(projectId))];
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
    tagTypes: ['Projects', 'Project', 'Stores', 'Store', 'Records', 'Views', 'View', 'ViewRender'],
    // Session-scoped browsing: loaded responses remain in Redux until the browser
    // reloads. Explicit Refresh and successful writes are the freshness triggers.
    keepUnusedDataFor: Infinity,
    refetchOnMountOrArgChange: false,
    refetchOnFocus: false,
    refetchOnReconnect: false,
    endpoints: build => ({
        listProjects: build.query<Project[], { includeArchived?: boolean }>({
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
            providesTags: (_result, _error, arg) => [tag('Store', scoped(arg.projectId, arg.storeId))],
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
            providesTags: (_result, _error, arg) => [tag('View', scoped(arg.projectId, arg.viewId))],
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

export const { useListProjectsQuery, useGetProjectQuery, useListStoresQuery, useGetStoreQuery,
    useListRecordsQuery, useListViewsQuery, useGetViewQuery, useRenderViewQuery, useMutateMutation } = atlasApi;

export function useAtlasMutation() {
    const [mutate] = useMutateMutation();
    return <T = unknown>(name: string, input: Record<string, unknown>) => mutate({ name, input }).unwrap() as Promise<T>;
}
