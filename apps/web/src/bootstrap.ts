import { atlasApi } from './atlasApi';
import { getToolRequestCount } from './api';
import type { AppDispatch } from './store';
import type { Project } from './types';

export const BOOTSTRAP_CONCURRENCY = 4;
export type BootstrapTask = { endpoint: 'getProject' | 'listStores' | 'listViews'; projectId: string };
export type BootstrapProgress = { completed: number; total: number | null; activeProjects: number; failed: number };
export type BootstrapMetrics = { durationMs: number; requestCount: number; activeProjects: number; completed: number; total: number; failed: number };
export type BootstrapResult = { projects?: Project[]; failedTasks: BootstrapTask[]; listError?: string; metrics: BootstrapMetrics };

let latestMetrics: BootstrapMetrics | undefined;
export const getBootstrapMetrics = () => latestMetrics;

function message(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error) return String(error.message);
    return String(error);
}

function tasksFor(projects: Project[]): BootstrapTask[] {
    return projects.filter(project => !project.archivedAt).flatMap(project => [
        { endpoint: 'getProject', projectId: project.id },
        { endpoint: 'listStores', projectId: project.id },
        { endpoint: 'listViews', projectId: project.id },
    ] as BootstrapTask[]);
}

type BootstrapSubscription = { unsubscribe: () => void; unwrap: () => Promise<unknown> };
// Hold one subscription per essential query for the lifetime of this app session.
// The WeakMap also isolates standalone stores used by tests.
const subscriptions = new WeakMap<AppDispatch, Map<string, BootstrapSubscription>>();
function retained(dispatch: AppDispatch) {
    let map = subscriptions.get(dispatch);
    if (!map) { map = new Map(); subscriptions.set(dispatch, map); }
    return map;
}

/** Explicit cleanup for tests or an intentionally restarted bootstrap. */
export function releaseBootstrapSubscriptions(dispatch: AppDispatch): void {
    const entries = subscriptions.get(dispatch);
    entries?.forEach(request => request.unsubscribe());
    entries?.clear();
    subscriptions.delete(dispatch);
}

async function retain<T>(dispatch: AppDispatch, key: string, start: () => BootstrapSubscription): Promise<T> {
    const entries = retained(dispatch);
    const previous = entries.get(key);
    if (previous) return await previous.unwrap() as T;
    const request = start();
    entries.set(key, request);
    try { return await request.unwrap() as T; }
    catch (error) {
        // Never pin a failed request; a retry should actually send another HTTP call.
        if (entries.get(key) === request) entries.delete(key);
        request.unsubscribe();
        throw error;
    }
}

async function fetchTask(dispatch: AppDispatch, task: BootstrapTask, forceRefetch: boolean): Promise<void> {
    const arg = { projectId: task.projectId, includeArchived: true };
    const key = `${task.endpoint}:${task.projectId}`;
    const options = { subscribe: true, forceRefetch };
    switch (task.endpoint) {
        case 'getProject': await retain(dispatch, key, () => dispatch(atlasApi.endpoints.getProject.initiate(arg, options))); break;
        case 'listStores': await retain(dispatch, key, () => dispatch(atlasApi.endpoints.listStores.initiate(arg, options))); break;
        case 'listViews': await retain(dispatch, key, () => dispatch(atlasApi.endpoints.listViews.initiate(arg, options))); break;
    }
}

/** Bootstraps and pins essential project queries with at most four requests in flight. */
export async function preloadProjects(
    dispatch: AppDispatch,
    onProgress: (progress: BootstrapProgress) => void,
    shouldStop: () => boolean = () => false,
    retryTasks?: BootstrapTask[],
): Promise<BootstrapResult> {
    const start = performance.now();
    const startRequests = getToolRequestCount();
    let completed = 0;
    let projects: Project[] | undefined;
    let tasks = retryTasks;
    const failedTasks: BootstrapTask[] = [];
    onProgress({ completed: 0, total: retryTasks ? retryTasks.length : null, activeProjects: 0, failed: 0 });

    if (!tasks) {
        try {
            projects = await retain<Project[]>(dispatch, 'listProjects:active', () => dispatch(atlasApi.endpoints.listProjects.initiate({ includeArchived: false }, { subscribe: true })));
        } catch (error) {
            const metrics = { durationMs: performance.now() - start, requestCount: getToolRequestCount() - startRequests, activeProjects: 0, completed: 1, total: 1, failed: 1 };
            latestMetrics = metrics;
            onProgress({ completed: 1, total: 1, activeProjects: 0, failed: 1 });
            return { failedTasks, listError: message(error), metrics };
        }
        completed = 1;
        tasks = tasksFor(projects);
    }

    const total = completed + tasks.length;
    const activeProjects = projects?.filter(project => !project.archivedAt).length ?? new Set(tasks.map(task => task.projectId)).size;
    onProgress({ completed, total, activeProjects, failed: 0 });
    let cursor = 0;
    const worker = async () => {
        while (!shouldStop() && cursor < tasks.length) {
            const task = tasks[cursor++];
            try { await fetchTask(dispatch, task, !!retryTasks); }
            catch { failedTasks.push(task); }
            completed++;
            onProgress({ completed, total, activeProjects, failed: failedTasks.length });
        }
    };
    await Promise.all(Array.from({ length: Math.min(BOOTSTRAP_CONCURRENCY, tasks.length) }, worker));
    const metrics = { durationMs: performance.now() - start, requestCount: getToolRequestCount() - startRequests, activeProjects, completed, total, failed: failedTasks.length };
    latestMetrics = metrics;
    return { projects, failedTasks, metrics };
}
