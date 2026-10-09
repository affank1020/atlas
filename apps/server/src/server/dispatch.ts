import { nodeSchemas, type NodeToolName } from '../nodes/contracts.js';
import type { NodeService } from '../nodes/service.js';
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
import type { ApplicationRegistry } from '../apps/registry.js';
export interface ApplicationServices {
    nodes?: Pick<NodeService, "call">;
    catalog: CoreService;
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
export type TransportServices = ApplicationServices & { dispatch(name: string, input?: any): Promise<unknown> };
/** One application dispatch path for HTTP, MCP and future internal job callers. */
export function createDispatcher(services: ApplicationServices) {
    const { catalog, views, workspaces, retrieval, askAtlas, applications } = services;
    return async (name: string, input: any = {}): Promise<unknown> => {
        if (Object.hasOwn(nodeSchemas, name)) {
            if (!services.nodes) throw new AtlasError("Node registry is unavailable.", "NODE_UNAVAILABLE");
            return services.nodes.call(name as NodeToolName, input);
        }
        switch (name) {
            case 'ask_atlas': return askAtlas.ask(input);
            case 'search_atlas': return retrieval.search(fabricSearchSchema.parse(input));
            case 'request_context': return retrieval.context(fabricContextSchema.parse(input));
        }
        if (name === 'list_applications') {
            await catalog.getProject(input.projectId);
            return applications.list(input.projectId);
        }
        if (name === 'get_application') {
            await catalog.getProject(input.projectId);
            return applications.get(input.projectId, input.slug);
        }
        if (applications.hasTool(name)) return applications.invoke(name, input);
        return callCoreTool(catalog, views, workspaces, name, input);
    };
}
