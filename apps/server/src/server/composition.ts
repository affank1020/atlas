import { Pool } from 'pg';
import { RemoteNodeGateway } from '../infrastructure/nodes/gateway.js';
import { DeviceOfflineInbox } from '../nodes/offline-inbox.js';
import { readInboxKey } from '../nodes/offline-inbox-crypto.js';
import { NodeIdentity } from '../nodes/identity.js';
import { NodeShareApprovals } from '../nodes/share-approvals.js';
import { NodeService } from '../nodes/service.js';
import { NodeUpdateIntentLedger } from '../nodes/update-intents.js';
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
import { ServerDiagnostics } from './diagnostics.js';
import { ServerDiagnosticHistory } from './diagnostic-history.js';
import { MonitoringHealthService } from './monitoring-health.js';
import { StorageUsageService } from './storage-usage.js';
import { AtlasFilesService } from './atlas-files.js';
import { NodeFileIngestService } from './node-file-ingest.js';
import { NodeResumableTransferService } from './node-resumable-transfer.js';
import { ApplicationRegistry } from '../apps/registry.js';
import { portfolioApplication } from '../apps/portfolio-definition.js';
import { FootballTrainingService, footballTrainingApplication } from '../apps/football-training.js';
import { CodeReviewsService, codeReviewsApplication } from '../apps/code-reviews.js';
import { GitHubReviewHistoryReader } from '../apps/github-review-history.js';
import { GitHubReviewPublisher } from '../apps/github-review-publisher.js';
import { ReviewPublicationService } from '../apps/review-publication.js';
import { GitHubManagedSummaryReader, ManagedSummaryPreviewService } from '../apps/managed-summary.js';
import { GitHubManagedSummaryWriter } from '../apps/managed-summary-github.js';
import { ManagedSummaryPublicationService } from '../apps/managed-summary-publication.js';
import { GitHubInlineDiffReader, InlineThreadPreflightService } from '../apps/inline-thread-preflight.js';
import { GitHubInlineThreadReader, InlineThreadInventoryService } from '../apps/inline-thread-inventory.js';
import { GitHubInlineRootWriter } from '../apps/inline-thread-writer.js';
import { InlineRootPublicationService } from '../apps/inline-root-publication.js';
import { InlineReplyPublicationService } from '../apps/inline-reply-publication.js';
import { InlineFixPublicationService } from '../apps/inline-fix-publication.js';
import { GitHubReviewThreadStateReader, ReviewThreadStateService } from '../apps/review-thread-state.js';
import { GitHubThreadResolutionGateway, ReviewThreadResolutionService } from '../apps/review-thread-resolution.js';
import { GitHubBroker } from '../workspaces/github-broker.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { ServerLifecycle } from './lifecycle.js';
import type { NodeRuntime } from '../nodes/runtime.js';

