import { RemoteNodeGateway } from '../infrastructure/nodes/gateway.js';
import { NodeIdentity } from '../nodes/identity.js';
import { NodeService } from '../nodes/service.js';
import { NodeRouter } from '../nodes/router.js';
import { PostgresNodeRepository } from '../infrastructure/database/nodes.js';
import { PostgresWorkspaceRepository } from "../infrastructure/database/workspaces.js";
import { CoreService } from '../core/service.js';
import { ViewService } from '../views/service.js';
import { AtlasStore } from '../infrastructure/database/postgres.js';
import { createFabric } from '../fabric/index.js';
import { OllamaEmbeddingProvider } from '../fabric/embeddings.js';
import { RetrievalService } from '../retrieval/service.js';
import { AskPortfolioService } from '../portfolio/ask/index.js';
import { ContentfulPortfolioIntegration } from '../integrations/contentful.js';
import { PortfolioMediaService, PortfolioService, PORTFOLIO_PROJECT_ID, PORTFOLIO_SOURCE_TYPE } from '../portfolio/index.js';
import { WorkspaceService } from '../workspaces/application.js';
import { createAskAtlas } from './ai.js';
import { createDispatcher } from './dispatch.js';
import { ApplicationRegistry } from '../apps/registry.js';
import { portfolioApplication } from '../apps/portfolio-definition.js';
import { FootballTrainingService, footballTrainingApplication } from '../apps/football-training.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { ServerLifecycle } from './lifecycle.js';
import type { NodeRuntime } from '../nodes/runtime.js';

export function composeServer(config: ServerConfig = loadServerConfig(), executionHost?: NodeRuntime) {
    const repository = new AtlasStore(config.databaseUrl);
    const catalog = new CoreService(repository);
    const fabric = createFabric(config.databaseUrl, new OllamaEmbeddingProvider(config.retrieval.embeddingModel, config.ai.baseUrl));
    const retrieval = new RetrievalService(fabric.search, fabric.context, fabric.authority);
    const askAtlas = createAskAtlas(catalog, retrieval, undefined, config.ai.baseUrl);
    const askPortfolio = new AskPortfolioService(createAskAtlas(catalog, retrieval, { projectIds: [PORTFOLIO_PROJECT_ID], sourceTypes: [PORTFOLIO_SOURCE_TYPE], retrievalMode: 'direct' }, config.ai.baseUrl));
    const contentful = new ContentfulPortfolioIntegration(fabric.repository, config.portfolio.integrationEnvironment);
    const portfolio = new PortfolioService(catalog, fabric.repository, config.databaseUrl);
    const media = new PortfolioMediaService(config.databaseUrl, config.portfolio.mediaRoot);
    const identity = new NodeIdentity(repository.pool);
    const nodes = new NodeService(new PostgresNodeRepository(repository.pool), executionHost, config.node.name, identity);
    const nodeGateway = new RemoteNodeGateway(nodes);
    identity.disconnect = id => nodeGateway?.disconnectNode(id);
    const workspaces = new WorkspaceService(catalog, new PostgresWorkspaceRepository(repository.pool), new NodeRouter(nodes));
    const lifecycle = new ServerLifecycle([{ close: async () => { try { await nodeGateway?.close(); await nodes.close(); } finally { await repository.close(); } } }, fabric.repository, portfolio, media]);
    const football = new FootballTrainingService(catalog, workspaces.repository, workspaces.runtime);
    const applications = new ApplicationRegistry([portfolioApplication({ portfolio, media, askPortfolio, contentful }), footballTrainingApplication(football)]);
    const services = { config, catalog, nodes, identity, nodeGateway, views: new ViewService(catalog), workspaces, retrieval, askAtlas, askPortfolio, contentful, portfolio, media, applications, lifecycle };
    return { ...services, dispatch: createDispatcher(services) };
}
export type ServerServices = ReturnType<typeof composeServer>;
export function startBackgroundWork(services: ServerServices) {
    if (services.nodes.hasLocalRuntime) services.lifecycle.run('Local Node registration', () => services.nodes.registerLocalNode());
    services.lifecycle.run('Portfolio startup index', () => services.portfolio.rebuildPublishedIndex());
    services.lifecycle.run('Contentful startup sync', () => services.contentful.syncPortfolio('startup'));
}
