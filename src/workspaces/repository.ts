import type { Workspace } from './model.js';
export interface WorkspaceReader {
    get(projectId: string, id: string, includeArchived?: boolean): Promise<Workspace>;
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
    insert(input: { nodeId: string; projectId: string; name: string; rootPath: string; kind: 'generic' | 'unity' }): Promise<Workspace>;
    update(id: string, name: string | undefined, archive: boolean): Promise<Workspace>;
}
export interface WorkspaceRepository extends WorkspaceReader {
    list(projectId: string, includeArchived?: boolean): Promise<Workspace[]>;
    connect(): Promise<WorkspaceTransaction>;
}
