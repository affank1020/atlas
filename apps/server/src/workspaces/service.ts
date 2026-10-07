import { NodeService } from '../nodes/service.js';
import { NodeRouter } from '../nodes/router.js';
import { PostgresNodeRepository } from '../infrastructure/database/nodes.js';
import { loadWorkspaceConfig, loadNodeConfig } from "../server/config.js";
import { PostgresWorkspaceRepository } from "../infrastructure/database/workspaces.js";
/** Compatibility constructor for scripts/tests. Production composition injects a host. */
import type { Pool } from "pg";
import { AtlasCatalog, AtlasError } from "../catalog.js";
import { WorkspaceService as ApplicationService } from "./application.js";
export class WorkspaceService extends ApplicationService {
    constructor(catalog: AtlasCatalog, pool: Pool) {
        super(catalog, new PostgresWorkspaceRepository(pool), new NodeRouter(new NodeService(new PostgresNodeRepository(pool))));
    }
}
const services = new WeakMap<AtlasCatalog, WorkspaceService>();
export function workspacesFor(catalog: AtlasCatalog) {
    let service = services.get(catalog);
    if (!service) {
        const pool = (catalog.store as { pool?: Pool }).pool;
        if (!pool) throw new AtlasError('Workspace persistence is unavailable.', 'WORKSPACE_UNAVAILABLE');
        service = new WorkspaceService(catalog, pool); services.set(catalog, service);
    }
    return service;
}

