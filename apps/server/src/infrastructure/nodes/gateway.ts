import { randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { registrationSchema, registeredSchema, MAX_NODE_FRAME_BYTES, NODE_PROTOCOL_VERSION } from '../../nodes/protocol.js';
import type { NodeService } from '../../nodes/service.js';
import { RemoteNodeRuntime } from './remote-runtime.js';
import { deviceShareSubmissionSchema, deviceShareRecipientsRequestSchema, deviceShareRecipientsResultSchema,
    deviceInboxEnqueueSchema, deviceInboxListSchema, deviceInboxReadSchema, deviceInboxDecideSchema } from '@atlas/protocol/device-protocol';
import type { DeviceOfflineInbox } from '../../nodes/offline-inbox.js';
import { DeviceShareRelay } from './share-relay.js';
import type { NodeShareApprovals } from '../../nodes/share-approvals.js';
import { AtlasError } from '../../shared/errors.js';

export interface GatewayTiming { heartbeatMs: number; staleMs: number; registrationMs: number; persistMs: number }
const DEFAULT_TIMING: GatewayTiming = { heartbeatMs: 15_000, staleMs: 45_000, registrationMs: 5_000, persistMs: 60_000 };
type Session = { id: string; socket: WebSocket; runtime: RemoteNodeRuntime; heartbeat: ReturnType<typeof setInterval>; lastPong: number; lastPersisted: number; lastDirectoryRead: number; directoryPending: boolean; inboxPending: boolean; lastInboxCommand: number };
/** HTTP upgrade boundary. All Workspace execution still flows through NodeRouter. */
export class RemoteNodeGateway {
    private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_NODE_FRAME_BYTES });
    private readonly sessions = new Map<string, Session>();
    private readonly generation = new Map<string, number>();
    private readonly registrations = new Map<string, Promise<void>>();
    private readonly pendingLifecycle = new Set<Promise<unknown>>();
    private closed = false;
    private readonly shares: DeviceShareRelay;
    constructor(readonly nodes: NodeService, private readonly timing = DEFAULT_TIMING, approvedPairs: ReadonlySet<string> = new Set(), managedApprovals?: NodeShareApprovals, private readonly offlineInbox?: DeviceOfflineInbox) {
        this.shares = new DeviceShareRelay(nodes, approvedPairs, managedApprovals);
    }
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
                    session = { id: sessionId, socket, runtime, lastPong: now, lastPersisted: now, lastDirectoryRead: 0, directoryPending: false, inboxPending: false, lastInboxCommand: 0,
                        heartbeat: setInterval(() => this.heartbeat(registration.nodeId, session!), this.timing.heartbeatMs) };
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
            const directory = deviceShareRecipientsRequestSchema.safeParse(message);
            if (directory.success) {
                const originId = id, current = session, requestId = directory.data.requestId;
                const respond = (ok: boolean, value: unknown) => {
                    if (socket.readyState !== WebSocket.OPEN || this.sessions.get(originId) !== current) return;
                    socket.send(JSON.stringify(ok
                        ? { type: 'response', requestId, ok: true, result: value }
                        : { type: 'response', requestId, ok: false, error: value }));
                };
                // Synchronous admission before authentication/database queries.
                const now = Date.now();
                if (!current || this.sessions.get(originId) !== current ||
                    !current.runtime.getCapabilities().includes('device.share.send')) {
                    respond(false, { code: 'SHARE_DENIED', message: 'Recipient lookup is not permitted.' });
                    return;
                }
                if (current.directoryPending || now - current.lastDirectoryRead < 2_000) {
                    respond(false, { code: 'SHARE_RATE_LIMIT', message: 'Refresh recipients less frequently.' });
                    return;
                }
                current.directoryPending = true;
                current.lastDirectoryRead = now;
                const task = (async () => {
                    try {
                        await this.nodes.identity!.authenticate(originId, credential);
                        if (this.sessions.get(originId) !== current)
                            throw new AtlasError('Source Node connection changed.', 'NODE_DISCONNECTED');
                        const recipients = await this.nodes.shareRecipients(originId);
                        respond(true, deviceShareRecipientsResultSchema.parse({ recipients }));
                    } catch (error) {
                        const known = error instanceof AtlasError;
                        respond(false, { code: known ? error.code : 'SHARE_UNAVAILABLE',
                            message: known ? error.message.slice(0, 200) : 'Recipient directory is unavailable.' });
                    } finally {
                        current.directoryPending = false;
                    }
                })();
                this.track(task);
                return;
            }
            const share = deviceShareSubmissionSchema.safeParse(message);
            if (share.success) {
                const originId = id, originSession = session;
                const submission = share.data;
                const task = this.shares.forward({
                    sourceId: originId,
                    sourceRuntime: originSession?.runtime,
                    credential,
                    submission,
                }).then(receipt => {
                    if (socket.readyState === WebSocket.OPEN && this.sessions.get(originId) === originSession)
                        socket.send(JSON.stringify({ type: 'response', requestId: submission.requestId, ok: true, result: receipt }));
                }).catch(error => {
                    if (socket.readyState !== WebSocket.OPEN || this.sessions.get(originId) !== originSession) return;
                    const known = error instanceof AtlasError;
                    socket.send(JSON.stringify({ type: 'response', requestId: submission.requestId, ok: false,
                        error: { code: known ? error.code : 'SHARE_UNAVAILABLE',
                            message: known ? error.message.slice(0, 200) : 'Share delivery is unavailable.' } }));
                });
                this.track(task);
                return;
            }
            // An explicit offline inbox never replaces the synchronous live
            // share path; only registered, capable, authenticated Nodes may use it.
            const enqueue = deviceInboxEnqueueSchema.safeParse(message);
            const listing = deviceInboxListSchema.safeParse(message);
            const reading = deviceInboxReadSchema.safeParse(message);
            const deciding = deviceInboxDecideSchema.safeParse(message);
            if (enqueue.success || listing.success || reading.success || deciding.success) {
                const request = (enqueue.success ? enqueue.data : listing.success ? listing.data
                    : reading.success ? reading.data : deciding.data)!;
                const originId = id, current = session;
                const respond = (ok: boolean, value: unknown) => {
                    if (socket.readyState !== WebSocket.OPEN || this.sessions.get(originId) !== current) return;
                    socket.send(JSON.stringify(ok
                        ? { type:'response',requestId:request.requestId,ok:true,result:value }
                        : { type:'response',requestId:request.requestId,ok:false,error:value }));
                };
                const requires = enqueue.success ? 'device.share.send' : 'device.share.receive';
                const now = Date.now();
                if (!this.offlineInbox || !current || this.sessions.get(originId) !== current ||
                    !current.runtime.getCapabilities().includes(requires) ||
                    current.inboxPending || now-current.lastInboxCommand<500) {
                    respond(false,{code:'SHARE_UNAVAILABLE',message:'Device inbox unavailable or busy.'});
                    return;
                }
                current.inboxPending=true;
                current.lastInboxCommand=now;
                const task = (async () => {
                    try {
                        await this.nodes.identity!.authenticate(originId,credential);
                        if (this.sessions.get(originId)!==current)
                            throw new AtlasError('Node session changed.','NODE_DISCONNECTED');
                        const node = await this.nodes.get(originId);
                        if (node.credentialState!=='active' || !node.capabilities.includes(requires))
                            throw new AtlasError('Inbox capability unavailable.','SHARE_DENIED');
                        let output: unknown;
                        if (enqueue.success) {
                            output=await this.offlineInbox!.enqueue({
                                sourceId:originId,targetId:enqueue.data.targetNodeId,
                                deliveryId:enqueue.data.deliveryId,text:enqueue.data.text,
                            });
                        } else if (listing.success) {
                            output={items:await this.offlineInbox!.list(originId)};
                        } else if (reading.success) {
                            output=await this.offlineInbox!.read(originId,reading.data.deliveryId);
                        } else if (deciding.success) {
                            output=await this.offlineInbox!.decide(originId,deciding.data.deliveryId,deciding.data.decision);
                        } else {
                            throw new AtlasError('Invalid inbox request.','INVALID_REQUEST');
                        }
                        respond(true,output);
                    } catch(error) {
                        const known=error instanceof AtlasError;
                        respond(false,{code:known?error.code:'SHARE_UNAVAILABLE',
                            message:known?error.message.slice(0,200):'Offline inbox unavailable.'});
                    } finally { current.inboxPending=false; }
                })();
                this.track(task);
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
