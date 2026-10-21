import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { nodeStatusPath } from './node-installation.js';
import { NodeFileTransferError, uploadNodeFileResumable } from './file-transfer.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
const MAGIC = Buffer.from('ATLASQ01');
const VERSION = 1;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_QUEUE_DISK_BYTES = 128 * 1024 * 1024;
export const MAX_QUEUE_ITEMS = 8;
const MAX_JOB_BYTES = 36 * 1024 * 1024;
const MAX_ATTEMPTS = 20;

type Status = 'queued' | 'blocked';
type Payload = {
    version: number; uploadId: string; workspaceId: string;
    fileName: string; mimeType: string; sha256: string; base64: string;
    status: Status; attempts: number; nextAttemptAt: number; 
};
export type QueueSnapshot = {
    total: number; ready: number; deferred: number; blocked: number; encryptedDiskBytes: number;
};
export type DrainResult = { delivered: number; deferred: number; blocked: number };
export type QueueIdentity = { nodeId: string; credential: string; serverUrl: string };
export type QueuedUpload = QueueIdentity & {
    workspaceId: string; uploadId: string; fileName: string; mimeType: string; bytes: Uint8Array;
};
type Sender = (upload: QueuedUpload) => Promise<{ fileId: string; replayed: boolean }>;

function verifyPayload(payload: unknown, id: string): asserts payload is Payload {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid encrypted Atlas upload queue record.');
    const p = payload as Partial<Payload>;
    if (p.version !== VERSION || p.uploadId !== id || !UUID.test(p.workspaceId ?? '') ||
        typeof p.fileName !== 'string' || !p.fileName.trim() || p.fileName.length > 255 ||
        /[\/\\\u0000-\u001f]/.test(p.fileName) || typeof p.mimeType !== 'string' ||
        !MIME.test(p.mimeType) || typeof p.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(p.sha256) || typeof p.base64 !== 'string' ||
        p.base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 ||
        (p.status !== 'queued' && p.status !== 'blocked') ||
        !Number.isInteger(p.attempts) || p.attempts! < 0 || p.attempts! > MAX_ATTEMPTS ||
        !Number.isSafeInteger(p.nextAttemptAt) || p.nextAttemptAt! < 0)
        throw new Error('Invalid encrypted Atlas upload queue record.');
    const bytes = Buffer.from(p.base64, 'base64');
    if (bytes.length < 1 || bytes.length > MAX_FILE_BYTES ||
        createHash('sha256').update(bytes).digest('hex') !== p.sha256)
        throw new Error('Atlas upload queue integrity check failed.');
}
function deriveKey(nodeId: string, credential: string): Buffer {
    // The credential is random high-entropy secret material. Do not store it
    // (or the derived key) on disk. Credential rotation invalidates old queue
    // entries: an operator must explicitly discard those inaccessible files.
    return Buffer.from(hkdfSync('sha256', Buffer.from(credential, 'utf8'),
        Buffer.from(nodeId.toLowerCase(), 'utf8'), Buffer.from('atlas.node.offline.files.v1'), 32));
}
function validRoot(root: string) {
    if (!isAbsolute(root)) throw new Error('Queue state directory must be absolute.');
}
function validateNewUpload(input: {workspaceId: string; fileName: string; mimeType: string; bytes: Uint8Array}) {
    if (!UUID.test(input.workspaceId) || typeof input.fileName !== 'string' ||
        !input.fileName.trim() || input.fileName.length > 255 || /[\/\\\u0000-\u001f]/.test(input.fileName) ||
        !MIME.test(input.mimeType) || !(input.bytes instanceof Uint8Array) ||
        input.bytes.length < 1 || input.bytes.length > MAX_FILE_BYTES)
        throw new Error('Invalid offline Node file upload.');
}
function dueDelay(attempts: number): number {
    const base = 30_000 * 2 ** Math.min(Math.max(0, attempts - 1), 7);
    return Math.min(base, 60 * 60_000);
}
function permanent(error: unknown): boolean {
    const status = error instanceof NodeFileTransferError ? error.httpStatus : undefined;
    return status !== undefined && [400, 401, 403, 404, 409, 413, 507].includes(status);
}

