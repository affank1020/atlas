import type { AtlasNode, HostedWorkspace, NodeCapability } from './model.js';
export interface NodeRepository {
    registerLocal(name: string, capabilities: NodeCapability[]): Promise<AtlasNode>;
    list(): Promise<AtlasNode[]>;
    get(id: string): Promise<AtlasNode>;
    hostedWorkspaces(id: string): Promise<HostedWorkspace[]>;
    offline(id: string): Promise<void>;
}
