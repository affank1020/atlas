import { AtlasError } from '../shared/errors.js';
import type { Workspace } from '../workspaces/model.js';
import type { NodeCapability } from './model.js';
import { requiredCapability, type NodeOperation } from './runtime.js';
import type { NodeService } from './service.js';
export class NodeRouter {
    constructor(readonly nodes: NodeService) {}
    async resolve(nodeId: string, capability: NodeCapability) {
        const node = await this.nodes.get(nodeId);
        if (node.status === 'offline') throw new AtlasError('Workspace host Node is offline.', 'NODE_OFFLINE');
        const runtime = this.nodes.runtimes.get(nodeId);
        if (node.status !== 'online' || !runtime) throw new AtlasError('Workspace host Node is unavailable.', 'NODE_UNAVAILABLE');
        if (!node.capabilities.includes(capability) || !runtime.getCapabilities().includes(capability))
            throw new AtlasError(`Workspace host Node does not support ${capability}.`, 'CAPABILITY_UNAVAILABLE');
        return runtime;
    }
    async bindDefault(rootPath: string, assignedNodeId?: string) {
        const nodeId = assignedNodeId ?? await this.nodes.defaultNodeId();
        const runtime = await this.resolve(nodeId, 'workspace.files');
        return { nodeId, rootPath: await runtime.bind(rootPath) };
    }
    bindLocal(rootPath: string) { return this.bindDefault(rootPath); }
    async prepare(workspace: Workspace, operation: NodeOperation, input: Record<string, any>) {
        const capability = requiredCapability[operation];
        if (!capability) throw new AtlasError('Unsupported Node operation.');
        const runtime = await this.resolve(workspace.nodeId, capability);
        return (current: Workspace = workspace) => runtime.execute(current, operation, input);
    }
    async execute(workspace: Workspace, operation: NodeOperation, input: Record<string, any>) {
        return (await this.prepare(workspace, operation, input))();
    }
}