/** Encrypted, private, bounded spool for an explicitly selected local file.
 *
 * The queue stores neither credentials nor secrets; payload bytes and metadata
 * are authenticated with AES-256-GCM using a node-credential-derived key.
 * A single Node worker owns flush() for a given directory. Enqueue uses an
 * exclusive short-lived reservation lock for concurrent local CLI producers.
 * No upload occurs until the caller explicitly enables the worker.
 */
export class NodeOfflineFileQueue {
    private readonly key: Buffer;
    private running?: Promise<DrainResult>;
    readonly directory: string;
    constructor(readonly identity: QueueIdentity, directory = join(nodeStatusPath(), '..', 'file-queue'),
        readonly send: Sender = uploadNodeFileResumable) {
        if (!UUID.test(identity.nodeId) || identity.credential.length < 32)
            throw new Error('Node offline queue requires an enrolled Node identity.');
        validRoot(directory);
        this.directory = directory;
        this.key = deriveKey(identity.nodeId, identity.credential);
    }

    private async ensureDirectory() {
        await mkdir(this.directory, {recursive: true, mode: 0o700});
        const dir = await lstat(this.directory);
        if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Unsafe Node offline queue directory.');
        await chmod(this.directory, 0o700);
    }

    private path(id: string) {
        if (!UUID.test(id)) throw new Error('Invalid Node queue UUID.');
        return join(this.directory, id.toLowerCase() + '.job');
    }

