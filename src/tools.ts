import { nodeSchemas, type NodeToolName } from './nodes/contracts.js';
/** Compatibility dispatch for existing scripts. Server transports receive composed services. */
import { AtlasCatalog } from "./catalog.js";
import { workspacesFor } from "./workspaces/service.js";
import { callCoreTool } from "./server/core-dispatch.js";
export { atlasToolNames, type AtlasToolName } from "./server/core-dispatch.js";
export function callAtlasTool(catalog: AtlasCatalog, name: string, input: any = {}) {
    if (Object.hasOwn(nodeSchemas, name)) return workspacesFor(catalog).runtime.nodes.call(name as NodeToolName, input);
    return callCoreTool(catalog, catalog.views, { call: (operation, payload) => workspacesFor(catalog).call(operation, payload) }, name, input);
}
