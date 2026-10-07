import type { Pool } from 'pg';
import type { AtlasCatalog } from '../apps/server/src/catalog.js';
import { WorkspaceService } from '../apps/server/src/workspaces/application.js';
import { PostgresWorkspaceRepository } from '../apps/server/src/infrastructure/database/workspaces.js';
import { PostgresNodeRepository } from '../apps/server/src/infrastructure/database/nodes.js';
import { NodeService } from '../apps/server/src/nodes/service.js';
import { NodeRouter } from '../apps/server/src/nodes/router.js';
import { LocalNodeRuntime } from '../apps/node/src/platforms/desktop/runtime.js';
import { composeServer, startBackgroundWork } from '../apps/server/src/server/composition.js';
import { loadServerConfig } from '../apps/server/src/server/config.js';
import { createHttpTransport } from '../apps/server/src/api/http/index.js';
import type { WorkspaceAdapter } from '@atlas/protocol/workspace';

/** Integration-only local runtime; production Server never imports Node code. */
export function localWorkspaceService(catalog: AtlasCatalog, pool: Pool, roots: string[], adapters?: Map<string, WorkspaceAdapter>) {
  const runtime = new LocalNodeRuntime(roots, adapters);
  return new WorkspaceService(catalog, new PostgresWorkspaceRepository(pool), new NodeRouter(new NodeService(new PostgresNodeRepository(pool), runtime, 'Test Node')));
}
export function localHttpServer(databaseUrl: string, roots: string[]) {
  const services = composeServer(loadServerConfig({ DATABASE_URL: databaseUrl, ATLAS_NODE_EXECUTION: 'remote' }), new LocalNodeRuntime(roots, new Map()));
  startBackgroundWork(services);
  return { http: createHttpTransport(services), services };
}
