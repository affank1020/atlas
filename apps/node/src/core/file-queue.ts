import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
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
    version: number; jobId: string; uploadId: string; workspaceId: string;
    fileName: string; mimeType: string; sha256: string; base64: string;
    status: Status; attempts: number; nextAttemptAt: number; 
};
export type QueueSnapshot = {
    total: number; ready: number; deferred: number; blocked: number; unreadable: number; encryptedDiskBytes: number;
};
export type DrainResult = { delivered: number; deferred: number; blocked: number; unreadable: number };
export type QueueIdentity = { nodeId: string; credential: string; serverUrl: string };
export type QueuedUpload = QueueIdentity & {
    workspaceId: string; uploadId: string; fileName: string; mimeType: string; bytes: Uint8Array;
};
type Sender = (upload: QueuedUpload) => Promise<{ fileId: string; replayed: boolean }>;

function verifyPayload(payload: unknown, id: string): asserts payload is Payload {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid encrypted Atlas upload queue record.');
    const p = payload as Partial<Payload>;
    if (p.version !== VERSION || p.jobId !== id || !UUID.test(p.uploadId ?? '') || !UUID.test(p.workspaceId ?? '') ||
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
        cipher.setAAD(Buffer.from('atlas.node.queue:' + this.identity.nodeId.toLowerCase() + ':' + payload.jobId));
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
            if (!entry.name.endsWith('.job')) continue;
            const id = entry.name.slice(0, -4);
            if (!UUID.test(id) || id !== id.toLowerCase()) continue;
            // Include symlinks, incorrect permissions and oversized records
            // in the unreadable count; never follow or silently ignore them.
            const stat = await lstat(this.path(id));
            files.push({id,size:stat.size});
        }
        return files.sort((a,b)=>a.id.localeCompare(b.id));
    }

    /** One directory-level cross-process mutation lock shared by the Node
     * worker and every operator CLI action. It covers the *whole* send call:
     * discard only succeeds after an in-flight send finishes. If busy, the
     * operator receives an explicit error, never a false cancellation ack.
     * A lock left by a crashed process is inspected manually (fail closed).
     */
    private async withLock<T>(action: () => Promise<T>): Promise<T> {
        await this.ensureDirectory();
        const lock = join(this.directory,'.queue-lock');
        try { await mkdir(lock,{mode:0o700}); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST')
                throw new Error('Node file queue is busy. Retry once the current operation finishes.');
            throw error;
        }
        try { return await action(); }
        finally { await rmdir(lock); }
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

    async enqueue(input: {workspaceId: string; fileName: string; mimeType: string; bytes: Uint8Array}): Promise<string> {
        validateNewUpload(input);
        return this.withLock(async () => {
            const jobs = await this.records();
            if (jobs.length >= MAX_QUEUE_ITEMS) throw new Error('Node queue item limit reached.');
            const uploadId = randomUUID();
            const bytes = Buffer.from(input.bytes);
            const record: Payload = {
                version:VERSION,jobId:uploadId,uploadId,workspaceId:input.workspaceId.toLowerCase(),
                fileName:input.fileName,mimeType:input.mimeType,
                sha256:createHash('sha256').update(bytes).digest('hex'),
                base64:bytes.toString('base64'),status:'queued',attempts:0,nextAttemptAt:0,
            };
            const sealed = this.seal(record);
            if (jobs.reduce((n,x)=>n+x.size,0) + sealed.length > MAX_QUEUE_DISK_BYTES)
                throw new Error('Node queue encrypted disk budget reached.');
            await this.atomicWrite(uploadId,sealed);
            return uploadId;
        });
    }

    async snapshot(now = Date.now()): Promise<QueueSnapshot> {
        const jobs = await this.records();
        let ready=0,deferred=0,blocked=0,unreadable=0;
        for (const job of jobs) {
            // Unreadable records are never silently dropped or uploaded. A
            // rotated credential must not prevent inspecting healthy jobs.
            try {
                const record = await this.read(job.id);
                if (record.status === 'blocked') blocked++;
                else if (record.nextAttemptAt <= now) ready++;
                else deferred++;
            } catch { unreadable++; }
        }
        return {total:jobs.length,ready,deferred,blocked,unreadable,
            encryptedDiskBytes:jobs.reduce((n,x)=>n+x.size,0)};
    }

    /** Explicit user acknowledgement only. Stable local job ID, new remote
     * upload UUID. A single atomic rewrite replaces the blocked record, so
     * it works at a full 8-job / 128-MiB quota without making a second copy.
     * Crash before rename: old ID is retained; after rename: new ID wins.
     * Never silently rotate a server upload ID.
     */
    async restartWithNewId(jobId: string): Promise<string> {
        return this.withLock(async () => {
            const record = await this.read(jobId);
            if (record.status !== 'blocked')
                throw new Error('Only blocked uploads may be explicitly restarted.');
            const uploadId = randomUUID();
            const updated:Payload = {...record,uploadId,status:'queued',attempts:0,nextAttemptAt:0};
            const sealed = this.seal(updated);
            const jobs = await this.records();
            const existing = jobs.find(x=>x.id===jobId.toLowerCase());
            if (!existing) throw new Error('Node offline queue record missing.');
            // Compare replacement length, not old+new: rename never increases
            // retained queue slots. Its one temporary file is transient.
            if (jobs.reduce((n,x)=>n+x.size,0) - existing.size + sealed.length > MAX_QUEUE_DISK_BYTES)
                throw new Error('Node queue encrypted disk budget reached.');
            await this.atomicWrite(jobId,sealed);
            return uploadId;
        });
    }

    async discard(id: string): Promise<void> {
        // Works even after credential rotation or record corruption. Validate
        // opaque UUID and file type/permissions WITHOUT decrypting contents.
        // Cross-process lock prevents a worker resurrecting a discarded job.
        await this.withLock(async () => {
            const location=this.path(id);
            const stat=await lstat(location);
            if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > MAX_JOB_BYTES)
                throw new Error('Unsafe Node offline queue file; manual inspection required.');
            await unlink(location);
        });
    }

    flush(now = Date.now(), maxJobs = 4): Promise<DrainResult> {
        if (this.running) return this.running;
        this.running = this.drain(now, maxJobs).finally(()=>{this.running=undefined;});
        return this.running;
    }

    private async drain(now: number,maxJobs: number): Promise<DrainResult> {
        if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(maxJobs) || maxJobs<1 || maxJobs>4)
            throw new Error('Invalid Node queue drain limits.');
        return this.withLock(async () => {
            // Scan all eight bounded records first. Four blocked or backed-off
            // jobs must never starve a fifth ready item.
            const entries = await this.records();
            let delivered=0,deferred=0,blocked=0,unreadable=0,attempted=0;
            for (const entry of entries) {
                let record:Payload;
                try { record=await this.read(entry.id); }
                catch { unreadable++;continue; }
                if (record.status === 'blocked') {blocked++;continue;}
                if (record.nextAttemptAt>now) {deferred++;continue;}
                if (attempted >= maxJobs) continue;
                attempted++;
                // Only the sender is inside this catch. A failed local unlink
                // must NOT rewrite the queue and re-upload committed bytes.
                try {
                    await this.send({...this.identity,workspaceId:record.workspaceId,
                        uploadId:record.uploadId,fileName:record.fileName,mimeType:record.mimeType,
                        bytes:Buffer.from(record.base64,'base64')});
                } catch(error) {
                    const isPermanent=permanent(error);
                    const attempts=Math.min(record.attempts+1,MAX_ATTEMPTS);
                    const updated:Payload={...record,
                        status:isPermanent ? 'blocked':'queued',
                        attempts,nextAttemptAt:isPermanent ? 0:now+dueDelay(attempts)};
                    await this.atomicWrite(entry.id,this.seal(updated));
                    if(isPermanent) blocked++;else deferred++;
                    continue;
                }
                // This delete is serialized with the operator CLI; if it
                // fails, propagate the error and preserve the original UUID
                // for the next idempotent server-side retry.
                await unlink(this.path(entry.id));
                delivered++;
            }
            return {delivered,deferred,blocked,unreadable};
        });
    }
}
