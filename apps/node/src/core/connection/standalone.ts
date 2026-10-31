import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { AtlasError } from '@atlas/protocol/errors';
import { MAX_NODE_FRAME_BYTES, NODE_PROTOCOL_VERSION, nodeRequestSchema, registeredSchema, validateNodeOperation } from '@atlas/protocol/node-protocol';
import { requiredCapability } from '@atlas/protocol/runtime';
import { deviceShareDeliverySchema, deviceShareReceiptSchema,
    deviceShareRecipientsResultSchema, deviceShareTextSchema, deviceShareQueueReceiptSchema } from '@atlas/protocol/device-protocol';
import { z } from 'zod';
import type { NodeRuntime } from '@atlas/protocol/runtime';

export interface StandaloneNodeConfig {
    id: string; name: string; platform?: string; version?: string; serverUrl: string; token: string;
    reconnectMinMs?: number; reconnectMaxMs?: number;
    heartbeatMs?: number; heartbeatTimeoutMs?: number;
}
/** Outbound-only Node connection. Socket state never changes the trusted local runtime policy. */
export class StandaloneNode extends EventEmitter {
    private socket?: WebSocket;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private registrationTimer?: ReturnType<typeof setTimeout>;
    private heartbeatTimer?: ReturnType<typeof setInterval>;
    private reconnectAttempt = 0;
    private errorReported = false;
    private running = false;
    private registered = false;
    private readonly inFlight = new Set<Promise<void>>();
    private readonly outbound = new Map<string, {
        resolve: (value: unknown) => void; reject: (reason: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    constructor(readonly config: StandaloneNodeConfig, readonly runtime: NodeRuntime & { close?: () => void }) { super(); }
    start() { if (this.running) return; this.running = true; this.connect(); }
    private connect() {
        if (!this.running) return;
        const socket = new WebSocket(this.config.serverUrl, { headers: { Authorization: `Bearer ${this.config.token}` }, maxPayload: MAX_NODE_FRAME_BYTES, handshakeTimeout: 15_000 });
        this.socket = socket; this.registered = false; this.errorReported = false;
        let lastPong = Date.now();
        const heartbeatMs = this.config.heartbeatMs ?? 15_000;
        const heartbeatTimeoutMs = this.config.heartbeatTimeoutMs ?? 45_000;
        const clearHeartbeat = () => { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; };
        socket.on('pong', () => { lastPong = Date.now(); });
        socket.on('open', () => {
            lastPong = Date.now();
            clearHeartbeat();
            this.heartbeatTimer = setInterval(() => {
                if (!this.running || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
                // A sleeping Mac can leave the TCP/WebSocket looking open after the server
                // has already discarded it. Tear it down so normal backoff reconnects.
                if (Date.now() - lastPong > heartbeatTimeoutMs) {
                    this.emit('connectionError', 'WebSocket heartbeat timed out; reconnecting');
                    socket.terminate();
                    return;
                }
                socket.ping();
            }, heartbeatMs);
            this.heartbeatTimer.unref();
            socket.send(JSON.stringify({ type: 'register', protocol: NODE_PROTOCOL_VERSION,
                nodeId: this.config.id, name: this.config.name, platform: this.config.platform ?? process.platform, ...(this.config.version && { version: this.config.version }), capabilities: this.runtime.getCapabilities() }));
            this.registrationTimer = setTimeout(() => socket.close(1008, 'Registration timeout'), 5_000);
        });
        socket.on('message', bytes => {
            let message: unknown;
            try { message = JSON.parse(String(bytes)); } catch { socket.close(1008, 'Invalid JSON'); return; }
            if (!this.registered) {
                const parsed = registeredSchema.safeParse(message);
                if (!parsed.success || parsed.data.nodeId !== this.config.id) { socket.close(1008, 'Invalid registration acknowledgement'); return; }
                clearTimeout(this.registrationTimer);
                this.registered = true; this.reconnectAttempt = 0; this.errorReported = false; this.emit('online'); return;
            }
            // Responses to local outbound requests share this same authenticated
            // socket with incoming requests. Unsolicited/late replies are ignored.
            if (message && typeof message === 'object' && 'type' in message &&
                message.type === 'response') {
                const reply = message as { requestId?: unknown; ok?: unknown; result?: unknown; error?: unknown };
                if (typeof reply.requestId !== 'string') return;
                const waiting = this.outbound.get(reply.requestId);
                if (!waiting || socket !== this.socket) return;
                this.outbound.delete(reply.requestId);
                clearTimeout(waiting.timer);
                if (reply.ok === true) waiting.resolve(reply.result);
                else {
                    const error = reply.error as { code?: unknown } | undefined;
                    const code = typeof error?.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code)
                        ? error.code : 'SHARE_UNAVAILABLE';
                    waiting.reject(new AtlasError('Atlas did not confirm the share request.', code));
                }
                return;
            }
            const share = deviceShareDeliverySchema.safeParse(message);
            if (share.success) {
                if (this.inFlight.size >= 32) { this.reply(socket, share.data.requestId, false, { code: 'NODE_BUSY', message: 'Node execution limit reached.' }); return; }
                const task = this.handleShare(socket, share.data).finally(() => this.inFlight.delete(task));
                this.inFlight.add(task);
                return;
            }
            const parsed = nodeRequestSchema.safeParse(message);
            if (!parsed.success) { socket.close(1008, 'Invalid request'); return; }
            if (this.inFlight.size >= 32) { this.reply(socket, parsed.data.requestId, false, { code: 'NODE_BUSY', message: 'Node execution limit reached.' }); return; }
            const task = this.handle(socket, parsed.data).finally(() => this.inFlight.delete(task));
            this.inFlight.add(task);
        });
        socket.on('error', error => {
            if (!this.errorReported) { this.errorReported = true; this.emit('connectionError', error.message.slice(0, 200)); }
            // Close drives one bounded reconnect path. Never log credentials.
        });
        socket.on('close', (code, reason) => {
            // Diagnostics only: never emit the credential or the full server URL.
            this.emit('socketClosed', code, String(reason).slice(0, 120));
            if (!this.registered && reason.length && !this.errorReported) { this.errorReported = true; this.emit('connectionError', String(reason).slice(0, 200)); }
            clearTimeout(this.registrationTimer);
            clearHeartbeat();
            if (this.socket !== socket) return;
            this.rejectOutbound('NODE_DISCONNECTED');
            this.socket = undefined;
            const wasOnline = this.registered; this.registered = false;
            if (wasOnline) this.emit('offline');
            if (this.running) this.scheduleReconnect();
        });
    }
    private async handleShare(socket: WebSocket, request: ReturnType<typeof deviceShareDeliverySchema.parse>) {
        try {
            if (!this.runtime.getCapabilities().includes('device.share.receive') || !this.runtime.receiveDeviceShare)
                throw new AtlasError('Device sharing is not enabled on this Node.', 'CAPABILITY_UNAVAILABLE');
            if (Date.parse(request.expiresAt) <= Date.now())
                throw new AtlasError('Share has expired.', 'SHARE_EXPIRED');
            const receipt = deviceShareReceiptSchema.parse(await this.runtime.receiveDeviceShare({
                deliveryId: request.deliveryId,
                sourceNodeId: request.sourceNodeId,
                text: request.text,
                expiresAt: request.expiresAt,
            }));
            this.reply(socket, request.requestId, true, receipt);
        } catch (error) {
            const known = error instanceof AtlasError;
            this.reply(socket, request.requestId, false, {
                code: known ? error.code : 'SHARE_REJECTED',
                message: known ? error.message.slice(0, 200) : 'Device share was not accepted.',
            });
        }
    }

    private async handle(socket: WebSocket, request: ReturnType<typeof nodeRequestSchema.parse>) {
        try {
            let result: unknown;
            if (request.kind === 'bind') {
                result = await this.runtime.bind(request.rootPath);
            } else if (request.kind === 'node_logs') {
                if (!this.runtime.getCapabilities().includes('node.logs') || !this.runtime.readLogs)
                    throw new AtlasError('This Node does not offer log access.', 'CAPABILITY_UNAVAILABLE');
                result = await this.runtime.readLogs(request.source, request.lines);
            } else {
                const { workspace, operation } = request;
                if (workspace.nodeId !== this.config.id || workspace.status !== 'active') throw new AtlasError('Workspace is not hosted by this Node.', 'WORKSPACE_DENIED');
                if (!this.runtime.getCapabilities().includes(requiredCapability[operation])) throw new AtlasError('Node lacks the required capability.', 'CAPABILITY_UNAVAILABLE');
                try { if (await this.runtime.bind(workspace.rootPath) !== workspace.rootPath) throw new Error('Binding changed'); }
                catch { throw new AtlasError('Assigned Workspace is unavailable on this Node.', 'WORKSPACE_UNAVAILABLE'); }
                const parsed = validateNodeOperation(operation, request.input);
                if (!parsed.success) throw new AtlasError('Invalid Workspace operation input.');
                result = await this.runtime.execute(workspace, operation, parsed.data);
            }
            this.reply(socket, request.requestId, true, result);
        } catch (error) {
            const known = error instanceof AtlasError;
            this.reply(socket, request.requestId, false, { code: known ? error.code : 'NODE_EXECUTION_ERROR', message: known ? error.message.slice(0, 500) : 'Node operation failed.' });
        }
    }
    private reply(socket: WebSocket, requestId: string, ok: boolean, payload: unknown) {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify(ok ? { type: 'response', requestId, ok: true, result: payload } : { type: 'response', requestId, ok: false, error: payload }));
    }
    /**
     * Uses the already-registered Node identity and current WebSocket. No
     * duplicate registration or direct credential handoff to the local CLI.
     * The Server independently verifies directional approvals for every send.
     */
    private requestOutbound(kind: 'directory' | 'share', body: Record<string, unknown>): Promise<unknown> {
        const socket = this.socket;
        if (!this.running || !this.registered || !socket || socket.readyState !== WebSocket.OPEN ||
            !this.runtime.getCapabilities().includes('device.share.send'))
            return Promise.reject(new AtlasError('Mac Node sharing is offline or disabled.', 'SHARE_UNAVAILABLE'));
        if (this.outbound.size >= 2)
            return Promise.reject(new AtlasError('Another share operation is active.', 'SHARE_BUSY'));
        const requestId = randomUUID();
        const timeoutMs = kind === 'directory' ? 10_000 : 55_000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.outbound.delete(requestId);
                reject(new AtlasError('Share was not confirmed; do not automatically retry.', 'NODE_TIMEOUT'));
            }, timeoutMs);
            this.outbound.set(requestId, { resolve, reject, timer });
            try {
                socket.send(JSON.stringify({ ...body, requestId }), error => {
                    if (!error) return;
                    const pending = this.outbound.get(requestId);
                    if (!pending) return;
                    this.outbound.delete(requestId);
                    clearTimeout(timer);
                    reject(new AtlasError('Share could not be submitted.', 'NODE_DISCONNECTED'));
                });
            } catch {
                this.outbound.delete(requestId);
                clearTimeout(timer);
                reject(new AtlasError('Share could not be submitted.', 'NODE_DISCONNECTED'));
            }
        });
    }

    async shareRecipients() {
        const result = await this.requestOutbound('directory', { type: 'device.share.recipients' });
        return deviceShareRecipientsResultSchema.parse(result).recipients;
    }

    async sendDeviceShare(targetNodeId: string, text: string): Promise<{ accepted: boolean }> {
        const id = z.string().uuid().parse(targetNodeId);
        const payload = deviceShareTextSchema.parse(text);
        if (payload.trim().length === 0)
            throw new AtlasError('Share text cannot be blank.', 'SHARE_INVALID');
        const result = await this.requestOutbound('share', {
            type: 'device.share.submit', deliveryId: randomUUID(), targetNodeId: id, text: payload,
        });
        return deviceShareReceiptSchema.parse(result);
    }

    /** Server confirms durable queue admission, not clipboard delivery. */
    async queueDeviceShare(targetNodeId: string, text: string): Promise<{
        state: 'queued' | 'copied' | 'declined' | 'expired'; expiresAt: string;
    }> {
        const id = z.string().uuid().parse(targetNodeId);
        const payload = deviceShareTextSchema.parse(text);
        if (!payload.trim()) throw new AtlasError('Share text cannot be blank.', 'SHARE_INVALID');
        const result = await this.requestOutbound('share', {
            type: 'device.share.queue', deliveryId: randomUUID(), targetNodeId: id, text: payload,
        });
        return deviceShareQueueReceiptSchema.parse(result);
    }

    private rejectOutbound(code: string) {
        for (const [id, pending] of this.outbound) {
            this.outbound.delete(id);
            clearTimeout(pending.timer);
            pending.reject(new AtlasError('Share result is unconfirmed after a disconnect.', code));
        }
    }

    private scheduleReconnect() {
        const delay = Math.min((this.config.reconnectMinMs ?? 250) * 2 ** Math.min(this.reconnectAttempt++, 8), this.config.reconnectMaxMs ?? 15_000);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }
    async stop() {
        this.running = false;
        clearTimeout(this.reconnectTimer); clearTimeout(this.registrationTimer); clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined;
        this.runtime.close?.();
        this.rejectOutbound('NODE_DISCONNECTED');
        const socket = this.socket;
        if (socket?.readyState === WebSocket.OPEN) socket.close(1000, 'Node shutdown');
        if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled([...this.inFlight]), new Promise(resolve => { timeout = setTimeout(resolve, 3_000); })]);
        clearTimeout(timeout);
        this.socket = undefined; this.registered = false;
    }
    get isOnline() { return this.registered; }
}
