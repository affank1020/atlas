import { AtlasError } from '../shared/errors.js';
import { nodeSchemas, type NodeToolName } from './contracts.js';
import type { AtlasNode } from './model.js';
import type { NodeRepository } from './repository.js';
import { NodeIdentity } from './identity.js';
import type { NodeRuntime } from './runtime.js';

/** Durable registry plus ephemeral runtime attachments. No transport implementation lives here. */
export class NodeService {
    readonly runtimes = new Map<string, NodeRuntime>();
    private readonly lastSeen = new Map<string, string>();
    private registration?: Promise<string>;
    private closing = false;
    constructor(readonly repository: NodeRepository, private readonly local?: NodeRuntime, private readonly localName = 'Local Node', readonly identity?: NodeIdentity) {}
    get hasLocalRuntime() { return !!this.local; }
    registerLocalNode(): Promise<string> {
        if (!this.local) return Promise.reject(new AtlasError('No in-process Node is configured.', 'NODE_UNAVAILABLE'));
        if (this.closing) return Promise.reject(new AtlasError('Node registry is stopping.', 'NODE_UNAVAILABLE'));
        return this.registration ??= this.repository.registerLocal(this.localName, this.local.getCapabilities()).then(node => {
            this.runtimes.set(node.id, this.local!);
            return node.id;
        }).catch(error => { this.registration = undefined; throw error; });
    }
    async defaultNodeId(): Promise<string> {
        if (this.local) return this.registerLocalNode();
        return (await this.repository.getDefault()).id;
    }
    attachRemote(id: string, runtime: NodeRuntime) {
        this.runtimes.set(id, runtime);
        this.lastSeen.set(id, new Date().toISOString());
    }
    seenRemote(id: string) { if (this.runtimes.has(id)) this.lastSeen.set(id, new Date().toISOString()); }
    detachRemote(id: string, runtime: NodeRuntime) {
        if (this.runtimes.get(id) === runtime) { this.runtimes.delete(id); this.lastSeen.delete(id); }
    }
    private effective(node: AtlasNode): AtlasNode {
        const attached = this.runtimes.has(node.id);
        return { ...node,
            capabilities: attached ? node.capabilities.filter(capability => this.runtimes.get(node.id)!.getCapabilities().includes(capability)) : [],
            status: node.status === 'online' && !attached ? (node.metadata.runtime === 'remote' ? 'offline' : 'unavailable') : node.status,
            lastSeen: this.lastSeen.get(node.id) ?? node.lastSeen,
        };
    }
    async list() { if (this.local) await this.registerLocalNode(); return (await this.repository.list()).map(node => this.effective(node)); }
    async get(id: string) { if (this.local) await this.registerLocalNode(); return this.effective(await this.repository.get(id)); }
    async call(name: NodeToolName, input: unknown) {
        const parsed = nodeSchemas[name].safeParse(input);
        if (!parsed.success) throw new AtlasError(parsed.error.message);
        if (name === 'list_nodes') return this.list();
        const x = parsed.data as any;
        if (name === 'create_node_enrolment') return this.requireIdentity().ticket();
        if (name === 'update_node') return this.requireIdentity().update(x.nodeId, x.name);
        if (name === 'rotate_node_credential') return this.requireIdentity().ticket(x.nodeId, true);
        if (name === 'revoke_node') return this.requireIdentity().revoke(x.nodeId);
        if (name === 'assign_workspace_node') return this.requireIdentity().assign(x);

        const node = await this.get((parsed.data as { nodeId: string }).nodeId);
        return { ...node, workspaces: await this.repository.hostedWorkspaces(node.id), activity: this.identity ? await this.identity.activity(node.id) : [] };
    }
    private requireIdentity() { if (!this.identity) throw new AtlasError('Node identity service unavailable.', 'NODE_UNAVAILABLE'); return this.identity; }
    async close() {
        this.closing = true;
        if (this.registration) {
            const id = await this.registration;
            this.runtimes.delete(id);
            await this.repository.offline(id);
        }
    }
}
