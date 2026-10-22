import type { AtlasRecord, AtlasStatus, AuditEvent, Page, Project, Store } from './types';
import type { AtlasNode } from './Nodes';

/**
 * Deterministic read-only fixture backend. No network, credentials, or database.
 * IDs and content are deliberately synthetic and must never be presented as live.
 */
const stamp = '2026-10-19T14:00:00.000Z';
const uuid = (group: number, item = 1) => '00000000-0000-4000-8000-' + String(group).padStart(4, '0') + String(item).padStart(8, '0');
const project = (id: number, name: string, description: string): Project =>
    ({ id: uuid(1, id), name, description, createdAt: stamp, updatedAt: stamp });

export const mockProjects: Project[] = [
    project(1, 'Atlas Demo', 'Sample control plane, development workspaces and infrastructure.'),
    project(2, 'Portfolio Demo', 'Sample portfolio content and publishing workflows.'),
    project(3, 'Football Research Demo', 'Example football simulation and experiment data.'),
    project(4, 'University Demo', 'Example module notes and study progress.'),
];

const field = (name: string, type: 'string' | 'number' | 'boolean' = 'string') => ({ name, type });
const store = (projectIndex: number, storeIndex: number, name: string, description: string, fields: ReturnType<typeof field>[]): Store => ({
    id: uuid(2 + projectIndex, storeIndex),
    projectId: mockProjects[projectIndex].id,
    name, description, schema: { version: 1, fields }, createdAt: stamp, updatedAt: stamp,
});
const stores: Store[] = [
    store(0, 1, 'Infrastructure', 'Example machines and services', [field('name'), field('environment'), field('healthy', 'boolean')]),
    store(0, 2, 'Deployments', 'Illustrative release history', [field('service'), field('version'), field('durationSeconds', 'number')]),
    store(1, 1, 'Projects', 'Example portfolio items', [field('title'), field('category'), field('featured', 'boolean')]),
    store(2, 1, 'Experiments', 'Example model evaluations', [field('name'), field('successRate', 'number'), field('episodes', 'number')]),
    store(3, 1, 'Modules', 'Example university learning records', [field('code'), field('topic'), field('complete', 'boolean')]),
];
const data: Record<string, unknown>[][] = [
    [{ name: 'Demo Linux VPS', environment: 'Production-like', healthy: true }, { name: 'Demo MacBook', environment: 'Development', healthy: true }],
    [{ service: 'Atlas web', version: '2.0.0-demo', durationSeconds: 42 }],
    [{ title: 'Atlas', category: 'AI agent tooling', featured: true }, { title: 'EcoPrompt', category: 'Full stack', featured: false }],
    [{ name: 'Dribbling baseline', successRate: 0.78, episodes: 100 }, { name: 'Moving-ball contact', successRate: 0.63, episodes: 100 }],
    [{ code: 'MATH37011', topic: 'Markov chains', complete: true }, { code: 'COMP34111', topic: 'Game-playing agents', complete: false }],
];
const records: AtlasRecord[] = stores.flatMap((entry, storeIndex) =>
    data[storeIndex].map((value, index) => ({ id: uuid(10 + storeIndex, index + 1), projectId: entry.projectId, storeId: entry.id, data: value as Record<string, unknown>, createdAt: stamp, updatedAt: stamp }))
);
const nodeMac = uuid(20, 1);
const nodeLinux = uuid(20, 2);
const nodeAndroidTablet = uuid(20, 3);
const nodeAndroidPhone = uuid(20, 4);
const workspaces = [
    { id: uuid(21, 1), projectId: mockProjects[0].id, nodeId: nodeMac, name: 'Atlas Demo Repo', rootPath: '/demo/atlas', kind: 'generic', adapter: null },
    { id: uuid(21, 2), projectId: mockProjects[2].id, nodeId: nodeMac, name: 'Football Demo', rootPath: '/demo/football', kind: 'unity', adapter: 'unity' },
    { id: uuid(21, 3), projectId: mockProjects[0].id, nodeId: nodeLinux, name: 'Server Demo', rootPath: '/srv/demo', kind: 'generic', adapter: null },
];
const nodes: AtlasNode[] = [
    { id: nodeMac, name: 'Demo MacBook', status: 'online', platform: 'darwin', version: '2.0.0-demo', credentialState: 'active', capabilities: ['workspace.files', 'workspace.git', 'workspace.dev', 'unity'], lastSeen: stamp, hostedWorkspaceCount: 2 },
    // Deliberately disconnected in local mock mode to preview the Home health warning.
    { id: nodeLinux, name: 'Demo Linux VPS', status: 'offline', platform: 'linux', version: '2.0.0-demo', credentialState: 'active', capabilities: ['workspace.files', 'workspace.git'], lastSeen: stamp, hostedWorkspaceCount: 1 },
    // Android fixtures preview future mobile nodes; they are not enrolled runtimes.
    { id: nodeAndroidTablet, name: 'Demo Android Tablet', status: 'online', platform: 'android', deviceType: 'tablet', version: '2.0.0-demo', credentialState: 'active', capabilities: ['workspace.files'], lastSeen: stamp, hostedWorkspaceCount: 0 },
    { id: nodeAndroidPhone, name: 'Demo Android Phone', status: 'online', platform: 'android', deviceType: 'phone', version: '2.0.0-demo', credentialState: 'active', capabilities: ['workspace.files'], lastSeen: stamp, hostedWorkspaceCount: 0 },
];
const activity: AuditEvent[] = [
    { id: uuid(30, 1), occurredAt: stamp, client: 'demo', operation: 'workspace.git_status', projectId: mockProjects[0].id, workspaceId: workspaces[0].id, resulting: { branch: 'demo/main' } },
    { id: uuid(30, 2), occurredAt: stamp, client: 'demo', operation: 'record.created', projectId: mockProjects[3].id, storeId: stores[4].id, recordId: records[records.length - 1].id },
    { id: uuid(30, 3), occurredAt: stamp, client: 'demo', operation: 'project.created', projectId: mockProjects[1].id },
];
const portfolioTypes = ['profile', 'contact', 'projects', 'experience', 'posts', 'collections'] as const;
const portfolioFields: Record<string, ReturnType<typeof field>[]> = {
    profile: [field('firstName'), field('lastName'), field('description')],
    contact: [field('email'), field('label')],
    projects: [field('title'), field('description'), field('category')],
    experience: [field('company'), field('role'), field('description')],
    posts: [field('title'), field('excerpt'), field('body')],
    collections: [field('title'), field('description')],
};
const portfolioEntries = [
    { id: uuid(40, 1), contentType: 'projects', storeId: uuid(41, 1), data: { title: 'Atlas Demo', description: 'A sample infrastructure project, not real portfolio content.', category: 'AI tooling' }, status: 'published', createdAt: stamp, updatedAt: stamp, publishedAt: stamp },
    { id: uuid(40, 2), contentType: 'projects', storeId: uuid(41, 1), data: { title: 'EcoPrompt Demo', description: 'Example browser extension entry.', category: 'Full stack' }, status: 'draft', createdAt: stamp, updatedAt: stamp },
    { id: uuid(40, 3), contentType: 'experience', storeId: uuid(41, 4), data: { company: 'Example Studio', role: 'Software Engineer', description: 'Illustrative placement entry.' }, status: 'published', createdAt: stamp, updatedAt: stamp, publishedAt: stamp },
];
const applications = [
    { type: 'portfolio', slug: 'portfolio', name: 'Portfolio', description: 'Browse sample portfolio records in read-only preview.', projectId: mockProjects[1].id },
    { type: 'football-training', slug: 'football-training', name: 'Football Training', description: 'Explore sample training runs and policies.', projectId: mockProjects[2].id },
];
const status: AtlasStatus = { product: 'Atlas Demo', version: '2.0.0-demo', storage: 'In-memory mock', schemaVersion: 1, projects: mockProjects.length, stores: stores.length, records: records.length };
const str = (value: unknown) => typeof value === 'string' ? value : '';

