import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { AtlasError } from '../../shared/errors.js';
import type { NodeRuntime, NodeOperation } from '../../nodes/runtime.js';
import type { NodeCapability } from '../../nodes/model.js';
import type { Workspace } from '../../workspaces/model.js';
import { nodeResponseSchema } from '../../nodes/protocol.js';

/** One live connection implements the shared NodeRuntime contract. */
export class RemoteNodeRuntime implements NodeRuntime {
    private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    private closed = false;
    constructor(readonly socket: WebSocket, private readonly capabilities: NodeCapability[], private readonly timeoutOverrideMs?: number) {}
    getCapabilities() { return [...this.capabilities]; }
    bind(rootPath: string): Promise<string> { return this.request({ kind: 'bind', rootPath }, 15_000).then(value => {
        if (typeof value !== 'string') throw new AtlasError('Node returned an invalid binding.', 'NODE_PROTOCOL');
        return value;
    }); }
    execute(workspace: Workspace, operation: NodeOperation, input: Record<string, any>): Promise<unknown> {
        const taskTimeout = operation === 'workspace_run_dev_task' ? workspace.devTasks[input.task]?.timeoutMs ?? 120_000 : 0;
        const timeoutMs = taskTimeout ? Math.min(taskTimeout + 15_000, 615_000) : operation.startsWith('unity_') ? 60_000 : 30_000;
        return this.request({ kind: 'execute', workspace, operation, input }, timeoutMs);
    }
    private request(payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
        if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new AtlasError('Node connection is closed.', 'NODE_DISCONNECTED'));
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new AtlasError('Node request timed out; execution outcome may be uncertain.', 'NODE_TIMEOUT'));
            }, this.timeoutOverrideMs ?? timeoutMs);
            this.pending.set(requestId, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ type: 'request', requestId, ...payload }), error => {
                if (error) {
                    clearTimeout(timer); this.pending.delete(requestId);
                    reject(new AtlasError('Node connection failed during send.', 'NODE_DISCONNECTED'));
                }
            });
        });
    }
    receive(raw: unknown) {
        const parsed = nodeResponseSchema.safeParse(raw);
        if (!parsed.success) return false;
        const message = parsed.data;
        const pending = this.pending.get(message.requestId);
        if (!pending) return true; // Late reply after timeout or disconnect.
        this.pending.delete(message.requestId); clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new AtlasError(message.error.message, message.error.code));
        return true;
    }
    dispose(code = 'NODE_DISCONNECTED') {
        if (this.closed) return;
        this.closed = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new AtlasError('Node disconnected; execution outcome may be uncertain.', code));
        }
        this.pending.clear();
    }
    get pendingCount() { return this.pending.size; }
}
