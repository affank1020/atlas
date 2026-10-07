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
}
export type TransportServices = ApplicationServices & { dispatch(name: string, input?: any): Promise<unknown> };
/** One application dispatch path for HTTP, MCP and future internal job callers. */
export function createDispatcher(services: ApplicationServices) {
    const { catalog, views, workspaces, retrieval, askAtlas, askPortfolio, contentful, portfolio, media } = services;
    return async (name: string, input: any = {}): Promise<unknown> => {
        if (Object.hasOwn(nodeSchemas, name)) {
            if (!services.nodes) throw new AtlasError("Node registry is unavailable.", "NODE_UNAVAILABLE");
            return services.nodes.call(name as NodeToolName, input);
        }
        switch (name) {
            case 'ask_atlas': return askAtlas.ask(input);
            case 'ask_portfolio': return askPortfolio.ask(input);
            case 'get_contentful_status': return contentful.status();
            case 'sync_portfolio': return contentful.syncPortfolio('manual');
            case 'search_atlas': return retrieval.search(fabricSearchSchema.parse(input));
            case 'request_context': return retrieval.context(fabricContextSchema.parse(input));
        }
        if (portfolio && media) {
            switch (name) {
                case 'get_portfolio_dashboard': return portfolio.dashboard();
                case 'get_portfolio_schemas': return portfolio.schemas();
                case 'list_portfolio_entries': return portfolio.listEntries(input.contentType);
                case 'get_portfolio_entry': return portfolio.getEntry(input.recordId);
                case 'save_portfolio_draft': return portfolio.saveDraft(input);
                case 'publish_portfolio_entry': return portfolio.publish(input.recordId, input.client);
                case 'unpublish_portfolio_entry': return portfolio.unpublish(input.recordId);
                case 'archive_portfolio_entry': return portfolio.archive(input.recordId, input.client);
                case 'list_portfolio_revisions': return portfolio.revisions(input.recordId);
                case 'restore_portfolio_revision': return portfolio.restore(input.recordId, input.revisionId, input.client);
                case 'rebuild_portfolio_index': return portfolio.rebuildPublishedIndex();
                case 'list_portfolio_media': return media.list();
                case 'upload_portfolio_media': return media.upload(input);
                case 'update_portfolio_media': return media.update(input.assetId, input);
            }
        }
        return callCoreTool(catalog, views, workspaces, name, input);
    };
}
