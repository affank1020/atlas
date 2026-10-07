export type NodeCapability = 'workspace.files' | 'workspace.git' | 'workspace.dev' | 'unity';
export type NodeStatus = 'online' | 'offline' | 'unavailable';
export interface AtlasNode {
    id: string;
    name: string;
    status: NodeStatus;
    capabilities: NodeCapability[];
    lastSeen: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    hostedWorkspaceCount: number;
}
export interface HostedWorkspace { id: string; projectId: string; name: string; kind: string; status: string }
