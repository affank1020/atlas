import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AtlasError } from '@atlas/protocol/errors';
import { MAX_NODE_FRAME_BYTES, NODE_PROTOCOL_VERSION, nodeRequestSchema, registeredSchema, validateNodeOperation } from '@atlas/protocol/node-protocol';
import { requiredCapability } from '@atlas/protocol/runtime';
import type { NodeRuntime } from '@atlas/protocol/runtime';

export interface StandaloneNodeConfig { id: string; name: string; platform?: string; version?: string; serverUrl: string; token: string; reconnectMinMs?: number; reconnectMaxMs?: number }
/** Outbound-only Node connection. Socket state never changes the trusted local runtime policy. */
export class StandaloneNode extends EventEmitter {
    private socket?: WebSocket;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private registrationTimer?: ReturnType<typeof setTimeout>;
    private reconnectAttempt = 0;
    private errorReported = false;
    private running = false;
    private registered = false;
    private readonly inFlight = new Set<Promise<void>>();
    constructor(readonly config: StandaloneNodeConfig, readonly runtime: NodeRuntime & { close?: () => void }) { super(); }
    start() { if (this.running) return; this.running = true; this.connect(); }
    private connect() {
        if (!this.running) return;
        const socket = new WebSocket(this.config.serverUrl, { headers: { Authorization: `Bearer ${this.config.token}` }, maxPayload: MAX_NODE_FRAME_BYTES });
        this.socket = socket; this.registered = false;
        socket.on('open', () => {
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
        socket.on('close', (_code, reason) => {
            if (!this.registered && reason.length && !this.errorReported) { this.errorReported = true; this.emit('connectionError', String(reason).slice(0, 200)); }
            clearTimeout(this.registrationTimer);
            if (this.socket !== socket) return;
            this.socket = undefined;
            const wasOnline = this.registered; this.registered = false;
            if (wasOnline) this.emit('offline');
            if (this.running) this.scheduleReconnect();
        });
    }
    private async handle(socket: WebSocket, request: ReturnType<typeof nodeRequestSchema.parse>) {
        try {
            let result: unknown;
            if (request.kind === 'bind') {
                result = await this.runtime.bind(request.rootPath);
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
    private scheduleReconnect() {
        const delay = Math.min((this.config.reconnectMinMs ?? 250) * 2 ** Math.min(this.reconnectAttempt++, 8), this.config.reconnectMaxMs ?? 15_000);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }
    async stop() {
        this.running = false;
        clearTimeout(this.reconnectTimer); clearTimeout(this.registrationTimer);
        this.runtime.close?.();
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
