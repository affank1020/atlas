export type { NodeCapability } from '@atlas/protocol/node-model';
import type { NodeCapability } from '@atlas/protocol/node-model';
export type NodeStatus = 'online' | 'offline' | 'unavailable';
export interface AtlasNode {
    id: string;
    name: string;
    status: NodeStatus;
    capabilities: NodeCapability[];
    lastSeen: string | null;
    metadata: Record<string, unknown>;
    platform: string;
    version: string | null;
    credentialState: 'unenrolled' | 'pending' | 'active' | 'revoked';
    credentialUpdatedAt: string | null;
    createdAt: string;
    updatedAt: string;
    hostedWorkspaceCount: number;
}
export interface HostedWorkspace { id: string; projectId: string; name: string; kind: string; status: string }
