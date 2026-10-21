import type { Workspace } from './model.js';
import type { LogicalWorkspace } from '@atlas/protocol/workspace';
export interface WorkspaceReader {
    get(projectId: string, id: string, includeArchived?: boolean): Promise<Workspace>;
    getById(id: string, includeArchived?: boolean): Promise<Workspace>;
    audit(workspace: Workspace, operation: string, client: string | undefined, metadata: unknown): Promise<void>;
}
/** A leased unit of work keeps the lock, mutation outcome and audit on one connection. */
export interface WorkspaceTransaction extends WorkspaceReader {
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    release(): void;
    requireActiveProject(projectId: string, lock?: boolean): Promise<void>;
    lockWorkspace(id: string): Promise<void>;
    lockExecution(binding: string): Promise<void>;
    managedWorktreeBranch(workspaceId: string, rootPath: string): Promise<string | null>;
    insert(input: { nodeId: string; projectId?: string | null; name: string; rootPath: string; kind: 'generic' | 'unity'; logicalWorkspaceId?: string; repository?: string }): Promise<Workspace>;
    attachRepository(workspaceId: string, repository: string): Promise<Workspace>;
    link(workspaceId: string, projectId: string): Promise<void>;
    unlink(workspaceId: string, projectId: string): Promise<void>;
    update(id: string, name: string | undefined, archive: boolean): Promise<Workspace>;
}
export interface WorkspaceRepository extends WorkspaceReader {
    list(projectId: string, includeArchived?: boolean): Promise<Workspace[]>;
    listAll(includeArchived?: boolean, nodeId?: string): Promise<Workspace[]>;
    listLogical(includeArchived?: boolean): Promise<LogicalWorkspace[]>;
    connect(): Promise<WorkspaceTransaction>;
}
