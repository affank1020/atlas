import type { CoreService } from '../core/service.js';
import type { ViewService } from '../views/service.js';
import type { RetrievalService } from '../retrieval/service.js';
import type { ApplicationRegistry } from '../apps/registry.js';
import type { NodeService } from '../nodes/service.js';
import type { Project } from '../types.js';
import { z } from 'zod';

export const globalSearchInput = z.object({
    query: z.string().trim().min(1).max(240),
    limit: z.number().int().min(1).max(60).default(40),
});

export type GlobalSearchKind = 'project' | 'application' | 'view' | 'store' | 'record' | 'workspace' | 'node';
export type GlobalSearchHit = {
    id: string;
    kind: GlobalSearchKind;
    title: string;
    description: string;
    context: string;
    href: string;
    score: number;
    action?: { type: 'read_node_logs'; nodeId: string; source: 'stdout' | 'stderr'; lines: number };
};
export type GlobalSearchResponse = {
    query: string;
    results: GlobalSearchHit[];
    incomplete: string[];
};
type SearchDeps = Pick<CoreService, 'listProjects' | 'listStores'> & { views: Pick<ViewService, 'listViews'>; retrieval: Pick<RetrievalService, 'search'>; applications: Pick<ApplicationRegistry, 'list'>; nodes?: Pick<NodeService, 'call'> };

