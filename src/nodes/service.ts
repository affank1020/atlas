import { AtlasError } from '../shared/errors.js';
import { nodeSchemas, type NodeToolName } from './contracts.js';
import type { AtlasNode } from './model.js';
import type { NodeRepository } from './repository.js';
import type { NodeRuntime } from './runtime.js';

/** Atlas Server's registry. Runtime attachments are private infrastructure, never public tools. */
export class NodeService {
    readonly runtimes = new Map<string, NodeRuntime>();
    private registration?: Promise<string>;
    private closing = false;
    constructor(readonly repository: NodeRepository, private readonly local: NodeRuntime, private readonly localName: string) {}
    registerLocalNode(): Promise<string> {
        if (this.closing) return Promise.reject(new AtlasError('Node registry is stopping.', 'NODE_UNAVAILABLE'));
        return this.registration ??= this.repository.registerLocal(this.localName, this.local.getCapabilities()).then(node => {
            this.runtimes.set(node.id, this.local);
            return node.id;
        }).catch(error => { this.registration = undefined; throw error; });
    }
    private effective(node: AtlasNode): AtlasNode {
        // Persisted presence is advisory. Never report an unattached runtime as online after a crash.
        return node.status === 'online' && !this.runtimes.has(node.id) ? { ...node, status: 'unavailable' } : node;
    }
    async list() { await this.registerLocalNode(); return (await this.repository.list()).map(node => this.effective(node)); }
    async get(id: string) { await this.registerLocalNode(); return this.effective(await this.repository.get(id)); }
    async call(name: NodeToolName, input: unknown) {
        const parsed = nodeSchemas[name].safeParse(input);
        if (!parsed.success) throw new AtlasError(parsed.error.message);
        if (name === 'list_nodes') return this.list();
        const node = await this.get((parsed.data as { nodeId: string }).nodeId);
        return { ...node, workspaces: await this.repository.hostedWorkspaces(node.id) };
    }
    async close() {
        this.closing = true;
        if (this.registration) {
            const id = await this.registration;
            this.runtimes.delete(id);
            await this.repository.offline(id);
        }
    }
}
