/** Stable entry point and compatibility exports. Composition lives under server/. */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { AtlasCatalog } from './catalog.js';
import { AtlasStore } from './store.js';
import type { FabricServices } from './fabric/index.js';
import { RetrievalService } from './retrieval/service.js';
import { AskPortfolioService } from './portfolio/ask/index.js';
import { ContentfulPortfolioIntegration } from './integrations/contentful.js';
import { PortfolioService, PortfolioMediaService, PORTFOLIO_PROJECT_ID, PORTFOLIO_SOURCE_TYPE } from './portfolio/index.js';
import { workspacesFor } from './workspaces/service.js';
import type { WorkspaceToolName } from './workspaces/contracts.js';
import { createAskAtlas } from './server/ai.js';
import { createDispatcher } from './server/dispatch.js';
import { composeServer, startBackgroundWork } from './server/composition.js';
import { loadServerConfig } from './server/config.js';
import { createHttpTransport } from './api/http/index.js';
import { createMcpTransport } from './api/mcp/index.js';

export function createAtlasMcpServer(catalog: AtlasCatalog, fabric: FabricServices,
    askAtlas = createAskAtlas(catalog, new RetrievalService(fabric.search, fabric.context, fabric.authority)),
    askPortfolio = new AskPortfolioService(createAskAtlas(catalog, new RetrievalService(fabric.search, fabric.context, fabric.authority), { projectIds: [PORTFOLIO_PROJECT_ID], sourceTypes: [PORTFOLIO_SOURCE_TYPE], retrievalMode: 'direct' })),
    contentful = new ContentfulPortfolioIntegration(fabric.repository), portfolio?: PortfolioService, media?: PortfolioMediaService) {
    const services = { nodes: { call: (name: import("./nodes/contracts.js").NodeToolName, input: unknown) => workspacesFor(catalog).runtime.nodes.call(name, input) }, catalog, views: catalog.views, workspaces: { call: (name: WorkspaceToolName, input: unknown) => workspacesFor(catalog).call(name, input) }, retrieval: new RetrievalService(fabric.search, fabric.context, fabric.authority), askAtlas, askPortfolio, contentful, portfolio, media };
    return createMcpTransport({ ...services, dispatch: createDispatcher(services) });
}
export function createAtlasHttpServer(options: { databaseUrl?: string } = {}) {
    const services = composeServer(loadServerConfig(process.env, options));
    startBackgroundWork(services);
    return createHttpTransport(services);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const config = loadServerConfig();
    const probe = new AtlasStore(config.databaseUrl);
    try { await probe.snapshot(); } catch { console.error('Atlas cannot connect to its migrated PostgreSQL database.'); process.exitCode = 1; }
    finally { await probe.close(); }
    if (!process.exitCode) {
        const services = composeServer(config);
        await services.nodes.registerLocalNode();
        startBackgroundWork(services);
        const http = createHttpTransport(services);
        http.listen(config.port, config.host, () => console.log(`Atlas Server listening on http://${config.host}:${config.port}/mcp`));
        let stopping = false;
        const stop = () => {
            if (stopping) return;
            stopping = true;
            http.close(() => { void services.lifecycle.close().catch(() => { process.exitCode = 1; }); });
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    }
}