function page(items: AtlasRecord[], input: Record<string, unknown>): Page<AtlasRecord> {
    const offset = Math.max(0, Number(input.offset) || 0);
    const limit = Math.max(1, Number(input.limit) || 25);
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
}

/** Mirrors the API tool's JSON body so existing hooks and components need no changes. */
export function mockTool<T>(name: string, input: Record<string, unknown> = {}): T {
    const projectId = str(input.projectId);
    const storeId = str(input.storeId);
    const nodeId = str(input.nodeId);
    const workspaceId = str(input.workspaceId);
    // Mirror the public server alias for checkout-oriented reads; audit APIs
    // keep using their existing workspaceId filter.
    const checkoutId = str(input.checkoutId ?? input.workspaceId);
    let result: unknown;
    switch (name) {
        case 'get_atlas_status': result = status; break;
        case 'get_storage_usage': result = {
            postgres: {
                state: 'ready', measuredAt: stamp, databaseBytes: 32_000_000, tableBytes: 19_000_000, indexBytes: 6_000_000,
                tableCount: 3, tables: [
                    { schema: 'public', name: 'records', tableBytes: 12_000_000, indexBytes: 4_000_000, totalBytes: 16_000_000 },
                    { schema: 'public', name: 'stores', tableBytes: 4_000_000, indexBytes: 1_000_000, totalBytes: 5_000_000 },
                    { schema: 'public', name: 'projects', tableBytes: 3_000_000, indexBytes: 1_000_000, totalBytes: 4_000_000 },
                ],
            },
            r2: {
                state: 'ready', bucket: 'atlas-demo', measuredAt: stamp, refreshedAt: stamp,
                storageBytes: 480_000_000, objectCount: 64, classA: 314, classB: 12_400, otherOperations: 0,
                monthStart: stamp.slice(0, 8) + '01T00:00:00Z', accountWideOperations: true,
                storageAllowanceBytes: 10_000_000_000, classAAllowance: 1_000_000, classBAllowance: 10_000_000,
            },
        }; break;
        case 'list_projects':
            result = input.withMetrics ? mockProjects.map(p => ({
                ...p,
                metrics: {
                    stores: stores.filter(s => s.projectId === p.id).length,
                    records: records.filter(r => r.projectId === p.id).length,
                    views: 0,
                    applications: applications.filter(a => a.projectId === p.id).length,
                },
            })) : mockProjects;
            break;
        case 'get_project': result = mockProjects.find(p => p.id === projectId); break;
        case 'list_stores': result = stores.filter(s => s.projectId === projectId); break;
        case 'get_store': result = stores.find(s => s.id === storeId && s.projectId === projectId); break;
        case 'list_records': case 'query_records':
            result = page(records.filter(r => r.projectId === projectId && r.storeId === storeId), input); break;
        case 'list_views': result = []; break;
        case 'list_nodes': result = nodes; break;
        case 'list_node_share_approvals': result = []; break;
        case 'list_node_releases': result = { state: 'ready', releases: [], checkedAt: stamp, source: 'github-releases' }; break;
        case 'list_node_update_intents': result = []; break; // Demo only: no persisted requests or executable update control.
        case 'get_node':
            result = { ...nodes.find(node => node.id === nodeId), workspaces: workspaces.filter(w => w.nodeId === nodeId),
                activity: activity.filter(a => workspaces.some(w => w.nodeId === nodeId && w.id === a.workspaceId)).map(a => ({ operation: a.operation, createdAt: a.occurredAt })) }; break;
        case 'list_workspaces': result = workspaces.filter(w => !nodeId || w.nodeId === nodeId); break;
        case 'list_github_repositories': result = { repositories: [
            { repository: 'example/atlas-demo', private: true, defaultBranch: 'main', archived: false },
            { repository: 'example/portfolio-demo', private: false, defaultBranch: 'main', archived: false },
        ] }; break;
        case 'workspace_git_list_worktrees': result = { worktrees: [] }; break;
        case 'list_project_workspaces': result = workspaces.filter(w => w.projectId === projectId); break;
        case 'get_workspace': result = workspaces.find(w => w.projectId === projectId && w.id === checkoutId); break;
        case 'workspace_git_status': result = { available: true, branch: 'demo/main', dirty: false, changes: [], truncated: false }; break;
        case 'workspace_list_dev_tasks': result = []; break;
        case 'workspace_list_files': result = { entries: [{ path: 'README.md', type: 'file' }, { path: 'src', type: 'directory' }], truncated: false }; break;
        case 'workspace_read_file': result = { path: input.path, text: '# Demo workspace\nThis is an illustrative local fixture, not a real repository.' }; break;
        case 'unity_list_commands': result = { available: true, state: 'ready', commands: [] }; break;
        case 'query_monitoring_activity': {
            const filtered = activity.filter(event => {
                const details = event.resulting && typeof event.resulting === 'object' ? event.resulting as Record<string, unknown> : {};
                const category = event.operation.startsWith('workspace.git_') ? 'git' : event.operation.startsWith('workspace.file_') ? 'files'
                    : event.operation.startsWith('workspace.dev_') ? 'dev' : event.operation.startsWith('workspace.unity_') ? 'unity'
                    : event.operation.startsWith('workspace.') ? 'workspace' : event.operation.startsWith('view.') ? 'view' : 'core';
                const outcome = event.operation.endsWith('_failed') || details.outcome === 'failed' || details.success === false ? 'failed' : event.operation === 'workspace.mutation_requested' ? 'pending' : 'completed';
                return (!projectId || event.projectId === projectId)
                    && (!workspaceId || event.workspaceId === workspaceId)
                    && (!input.checkoutId || event.workspaceId === input.checkoutId)
                    && (!storeId || event.storeId === storeId)
                    && (!input.nodeId || details.nodeId === input.nodeId)
                    && (!input.client || event.client.toLowerCase() === String(input.client).toLowerCase())
                    && (!input.operation || event.operation === input.operation)
                    && (!input.category || category === input.category)
                    && (!input.outcome || outcome === input.outcome)
                    && (!input.search || [event.operation, event.client, details.error, details.task].some(value => String(value ?? '').toLowerCase().includes(String(input.search).toLowerCase())))
                    && (!input.from || event.occurredAt >= String(input.from))
                    && (!input.to || event.occurredAt <= String(input.to));
            }).sort((a,b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
            const offset = Math.max(0, Number(input.offset) || 0);
            const limit = Math.min(100, Math.max(1, Number(input.limit) || 30));
            result = { items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset };
            break;
        }
        case 'get_recent_activity': case 'get_audit_history':
            result = activity.filter(event => (!projectId || event.projectId === projectId) && (!workspaceId || event.workspaceId === workspaceId))
                .slice(0, Number(input.limit) || 200); break;
        case 'list_all_applications': result = applications; break;
        case 'list_applications': result = applications.filter(a => a.projectId === projectId); break;
        case 'get_application': result = applications.find(a => a.projectId === projectId && a.slug === input.slug); break;
        case 'get_portfolio_schemas': result = portfolioTypes.map(contentType => ({
            contentType, storeId: uuid(41, portfolioTypes.indexOf(contentType) + 1), name: contentType, fields: portfolioFields[contentType],
        })); break;
        case 'list_portfolio_entries': result = portfolioEntries.filter(entry => !input.contentType || entry.contentType === input.contentType); break;
        case 'get_portfolio_dashboard': result = {
            contentTypes: portfolioTypes.map(contentType => ({
                contentType, name: contentType, storeId: uuid(41, portfolioTypes.indexOf(contentType) + 1),
                total: portfolioEntries.filter(e => e.contentType === contentType).length,
                published: portfolioEntries.filter(e => e.contentType === contentType && e.status === 'published').length,
                drafts: portfolioEntries.filter(e => e.contentType === contentType && e.status !== 'published').length,
            })), media: { active: 0, bytes: 0 },
        }; break;
        case 'list_portfolio_media': case 'list_portfolio_revisions': result = []; break;
        case 'search_everything': {
            const query = str(input.query);
            const needle = query.trim().toLowerCase();
            const hits = [
                ...mockProjects.map(p => ({ id: p.id, kind: 'project', title: p.name, description: p.description ?? '', context: 'Demo project', href: '#/projects/' + p.id, score: 20 })),
                ...stores.map(s => ({ id: s.id, kind: 'store', title: s.name, description: s.description ?? '', context: 'Demo store', href: '#/projects/' + s.projectId + '/stores/' + s.id + '/records', score: 15 })),
                ...nodes.map(n => ({ id: n.id, kind: 'node', title: n.name, description: n.platform ?? '', context: 'Demo node', href: '#/nodes', score: 20 })),
                ...applications.map(a => ({ id: a.slug, kind: 'application', title: a.name, description: a.description, context: 'Demo application', href: '#/projects/' + a.projectId + '/applications/' + a.slug, score: 20 })),
                ...workspaces.map(w => ({ id: w.id, kind: 'workspace', title: w.name, description: w.rootPath, context: 'Demo workspace', href: '#/projects/' + w.projectId + '/workspaces', score: 10 })),
                ...records.map(r => ({ id: r.id, kind: 'record', title: String(r.data.name ?? r.data.title ?? r.data.code ?? 'Record'), description: JSON.stringify(r.data), context: 'Demo record', href: '#/projects/' + r.projectId + '/stores/' + r.storeId + '/records', score: 8 })),
            ];
            if (/logs?|error lines|stdout|stderr/.test(needle)) {
                result = { query, incomplete: [], results: nodes.map(n => ({
                    id: 'log-' + n.id, kind: 'node', title: 'Read logs from ' + n.name,
                    description: 'Illustrative logs, not the real node output', context: 'Demo node logs',
                    href: '#/nodes', score: 25,
                    action: { type: 'read_node_logs', nodeId: n.id, source: 'stdout', lines: 100 },
                })) };
            } else {
                result = { query, incomplete: [], results: hits.filter(hit =>
                    needle.split(/[^a-z0-9]+/).filter(term => term.length > 2 && !['open', 'find', 'show', 'the', 'want', 'for', 'from', 'please', 'look', 'check', 'with', 'about'].includes(term)).some(term =>
                        (hit.title + ' ' + hit.description + ' ' + hit.kind + ' ' + hit.context).toLowerCase().includes(term))
                ).slice(0, Number(input.limit) || 45) };
            }
            break;
        }
        case 'get_monitoring_health': result = {
            checkedAt: stamp, overall: 'healthy',
            server: { status: 'healthy', startedAt: stamp, uptimeSeconds: 0, database: { status: 'reachable', latencyMs: 0 } },
            nodes: { available: true, summary: { total: 0, healthy: 0, stale: 0, offline: 0,
                unavailable: 0, revoked: 0, unknown: 0 }, items: [] },
        }; break;
        case 'read_server_diagnostics': result = {
            source: 'atlas-server-process', available: true, startedAt: stamp,
            retention: 'current-process', truncated: false,
            events: [{ at: stamp, code: 'server_initialised', level: 'info', message: '[demo] Server runtime initialised' }],
        }; break;
        case 'read_node_logs': result = {
            source: input.source ?? 'stdout', available: true, truncated: false,
            lines: ['[demo] Atlas node fixture initialised', '[demo] Workspace connection healthy', '[demo] No real server logs were accessed'],
        }; break;
        case 'ask_atlas': case 'ask_portfolio': result = {
            question: input.question ?? '', answer: 'You are viewing local demo fixtures. Connect to a live Atlas Server to use the real assistant.',
            abstained: true, sources: [],
            diagnostics: { provider: 'mock', contextRecordCount: 0, authorityStatus: 'mock', unresolvedConflicts: 0,
                relevantUnresolvedConflicts: 0, authorityDecisions: [], relevanceFloorRejected: 0, authoritySuppressed: 0, redundancyRejected: 0 },
        }; break;
        case 'search_atlas': result = { query: input.query ?? '', results: [], diagnostics: { mode: 'mock', resultCount: 0 } }; break;
        case 'request_context': case 'get_context': result = { query: input.query ?? '', selections: [], diagnostics: { mode: 'mock' } }; break;
        default:
            throw new Error('This operation is unavailable in local mock mode (' + name + '). Set VITE_ATLAS_API_MODE=live to use a real Atlas Server.');
    }
    if (result === undefined) throw new Error('No mock fixture found for ' + name + '.');
    return structuredClone(result) as T;
}
