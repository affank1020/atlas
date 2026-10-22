import { timed } from '../shared/performance.js';
import { nodeSchemas, type NodeToolName } from '../nodes/contracts.js';
import type { NodeService } from '../nodes/service.js';
import type { ShareAuditClient } from '../nodes/share-approvals.js';
import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import type { ViewService } from '../views/service.js';
import type { WorkspaceService } from '../workspaces/application.js';
import type { RetrievalService } from '../retrieval/service.js';
import type { AskAtlasService } from '../ai/ask-atlas/index.js';
import type { AskPortfolioService } from '../portfolio/ask/index.js';
import type { ContentfulPortfolioIntegration } from '../integrations/contentful.js';
import type { PortfolioService, PortfolioMediaService } from '../portfolio/index.js';
import { fabricSearchSchema, fabricContextSchema } from '../retrieval/input.js';
import { callCoreTool } from './core-dispatch.js';
import { globalSearchInput, searchEverywhere } from './global-search.js';
import type { ApplicationRegistry } from '../apps/registry.js';
import type { StorageUsageService } from './storage-usage.js';
export interface ApplicationServices {
    nodes?: Pick<NodeService, "call">;
    catalog: CoreService;
    storageUsage?: Pick<StorageUsageService, 'get'>;
    views: ViewService;
    workspaces: Pick<WorkspaceService, "call">;
    retrieval: RetrievalService;
    askAtlas: AskAtlasService;
    askPortfolio: AskPortfolioService;
    contentful: ContentfulPortfolioIntegration;
    portfolio?: PortfolioService;
    media?: PortfolioMediaService;
    applications: ApplicationRegistry;
}
export type TransportServices = ApplicationServices & { dispatch(name: string, input?: any, caller?: ShareAuditClient): Promise<unknown> };
/** One application dispatch path for HTTP, MCP and future internal job callers. */
export function createDispatcher(services: ApplicationServices) {
    const { catalog, views, workspaces, retrieval, askAtlas, applications } = services;
    return async (name: string, input: any = {}, caller: ShareAuditClient = 'atlas-server'): Promise<unknown> => timed(`tool.${/^[a-z_]+$/.test(name) ? name : 'unknown'}`, async () => {
        if (Object.hasOwn(nodeSchemas, name)) {
            if (!services.nodes) throw new AtlasError("Node registry is unavailable.", "NODE_UNAVAILABLE");
            return services.nodes.call(name as NodeToolName, input, caller);
        }
        switch (name) {
            case 'get_storage_usage': {
                if (!services.storageUsage) throw new AtlasError('Storage metrics unavailable.', 'NOT_FOUND');
                return services.storageUsage.get(input.refresh === true);
            }
            case 'ask_atlas': return askAtlas.ask(input);
            case 'search_atlas': return retrieval.search(fabricSearchSchema.parse(input));
            case 'search_everything': return searchEverywhere({ listProjects: catalog.listProjects.bind(catalog), listStores: catalog.listStores.bind(catalog), views, retrieval, applications, nodes: services.nodes }, globalSearchInput.parse(input));
            case 'request_context': return retrieval.context(fabricContextSchema.parse(input));
        }
        if (name === 'list_projects' && input.withMetrics === true) {
            const [projects, resourceCounts] = await Promise.all([
                catalog.listProjects(input.includeArchived),
                catalog.countProjectResources(input.includeArchived),
            ]);
            return projects.map(project => ({
                ...project,
                metrics: {
                    ...(resourceCounts[project.id] ?? { stores: 0, records: 0, views: 0 }),
                    applications: applications.list(project.id).length,
                },
            }));
        }
        if (name === 'list_all_applications') {
            const activeProjects = new Set((await catalog.listProjects(false)).map(project => project.id));
            return applications.listAll().filter(app => app.projectId === null || activeProjects.has(app.projectId));
        }
        if (name === 'list_applications') {
            await catalog.getProject(input.projectId);
            return applications.list(input.projectId);
        }
        if (name === 'get_application') {
            if (input.projectId !== undefined && input.projectId !== null) await catalog.getProject(input.projectId);
            return applications.get(input.projectId ?? null, input.slug);
        }
        if (applications.hasTool(name)) return applications.invoke(name, input);
        return callCoreTool(catalog, views, workspaces, name, input);
    });
}