export function composeServer(config: ServerConfig = loadServerConfig(), executionHost?: NodeRuntime) {
    const repository = new AtlasStore(config.databaseUrl);
    // Separate bounded connections keep health checks useful when application
    // queries saturate their pool. Neither checkout nor SQL execution can hang.
    const healthPool = new Pool({
        connectionString: config.databaseUrl, max: 2,
        connectionTimeoutMillis: 1_250, query_timeout: 1_500, statement_timeout: 1_500,
    });
    const catalog = new CoreService(repository);
    // A dedicated bounded connection avoids starving health checks or normal writes
    // when diagnostic history is unavailable.
    const diagnosticPool = new Pool({
        connectionString: config.databaseUrl, max: 1,
        connectionTimeoutMillis: 1_000, query_timeout: 1_500, statement_timeout: 1_500,
    });
    const diagnosticHistory = new ServerDiagnosticHistory(diagnosticPool, config.serverDiagnosticsEnabled);
    const diagnostics = new ServerDiagnostics(config.serverDiagnosticsEnabled, undefined,
        event => diagnosticHistory.record(event));
    const storageUsage = new StorageUsageService(repository.pool, config.storageAnalytics);
    const fabric = createFabric(config.databaseUrl, new OllamaEmbeddingProvider(config.retrieval.embeddingModel, config.ai.baseUrl));
    const retrieval = new RetrievalService(fabric.search, fabric.context, fabric.authority);
    const askAtlas = createAskAtlas(catalog, retrieval, undefined, config.ai.baseUrl);
    const askPortfolio = new AskPortfolioService(createAskAtlas(catalog, retrieval, { projectIds: [PORTFOLIO_PROJECT_ID], sourceTypes: [PORTFOLIO_SOURCE_TYPE], retrievalMode: 'direct' }, config.ai.baseUrl));
    const contentful = new ContentfulPortfolioIntegration(fabric.repository, config.portfolio.integrationEnvironment);
    const portfolio = new PortfolioService(catalog, fabric.repository, config.databaseUrl);
    const media = new PortfolioMediaService(config.databaseUrl, config.portfolio.mediaRoot, config.portfolio.r2);
    const files = new AtlasFilesService(config.databaseUrl, config.portfolio.mediaRoot, config.portfolio.r2);
    const identity = new NodeIdentity(repository.pool);
    const nodeFileIngest = new NodeFileIngestService(repository.pool, identity, files);
    const nodeResumable = new NodeResumableTransferService(repository.pool, nodeFileIngest);
    const shareApprovals = new NodeShareApprovals(repository.pool, config.deviceShares.approvedPairs);
    const nodes = new NodeService(new PostgresNodeRepository(repository.pool, healthPool), executionHost, config.node.name, identity, shareApprovals, new NodeUpdateIntentLedger(repository.pool));
    const health = new MonitoringHealthService(healthPool, { list: () => nodes.listForMonitoring() },
        undefined, undefined, undefined, diagnosticHistory);
    // No new wire operations are enabled until the server has an explicit key.
    // Missing secret leaves existing live device shares unchanged.
    const offlineInbox = config.deviceInboxKey
        ? new DeviceOfflineInbox(repository.pool, readInboxKey(config.deviceInboxKey), shareApprovals)
        : undefined;
    const nodeGateway = new RemoteNodeGateway(nodes, undefined, config.deviceShares.approvedPairs, shareApprovals, offlineInbox);
    identity.disconnect = id => nodeGateway?.disconnectNode(id);
    const workspaces = new WorkspaceService(catalog, new PostgresWorkspaceRepository(repository.pool), new NodeRouter(nodes));
    const lifecycle = new ServerLifecycle([{ close: async () => { try { await nodeGateway?.close(); await nodes.close(); } finally { try { await diagnosticHistory.close(); } finally {
                    try { await diagnosticPool.end(); } finally {
                        try { await healthPool.end(); } finally { await repository.close(); }
                    }
                } } } }, fabric.repository, portfolio, media, files],
        message => { diagnostics.record('background_task_failed'); console.error(message); });
    const football = new FootballTrainingService(catalog, workspaces.repository, workspaces.runtime);
    const githubBroker = new GitHubBroker();
    const publisher = new ReviewPublicationService(catalog, new GitHubReviewPublisher(githubBroker),
        config.codeReviews.publishRepositories);
    const managedSummary = new ManagedSummaryPreviewService(catalog, new GitHubManagedSummaryReader(githubBroker));
    const managedPublisher = new ManagedSummaryPublicationService(catalog, managedSummary,
        new GitHubManagedSummaryWriter(githubBroker), config.codeReviews.managedSummaryRepositories);
    const inlinePreflight = new InlineThreadPreflightService(catalog, new GitHubInlineDiffReader(githubBroker));
    const inlineInventory = new InlineThreadInventoryService(catalog, new GitHubInlineThreadReader(githubBroker));
    const inlineRootPublisher = new InlineRootPublicationService(catalog, inlinePreflight,
        inlineInventory, new GitHubInlineRootWriter(githubBroker),
        config.codeReviews.inlineRootRepositories, new GitHubInlineThreadReader(githubBroker));
    const inlineReplyPublisher = new InlineReplyPublicationService(catalog,
        new GitHubInlineThreadReader(githubBroker), new GitHubInlineRootWriter(githubBroker),
        config.codeReviews.inlineReplyRepositories);
    const inlineFixPublisher = new InlineFixPublicationService(catalog,
        new GitHubInlineThreadReader(githubBroker), new GitHubInlineRootWriter(githubBroker),
        config.codeReviews.inlineFixRepositories);
    const reviewThreadState = new ReviewThreadStateService(inlineInventory,
        new GitHubInlineThreadReader(githubBroker),
        new GitHubReviewThreadStateReader(githubBroker));
    const threadResolution = new ReviewThreadResolutionService(catalog,
        new GitHubInlineThreadReader(githubBroker),
        new GitHubReviewThreadStateReader(githubBroker),
        new GitHubThreadResolutionGateway(githubBroker),
        new GitHubInlineRootWriter(githubBroker),
        config.codeReviews.threadResolutionRepositories);
    const codeReviews = new CodeReviewsService(catalog, new GitHubReviewHistoryReader(githubBroker),
        config.codeReviews.trustedPublishers, publisher, managedSummary, managedPublisher,
        inlinePreflight, inlineInventory, inlineRootPublisher, inlineReplyPublisher,
        inlineFixPublisher, reviewThreadState, threadResolution);
    const applications = new ApplicationRegistry([portfolioApplication({ portfolio, media, askPortfolio, contentful }), footballTrainingApplication(football), codeReviewsApplication(codeReviews)]);
    diagnostics.record('server_initialised');
    const services = { config, catalog, diagnostics, diagnosticHistory, health, storageUsage, nodes, identity, shareApprovals, nodeGateway, nodeFileIngest, nodeResumable, views: new ViewService(catalog), workspaces, retrieval, askAtlas, askPortfolio, contentful, portfolio, media, files, applications, lifecycle };
    return { ...services, dispatch: createDispatcher(services) };
}
export type ServerServices = ReturnType<typeof composeServer>;
export function startBackgroundWork(services: ServerServices) {
    if (services.nodes.hasLocalRuntime) services.lifecycle.run('Local Node registration', () => services.nodes.registerLocalNode());
    services.lifecycle.run('Portfolio startup index', () => services.portfolio.rebuildPublishedIndex());
    services.lifecycle.run('Contentful startup sync', () => services.contentful.syncPortfolio('startup'));
}