    private seal(payload: Payload): Buffer {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from('atlas.node.queue:' + this.identity.nodeId.toLowerCase() + ':' + payload.uploadId));
        const contents = Buffer.from(JSON.stringify(payload), 'utf8');
        return Buffer.concat([MAGIC, iv, cipher.update(contents), cipher.final(), cipher.getAuthTag()]);
    }

    private unseal(data: Buffer, id: string): Payload {
        if (data.length < 8 + 12 + 16 || !data.subarray(0, 8).equals(MAGIC))
            throw new Error('Invalid encrypted Atlas queue file.');
        const iv = data.subarray(8, 20);
        const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
        decipher.setAAD(Buffer.from('atlas.node.queue:' + this.identity.nodeId.toLowerCase() + ':' + id));
        decipher.setAuthTag(data.subarray(data.length - 16));
        const plaintext = Buffer.concat([decipher.update(data.subarray(20, data.length - 16)), decipher.final()]);
        const record = JSON.parse(plaintext.toString('utf8')) as unknown;
        verifyPayload(record, id);
        return record;
    }

    private async read(id: string): Promise<Payload> {
        const location = this.path(id);
        // O_NOFOLLOW is supported on macOS/Linux, where desktop Nodes run.
        const file = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > MAX_JOB_BYTES || stat.size < 36 || (stat.mode & 0o077))
                throw new Error('Unsafe Node offline queue file.');
            return this.unseal(await file.readFile(), id.toLowerCase());
        } finally { await file.close(); }
    }

    private async records(): Promise<{id: string; size: number}[]> {
        await this.ensureDirectory();
        const entries = await readdir(this.directory, {withFileTypes:true});
        const files: {id:string;size:number}[] = [];
        for (const entry of entries) {
            if (!entry.name.endsWith('.job') || !entry.isFile()) continue;
            const id = entry.name.slice(0, -4);
            if (!UUID.test(id) || id !== id.toLowerCase()) continue;
            const stat = await lstat(this.path(id));
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOB_BYTES || (stat.mode & 0o077))
                throw new Error('Unsafe Node offline queue file.');
            files.push({id,size:stat.size});
        }
        return files.sort((a,b)=>a.id.localeCompare(b.id));
    }

    private async atomicWrite(id: string, data: Buffer) {
        const dest = this.path(id);
        const temp = join(this.directory, '.' + id + '.' + randomUUID() + '.tmp');
        const file = await open(temp, 'wx', 0o600);
        try {
            await file.writeFile(data);
            await file.sync();
        } catch (error) {
            await file.close();
            await rm(temp, {force:true});
            throw error;
        }
        await file.close();
        try { await rename(temp,dest); }
        catch (error) { await rm(temp,{force:true});throw error; }
    }

    async enqueue(input: { workspaceId: string; fileName: string; mimeType: string; bytes: Uint8Array}): Promise<string> {
        validateNewUpload(input);
        await this.ensureDirectory();
        // O_EXCL directory reservation, shared by independent CLI writers. A
        // crashed producer leaves a stale lock, intentionally requiring manual
        // inspection rather than guessing which bytes are durable.
        const lock = join(this.directory,'.enqueue-lock');
        await mkdir(lock, {mode:0o700});
        try {
            const jobs = await this.records();
            if (jobs.length >= MAX_QUEUE_ITEMS) throw new Error('Node queue item limit reached.');
            const uploadId = randomUUID();
            const bytes = Buffer.from(input.bytes);
            const record: Payload = {
                version: VERSION, uploadId,workspaceId:input.workspaceId.toLowerCase(),
                fileName:input.fileName,mimeType:input.mimeType,
                sha256:createHash('sha256').update(bytes).digest('hex'),
                base64:bytes.toString('base64'), status:'queued', attempts:0, nextAttemptAt:0,
            };
            const sealed = this.seal(record);
            if (jobs.reduce((n,x)=>n+x.size,0) + sealed.length > MAX_QUEUE_DISK_BYTES)
                throw new Error('Node queue encrypted disk budget reached.');
            await this.atomicWrite(uploadId, sealed);
            return uploadId;
        } finally { await rm(lock,{recursive:false,force:false}); }
    }

    async snapshot(now = Date.now()): Promise<QueueSnapshot> {
        const jobs = await this.records();
        let ready=0,deferred=0,blocked=0;
        for (const job of jobs) {
            const record = await this.read(job.id);
            if (record.status === 'blocked') blocked++;
            else if (record.nextAttemptAt <= now) ready++;
            else deferred++;
        }
        return {total:jobs.length,ready,deferred,blocked,
            encryptedDiskBytes:jobs.reduce((n,x)=>n+x.size,0)};
    }

    /** Re-enqueue failed/stale uploads ONLY on an explicit user action; never
     * silently change an upload UUID after a server-side expiry (HTTP 409). */
    async restartWithNewId(oldId: string): Promise<string> {
        const record = await this.read(oldId);
        if (record.status !== 'blocked') throw new Error('Only blocked uploads may be explicitly restarted.');
        const next = await this.enqueue({workspaceId:record.workspaceId,fileName:record.fileName,
            mimeType:record.mimeType,bytes:Buffer.from(record.base64,'base64')});
        await unlink(this.path(oldId));
        return next;
    }

    async discard(id: string): Promise<void> {
        // Explicit operator action only. Never let a web/MCP command do this.
        await this.read(id);
        await unlink(this.path(id));
    }

    flush(now = Date.now(), maxJobs = 4): Promise<DrainResult> {
        if (this.running) return this.running;
        this.running = this.drain(now, maxJobs).finally(()=>{this.running=undefined;});
        return this.running;
    }

    private async drain(now: number,maxJobs: number): Promise<DrainResult> {
        if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(maxJobs) || maxJobs<1 || maxJobs>4)
            throw new Error('Invalid Node queue drain limits.');
        const entries = (await this.records()).slice(0,maxJobs);
        let delivered=0,deferred=0,blocked=0;
        for (const entry of entries) {
            const record=await this.read(entry.id);
            if (record.status === 'blocked') {blocked++;continue;}
            if (record.nextAttemptAt>now) {deferred++;continue;}
            try {
                await this.send({ ...this.identity, workspaceId:record.workspaceId,
                    uploadId:record.uploadId,fileName:record.fileName,mimeType:record.mimeType,
                    bytes:Buffer.from(record.base64,'base64')});
                await unlink(this.path(entry.id));
                delivered++;
            } catch(error) {
                const isPermanent = permanent(error);
                const attempts = Math.min(record.attempts+1,MAX_ATTEMPTS);
                const updated:Payload = {...record,status:isPermanent ? 'blocked' : 'queued',
                    attempts,nextAttemptAt:isPermanent ? 0 : now+dueDelay(attempts)};
                await this.atomicWrite(entry.id,this.seal(updated));
                if (isPermanent) blocked++; else deferred++;
            }
        }
        return {delivered,deferred,blocked};
    }
}
