import { randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { registrationSchema, registeredSchema, MAX_NODE_FRAME_BYTES, NODE_PROTOCOL_VERSION } from '../../nodes/protocol.js';
import type { NodeService } from '../../nodes/service.js';
import { RemoteNodeRuntime } from './remote-runtime.js';

export interface GatewayTiming { heartbeatMs: number; staleMs: number; registrationMs: number; persistMs: number }
const DEFAULT_TIMING: GatewayTiming = { heartbeatMs: 15_000, staleMs: 45_000, registrationMs: 5_000, persistMs: 60_000 };
type Session = { id: string; socket: WebSocket; runtime: RemoteNodeRuntime; heartbeat: ReturnType<typeof setInterval>; lastPong: number; lastPersisted: number };
/** HTTP upgrade boundary. All Workspace execution still flows through NodeRouter. */
export class RemoteNodeGateway {
    private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_NODE_FRAME_BYTES });
    private readonly sessions = new Map<string, Session>();
    private readonly generation = new Map<string, number>();
    private readonly registrations = new Map<string, Promise<void>>();
    private readonly pendingLifecycle = new Set<Promise<unknown>>();
    private closed = false;
    constructor(readonly nodes: NodeService, private readonly timing = DEFAULT_TIMING) {}
    private track(task: Promise<unknown>) {
        this.pendingLifecycle.add(task);
        void task.finally(() => this.pendingLifecycle.delete(task)).catch(() => undefined);
        return task;
    }
    disconnectNode(id: string) {
        this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
        const session = this.sessions.get(id);
        if (!session) return;
        this.sessions.delete(id);
        clearInterval(session.heartbeat);
        session.runtime.dispose('NODE_REVOKED');
        this.nodes.detachRemote(id, session.runtime);
        session.socket.close(1008, 'Credential changed');
        this.track(this.nodes.repository.offline(id, session.id));
    }
    attach(server: HttpServer) {
        server.on('upgrade', (request, socket, head) => {
            if (this.closed || request.url !== '/node/connect' || !this.authorized(request)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
            }
            this.sockets.handleUpgrade(request, socket as Duplex, head, client => this.accept(client, request.headers.authorization!.slice(7)));
        });
    }
    private authorized(request: IncomingMessage) {
        const header = request.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
        return header.slice(7).length >= 32;
    }
    private accept(socket: WebSocket, credential: string) {
        let id: string | undefined;
        let session: Session | undefined;
        let registering = false;
        const registrationTimer = setTimeout(() => socket.close(1008, 'Registration timeout'), this.timing.registrationMs);
        socket.on('message', async bytes => {
            let message: unknown;
            try { message = JSON.parse(String(bytes)); } catch { socket.close(1008, 'Invalid message'); return; }
            if (!id) {
                if (registering) { socket.close(1008, 'Duplicate registration'); return; }
                const parsed = registrationSchema.safeParse(message);
                if (!parsed.success) { socket.close(1008, 'Invalid registration'); return; }
                registering = true;
                const registration = parsed.data;
                const sessionId = randomUUID();
                const revision = (this.generation.get(registration.nodeId) ?? 0) + 1;
                this.generation.set(registration.nodeId, revision);
                const previousRegistration = this.registrations.get(registration.nodeId);
                let release!: () => void;
                const thisRegistration = new Promise<void>(resolve => { release = resolve; });
                this.registrations.set(registration.nodeId, thisRegistration);
                let persisted = false;
                try {
                    await previousRegistration;
                    if (socket.readyState !== WebSocket.OPEN || this.closed || this.generation.get(registration.nodeId) !== revision) {
                        socket.close(1008, 'Stale registration'); return;
                    }
                    await this.nodes.identity!.authenticate(registration.nodeId, credential);
                    await this.nodes.repository.registerRemote(registration.nodeId, registration.name, registration.capabilities, sessionId, registration.platform, registration.version);
                    persisted = true;
                    await this.nodes.identity!.authenticate(registration.nodeId, credential);
                    if (socket.readyState !== WebSocket.OPEN || this.closed || this.generation.get(registration.nodeId) !== revision) throw new Error('Stale registration');
                    clearTimeout(registrationTimer);
                    const runtime = new RemoteNodeRuntime(socket, registration.capabilities);
                    const now = Date.now();
                    session = { id: sessionId, socket, runtime, lastPong: now, lastPersisted: now, heartbeat: setInterval(() => this.heartbeat(registration.nodeId, session!), this.timing.heartbeatMs) };
                    const previous = this.sessions.get(registration.nodeId);
                    this.sessions.set(registration.nodeId, session);
                    this.nodes.attachRemote(registration.nodeId, runtime);
                    id = registration.nodeId;
                    await this.nodes.identity!.audit(this.nodes.identity!.pool, 'node.connected', { nodeId: registration.nodeId });
                    if (previous) { previous.runtime.dispose(); previous.socket.close(1000, 'Replaced by newer session'); }
                    socket.send(JSON.stringify(registeredSchema.parse({ type: 'registered', protocol: NODE_PROTOCOL_VERSION, nodeId: id })));
                } catch (error) {
                    if (persisted && !session) await this.nodes.repository.offline(registration.nodeId, sessionId).catch(() => undefined);
                    socket.close(1008, error instanceof Error ? error.message.slice(0, 100) : 'Authentication failed');
                }
                finally {
                    release();
                    if (this.registrations.get(registration.nodeId) === thisRegistration) this.registrations.delete(registration.nodeId);
                }
                return;
            }
            if (!session?.runtime.receive(message)) socket.close(1008, 'Invalid response');
        });
        socket.on('pong', () => {
            if (!id || !session || this.sessions.get(id) !== session) return;
            session.lastPong = Date.now(); this.nodes.seenRemote(id);
            if (Date.now() - session.lastPersisted >= this.timing.persistMs) {
                session.lastPersisted = Date.now();
                void this.nodes.repository.touch(id, session.id).catch(() => undefined);
            }
        });
        socket.on('close', () => { clearTimeout(registrationTimer); if (id && session) this.track(this.disconnect(id, session)); });
        socket.on('error', () => { socket.terminate(); });
    }
    private heartbeat(id: string, session: Session) {
        if (this.sessions.get(id) !== session) return;
        if (Date.now() - session.lastPong > this.timing.staleMs) { session.socket.terminate(); return; }
        if (session.socket.readyState === WebSocket.OPEN) session.socket.ping();
    }
    private async disconnect(id: string, session: Session) {
        clearInterval(session.heartbeat);
        session.runtime.dispose();
        if (this.sessions.get(id) !== session) return;
        this.sessions.delete(id);
        this.nodes.detachRemote(id, session.runtime);
        await this.nodes.repository.offline(id, session.id);
        await this.nodes.identity!.audit(this.nodes.identity!.pool, 'node.disconnected', { nodeId: id });
    }
    async close() {
        this.closed = true;
        const sessions = [...this.sessions]; this.sessions.clear();
        await Promise.all(sessions.map(async ([id, session]) => {
            clearInterval(session.heartbeat); session.runtime.dispose(); session.socket.terminate();
            this.nodes.detachRemote(id, session.runtime);
            await this.nodes.repository.offline(id, session.id);
        }));
        while (this.pendingLifecycle.size) await Promise.allSettled([...this.pendingLifecycle]);
        this.sockets.close();
    }
    get connectedCount() { return this.sessions.size; }
}