const snippet = (value: unknown, max = 150) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
function relevance(query: string, title: string, description = '', context = '') {
    const q = query.toLocaleLowerCase();
    const name = title.toLocaleLowerCase();
    const detail = (description + ' ' + context).toLocaleLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    if (!terms.every(term => name.includes(term) || detail.includes(term))) return 0;
    if (name === q) return 120;
    if (name.startsWith(q)) return 100;
    if (name.includes(q)) return 85;
    if (terms.every(term => name.includes(term))) return 73;
    return 48;
}
const makeHit = (query: string, input: Omit<GlobalSearchHit, 'score'>) => ({
    ...input,
    description: snippet(input.description),
    score: relevance(query, input.title, input.description, input.context),
});
type Intent = GlobalSearchKind | 'activity' | 'infrastructure' | null;
const commandWords = new Set([
    'i','want','to','do','can','you','please','show','me','my','the','a','an','all',
    'find','look','for','search','open','go','navigate','launch','run','view','see',
    'check','inspect','showing','about','in','on','of','from','with','particular',
    'some','specific','get','take','bring','up','recent','latest','last','tail','read','status','details',
    'application','applications','apps','app','project','projects','view','views',
    'data','store','stores','record','records','node','nodes','workspace','workspaces',
    'logs','log','activity','events','history','server','infrastructure', 'lines', 'line', 'error', 'errors', 'stderr', 'stdout'
]);
export function interpretSearch(query: string): { term: string; intent: Intent; nodeActivity: boolean; nodeLogs: boolean; logSource: 'stdout' | 'stderr'; logLines: number } {
    const lower = query.toLocaleLowerCase();
    // "journal" may be a document title, not operational output. Only interpret
    // journal/systemd vocabulary as logs when a Node/runtime or explicit log
    // context is present; systemd service/unit by itself is not a log request.\n    // Preserve these terms for general Fabric searches.
    const nodeContext = /\b(nodes?|mac|macbook|linux|windows|runtime|host)\b/.test(lower);
    const journalContext = /\b(?:journal|systemd)\b/.test(lower) &&
        (nodeContext || /\b(?:journal|systemd)\s+(?:logs?|lines?|output)\b|\b(?:logs?|tail)\s+(?:journal|systemd)\b/.test(lower));
    const nodeLogs = /\b(logs?|stderr|stdout)\b|\berror\s+(?:lines?|output)\b/.test(lower) || journalContext;
    const logSource = /\b(stderr|errors?|error\s+logs?)\b/.test(lower) ? 'stderr' as const : 'stdout' as const;
    const requestedLines = /\b(\d{1,3})\s*(?:(?:errors?|stdout|stderr|journal|systemd)\s*)?lines?\b/.exec(lower)?.[1];
    const logLines = requestedLines ? Math.min(Math.max(Number(requestedLines), 1), 200) : 100;
    const nodeActivity = (nodeLogs || /\b(activity|events?|history)\b/.test(lower)) && nodeContext;
    const intent: Intent = nodeActivity || nodeLogs ? 'node'
        : /\b(apps?|applications?|launch)\b/.test(lower) ? 'application'
        : /\bworkspaces?\b/.test(lower) ? 'workspace'
        : /\bnodes?|macbook|linux\b/.test(lower) ? 'node'
        : /\bprojects?\b/.test(lower) ? 'project'
        : /\bviews?\b/.test(lower) ? 'view'
        : /\bstores?\b/.test(lower) ? 'store'
        : /\brecords?\b/.test(lower) ? 'record'
        : /\blogs?|activity|events?|history\b/.test(lower) ? 'activity'
        : /\bservers?|infrastructure|health\b/.test(lower) ? 'infrastructure'
        : /\bdata\b/.test(lower) ? 'store' : null;
    const term = lower.replace(/\b\d{1,3}\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ')
        .filter(word => word && !commandWords.has(word) && !(nodeLogs && (word === 'journal' || word === 'systemd'))).join(' ').trim();
    return { term, intent, nodeActivity, nodeLogs, logSource, logLines };
}

const nodeDescription = (node: { platform?: string; status?: string; hostedWorkspaceCount?: number }) =>
    [node.platform || 'Remote', node.status || 'Unknown', String(node.hostedWorkspaceCount ?? 0) + ' workspaces'].join(' · ');

/** Federates catalogue navigation and Fabric's indexed record search.
 * This endpoint does not search private Node files or execute any mutation.
 * Partial failures are surfaced instead of turning unavailable sources into "no results".
 */
export async function searchEverywhere(deps: SearchDeps, raw: z.input<typeof globalSearchInput>): Promise<GlobalSearchResponse> {
    const { query, limit } = globalSearchInput.parse(raw);
    const { term, intent, nodeActivity, nodeLogs, logSource, logLines } = interpretSearch(query);
    const lookup = term || (intent ? '' : query.trim());
    const hits: GlobalSearchHit[] = [];
    const incomplete: string[] = [];
    const add = (hit: Omit<GlobalSearchHit, 'score'>) => {
        if (intent && intent !== 'activity' && intent !== 'infrastructure' && intent !== hit.kind) return;
        const scored = { ...makeHit(lookup || query, hit), score: lookup ? relevance(lookup, hit.title, hit.description, hit.context) : (intent ? 45 : 0) };
        if (scored.score) hits.push(scored);
    };
    if (intent === 'activity') hits.push({ kind: 'node', id: 'atlas-activity', title: 'View Atlas activity', description: 'Recent recorded operations across Atlas', context: 'Activity', href: '#/monitoring?tab=activity', score: 135 });
    if (intent === 'infrastructure') hits.push({ kind: 'node', id: 'atlas-infrastructure', title: 'Inspect Atlas Server', description: 'Server connectivity, registered nodes and health overview', context: 'Infrastructure', href: '#/monitoring?tab=overview', score: 135 });

    const [catalogue, records, nodes] = await Promise.allSettled([
        intent === 'node' ? Promise.resolve([] as Project[]) : deps.listProjects(false),
        (lookup && (!intent || ['record', 'store', 'project'].includes(intent)) ? deps.retrieval.search({ query: lookup, limit: Math.min(limit, 40), mode: 'lexical' }) : Promise.resolve({ results: [] })),
        deps.nodes?.call('list_nodes', {}),
    ]);

    if (catalogue.status === 'fulfilled') {
        const projects = catalogue.value as Project[];
        for (const project of projects) {
            add({ kind: 'project', id: project.id, title: project.name, description: project.description ?? '', context: 'Projects', href: '#/projects/' + project.id });
            for (const app of deps.applications.list(project.id)) {
                add({ kind: 'application', id: project.id + '/' + app.slug, title: app.name, description: app.description, context: project.name, href: '#/projects/' + project.id + '/applications/' + app.slug });
            }
        }
        const collections = await Promise.allSettled(projects.map(async project => {
            const [stores, views] = await Promise.allSettled([deps.listStores(project.id, false), deps.views.listViews(project.id, false)]);
            return { project, stores, views };
        }));
        for (const result of collections) {
            if (result.status === 'rejected') { incomplete.push('Project collections'); continue; }
            const { project, stores, views } = result.value;
            if (stores.status === 'fulfilled') for (const store of stores.value) {
                add({ kind: 'store', id: store.id, title: store.name, description: store.description ?? '', context: project.name, href: '#/projects/' + project.id + '/stores/' + store.id + '/records' });
            } else incomplete.push('Stores · ' + project.name);
            if (views.status === 'fulfilled') for (const view of views.value) {
                add({ kind: 'view', id: view.id, title: view.name, description: view.description ?? '', context: project.name, href: '#/projects/' + project.id + '/views/' + view.id });
            } else incomplete.push('Views · ' + project.name);
        }
    } else incomplete.push('Projects and applications');

    if (records.status === 'fulfilled') {
        for (const result of records.value.results) {
            const label = ['title', 'name', 'subject', 'company'].map(key => result.record.data[key]).find(value => typeof value === 'string' && value.trim());
            const title = typeof label === 'string' ? snippet(label, 110) : result.store.name + ' record';
            const description = snippet(result.snippet, 180);
            // Fabric has already selected these records for this query. Don't
            // require the display label to match as well.
            hits.push({
                kind: 'record', id: result.record.id, title, description,
                context: result.project.name + ' / ' + result.store.name,
                href: '#/projects/' + result.project.id + '/stores/' + result.store.id + '/records',
                score: 25 + Math.min(result.score, 15),
            });
        }
    } else incomplete.push('Record contents');

    if (nodes.status === 'fulfilled' && Array.isArray(nodes.value)) {
        const list = nodes.value as Array<{ id: string; name: string; platform?: string; status?: string; hostedWorkspaceCount?: number }>;
        for (const node of list) {
            if (nodeActivity) {
                const logAvailable = nodeLogs && (node as { capabilities?: string[] }).capabilities?.includes('node.logs') && node.status === 'online';
                const selectedLogSource = node.platform === 'linux' ? 'journal' : logSource;
                const hit = makeHit(lookup || query, {
                    kind: 'node', id: node.id,
                    title: logAvailable ? 'Read ' + node.name + ' ' + (selectedLogSource === 'journal' ? 'journal' : logSource === 'stderr' ? 'error logs' : 'logs') : 'Inspect ' + node.name + ' activity',
                    description: logAvailable ? 'Latest ' + logLines + ' lines · ' + (selectedLogSource === 'journal' ? 'systemd journal' : logSource === 'stderr' ? 'stderr' : 'stdout') : 'Recent operations · raw logs unavailable until the Node supports log access',
                    context: node.name + ' / ' + nodeDescription(node),
                    href: nodeLogs ? '#/monitoring?tab=logs&nodeId=' + encodeURIComponent(node.id) + '&source=' + selectedLogSource + '&lines=' + logLines : '#/monitoring?tab=activity&nodeId=' + encodeURIComponent(node.id),
                });
                if (!lookup || relevance(lookup, node.name, nodeDescription(node))) hits.push({ ...hit, score: 120 + relevance(lookup, node.name, nodeDescription(node)) });
            } else {
                add({ kind: 'node', id: node.id, title: node.name, description: nodeDescription(node), context: 'Infrastructure / Nodes', href: '#/nodes?node=' + encodeURIComponent(node.id) });
            }
        }
        const details = !nodeLogs ? await Promise.allSettled(list.map(node => deps.nodes!.call('get_node', { nodeId: node.id }))) : [];
        for (let index = 0; index < details.length; index++) {
            const detail = details[index];
            if (detail.status === 'rejected') { incomplete.push('Workspaces · ' + list[index].name); continue; }
            const hosted = detail.value as { workspaces?: Array<{ id: string; projectId: string; name: string }> };
            for (const workspace of hosted.workspaces ?? []) {
                add({
                    kind: 'workspace', id: workspace.id, title: workspace.name,
                    description: 'Hosted on ' + list[index].name, context: 'Workspaces / ' + list[index].name,
                    href: '#/projects/' + workspace.projectId + '/workspaces',
                });
            }
        }
    } else if (deps.nodes) incomplete.push('Nodes and workspaces');


    const priority: Record<GlobalSearchKind, number> = { project: 0, application: 1, view: 2, store: 3, workspace: 4, node: 5, record: 6 };
    hits.sort((a, b) => b.score - a.score || priority[a.kind] - priority[b.kind] || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return { query, results: hits.slice(0, limit), incomplete: [...new Set(incomplete)] };
}
