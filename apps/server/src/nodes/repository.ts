import type { AtlasNode, HostedWorkspace, NodeCapability } from './model.js';
export interface NodeRepository {
    registerLocal(name: string, capabilities: NodeCapability[]): Promise<AtlasNode>;
    registerRemote(id: string, name: string, capabilities: NodeCapability[], sessionId: string, platform?: string, version?: string): Promise<AtlasNode>;
    getDefault(): Promise<AtlasNode>;
    touch(id: string, sessionId: string): Promise<void>;
    list(): Promise<AtlasNode[]>;
    get(id: string): Promise<AtlasNode>;
    hostedWorkspaces(id: string): Promise<HostedWorkspace[]>;
    offline(id: string, sessionId?: string): Promise<void>;
}
