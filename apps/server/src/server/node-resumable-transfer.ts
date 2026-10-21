import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AtlasError } from '../shared/errors.js';
import { NodeFileIngestService, NODE_FILE_LIMIT_BYTES } from './node-file-ingest.js';

export const NODE_PART_BYTES = 1024 * 1024;
export const NODE_STAGING_WORKSPACE_BYTES = 64 * 1024 * 1024;
const MAX_PARTS = Math.ceil(NODE_FILE_LIMIT_BYTES / NODE_PART_BYTES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

export type NodeTransferIdentity = {
    nodeId: string; credential: string; workspaceId: string; uploadId: string;
};
type Init = NodeTransferIdentity & {
    fileName: string; mimeType: string; byteSize: number; checksum: string;
};
type TransferRow = {
    workspace_id: string; file_name: string; mime_type: string;
    byte_size: number; checksum: string; status: 'active' | 'finalizing' | 'complete';
    updated_at: Date;
    completed_file_id: string | null;
};
type Part = { part_index: number; bytes: Buffer; checksum: string; byte_size: number };
const conflicting = () => new AtlasError('Upload ID is bound to different transfer metadata.', 'CONFLICT');
function checkIdentity(input: NodeTransferIdentity) {
    if (!UUID.test(input.nodeId) || !UUID.test(input.workspaceId) || !UUID.test(input.uploadId))
        throw new AtlasError('Invalid Node transfer identity.');
}
function checkMetadata(input: Init) {
    if (!input.fileName?.trim() || input.fileName !== input.fileName.trim() ||
        input.fileName.length > 255 || /[\/\\\u0000-\u001f]/.test(input.fileName))
        throw new AtlasError('Invalid Node transfer filename.');
    if (!MIME.test(input.mimeType ?? '') || input.mimeType.length > 120)
        throw new AtlasError('Invalid Node transfer MIME type.');
    if (!Number.isInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > NODE_FILE_LIMIT_BYTES)
        throw new AtlasError('Node transfer size must be between 1 and 25 MiB.');
    if (!SHA.test(input.checksum)) throw new AtlasError('Invalid Node transfer checksum.');
}
const numberOfParts = (bytes: number) => Math.ceil(bytes / NODE_PART_BYTES);

/**
 * Server-side resumable uploads: immutable 1-MiB checkpoints, persisted in
 * bounded PostgreSQL staging (64 MiB active reservation per workspace).
 * No temp filesystem or R2 staging objects can become invisible to quota.
 * Every operation authenticates the existing Node/Workspace; the final file
 * uses the existing transactional NodeFileIngestService and its durable receipt.
 */
export class NodeResumableTransferService {
    constructor(readonly pool: Pool, readonly ingest: NodeFileIngestService) {}

    private async authorized(input: NodeTransferIdentity) {
        checkIdentity(input);
        await this.ingest.authorize(input.nodeId, input.credential, input.workspaceId);
    }

    private async lockAuthorization(db: PoolClient, input: NodeTransferIdentity): Promise<void> {
        const credentialHash = createHash('sha256').update(input.credential).digest('hex');
        const owner = await db.query(`SELECT w.id FROM workspaces w JOIN nodes n ON n.id=w.node_id
            LEFT JOIN projects p ON p.id=w.project_id
            WHERE w.id=$1 AND w.node_id=$2 AND w.status='active' AND w.archived_at IS NULL
              AND (w.project_id IS NULL OR (p.id IS NOT NULL AND p.archived_at IS NULL))
              AND n.credential_state='active' AND n.credential_hash=$3
            FOR SHARE OF w, n`, [input.workspaceId,input.nodeId,credentialHash]);
        if (!owner.rowCount) throw new AtlasError('Node or Workspace authorization changed.', 'NODE_AUTH_INVALID');
    }

    private async load(db: PoolClient, input: NodeTransferIdentity, lock = false): Promise<TransferRow> {
        const result = await db.query<TransferRow>(
            `SELECT workspace_id,file_name,mime_type,byte_size,checksum,status,completed_file_id,updated_at
             FROM node_file_transfer_sessions WHERE node_id=$1 AND upload_id=$2${lock ? ' FOR UPDATE' : ''}`,
            [input.nodeId, input.uploadId]);
        const session = result.rows[0];
        if (!session) throw new AtlasError('Node transfer session was not found.', 'NOT_FOUND');
        if (session.workspace_id !== input.workspaceId) throw conflicting();
        return session;
    }

    async init(input: Init): Promise<{ completed: boolean; received: number[]; chunkBytes: number; fileId?: string }> {
        await this.authorized(input);
        checkMetadata(input);
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            await this.lockAuthorization(db,input);
            // Reserve bounded staging capacity atomically across concurrent
            // Node sessions in the same Workspace and multiple server replicas.
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                ['node-files-staging:' + input.workspaceId]);
            let existing = await db.query<TransferRow>(
                `SELECT workspace_id,file_name,mime_type,byte_size,checksum,status,completed_file_id,updated_at
                 FROM node_file_transfer_sessions WHERE node_id=$1 AND upload_id=$2 FOR UPDATE`,
                [input.nodeId,input.uploadId]);
            let session = existing.rows[0];
            if (session) {
                if (session.workspace_id !== input.workspaceId || session.file_name !== input.fileName ||
                    session.mime_type !== input.mimeType || session.byte_size !== input.byteSize ||
                    session.checksum !== input.checksum) throw conflicting();
                // A legitimate resume is activity: refresh retention while we
                // hold the session row lock. A maintenance delete racing this
                // init either waits/skips or wins before any resume succeeds.
                // Do not refresh a finalizing/completed claim.
                if (session.status === 'active')
                    await db.query(`UPDATE node_file_transfer_sessions SET updated_at=clock_timestamp()
                        WHERE node_id=$1 AND upload_id=$2 AND status='active'`,
                        [input.nodeId,input.uploadId]);
            } else {
                // A transfer purged after inactivity still owns its Node-scoped
                // upload UUID. Reusing it (even with identical bytes) needs a
                // fresh UUID, so delayed offline retries cannot change identity.
                // The earlier FOR UPDATE session lookup serializes with the
                // maintenance DELETE; this tombstone read follows that lock.
                const expired = await db.query(
                    'SELECT 1 FROM node_file_expired_upload_ids WHERE node_id=$1 AND upload_id=$2',
                    [input.nodeId,input.uploadId]);
                if (expired.rowCount)
                    throw new AtlasError('Node transfer expired. Start again with a new upload ID.', 'CONFLICT');
                // The existing one-shot Node route shares the receipt namespace.
                const receipt = await db.query('SELECT 1 FROM node_file_upload_receipts WHERE node_id=$1 AND upload_id=$2',
                    [input.nodeId,input.uploadId]);
                if (receipt.rowCount) throw conflicting();
                const pending = await db.query<{ bytes: string }>(`SELECT COALESCE(SUM(byte_size),0)::text AS bytes
                    FROM node_file_transfer_sessions WHERE workspace_id=$1 AND status IN ('active','finalizing')`, [input.workspaceId]);
                if (BigInt(pending.rows[0]!.bytes) + BigInt(input.byteSize) > BigInt(NODE_STAGING_WORKSPACE_BYTES))
                    throw new AtlasError('Node transfer staging quota reached (64 MiB).', 'QUOTA_EXCEEDED');
                await db.query(`INSERT INTO node_file_transfer_sessions
                    (node_id,upload_id,workspace_id,file_name,mime_type,byte_size,checksum)
                    VALUES($1,$2,$3,$4,$5,$6,$7)`,
                    [input.nodeId,input.uploadId,input.workspaceId,input.fileName,input.mimeType,input.byteSize,input.checksum]);
                existing = await db.query<TransferRow>(
                    `SELECT workspace_id,file_name,mime_type,byte_size,checksum,status,completed_file_id,updated_at
                     FROM node_file_transfer_sessions WHERE node_id=$1 AND upload_id=$2`,
                    [input.nodeId,input.uploadId]);
                session = existing.rows[0]!;
            }
            const partRows = await db.query<{ part_index: number }>(
                'SELECT part_index FROM node_file_transfer_parts WHERE node_id=$1 AND upload_id=$2 ORDER BY part_index',
                [input.nodeId,input.uploadId]);
            await db.query('COMMIT');
            return { completed: session.status === 'complete', received: partRows.rows.map(x=>x.part_index),
                chunkBytes: NODE_PART_BYTES, ...(session.completed_file_id ? { fileId: session.completed_file_id } : {}) };
        } catch (error) {
            await db.query('ROLLBACK').catch(() => undefined);
            if ((error as { code?: string }).code === '23505') throw conflicting();
            throw error;
        } finally { db.release(); }
    }

    async status(input: NodeTransferIdentity) {
        await this.authorized(input);
        const session = await this.pool.query<TransferRow>(
            `SELECT workspace_id,file_name,mime_type,byte_size,checksum,status,completed_file_id,updated_at
             FROM node_file_transfer_sessions WHERE node_id=$1 AND upload_id=$2`,
            [input.nodeId,input.uploadId]);
        if (!session.rows[0]) throw new AtlasError('Node transfer session was not found.', 'NOT_FOUND');
        if (session.rows[0].workspace_id !== input.workspaceId) throw conflicting();
        const parts = await this.pool.query<{ part_index: number }>(
            'SELECT part_index FROM node_file_transfer_parts WHERE node_id=$1 AND upload_id=$2 ORDER BY part_index',
            [input.nodeId,input.uploadId]);
        return { completed: session.rows[0].status === 'complete',
            received: parts.rows.map(x=>x.part_index), chunkBytes: NODE_PART_BYTES,
            ...(session.rows[0].completed_file_id ? { fileId: session.rows[0].completed_file_id } : {}) };
    }

    async chunk(input: NodeTransferIdentity & { index: number; checksum: string; bytes: Buffer }) {
        await this.authorized(input);
        if (!Number.isInteger(input.index) || input.index < 0 || input.index >= MAX_PARTS ||
            !SHA.test(input.checksum) || !Buffer.isBuffer(input.bytes))
            throw new AtlasError('Invalid Node transfer chunk.');
        if (createHash('sha256').update(input.bytes).digest('hex') !== input.checksum)
            throw new AtlasError('Node transfer chunk checksum mismatch.', 'CONFLICT');
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            await this.lockAuthorization(db,input);
            const session = await this.load(db,input,true);
            if (session.status !== 'active') throw new AtlasError('Node transfer is finalizing or complete.', 'CONFLICT');
            const expectedCount = numberOfParts(session.byte_size);
            if (input.index >= expectedCount) throw new AtlasError('Node transfer chunk index is out of range.');
            const expectedBytes = Math.min(NODE_PART_BYTES, session.byte_size - input.index * NODE_PART_BYTES);
            if (input.bytes.length !== expectedBytes)
                throw new AtlasError('Node transfer chunk has the wrong byte length.');
            const existing = await db.query<{ checksum: string; byte_size: number }>(
                'SELECT checksum,byte_size FROM node_file_transfer_parts WHERE node_id=$1 AND upload_id=$2 AND part_index=$3',
                [input.nodeId,input.uploadId,input.index]);
            if (existing.rows[0]) {
                if (existing.rows[0].checksum !== input.checksum ||
                    existing.rows[0].byte_size !== input.bytes.length) throw conflicting();
                await db.query('COMMIT');
                return { replayed: true, index: input.index };
            }
            await db.query(`INSERT INTO node_file_transfer_parts
                (node_id,upload_id,part_index,byte_size,checksum,bytes) VALUES($1,$2,$3,$4,$5,$6)`,
                [input.nodeId,input.uploadId,input.index,input.bytes.length,input.checksum,input.bytes]);
            await db.query('UPDATE node_file_transfer_sessions SET updated_at=now() WHERE node_id=$1 AND upload_id=$2',
                [input.nodeId,input.uploadId]);
            await db.query('COMMIT');
            return { replayed: false, index: input.index };
        } catch (error) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally { db.release(); }
    }

    async complete(input: NodeTransferIdentity) {
        await this.authorized(input);
        let bytes: Buffer | undefined;
        let fileName = '';
        let mimeType = '';
        let claimedAt: Date | undefined;
        // Phase 1: verify and claim completion under a row lock. This must
        // commit and RELEASE the pool client before calling ingest(), which
        // uses that same pool. Otherwise N completions can deadlock N clients.
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            await this.lockAuthorization(db,input);
            const session = await this.load(db,input,true);
            if (session.status === 'complete') {
                await db.query('COMMIT');
                return { fileId: session.completed_file_id!, replayed: true };
            }
            if (session.status === 'finalizing' &&
                Date.now() - new Date(session.updated_at).getTime() < 10 * 60_000)
                throw new AtlasError('Node transfer is already being finalized. Retry shortly.', 'CONFLICT');
            // A crash after the claim is recoverable after 10 minutes. The
            // underlying ingest receipt makes concurrent slow finalizers safe.
            const result = await db.query<Part>(
                `SELECT part_index,bytes,checksum,byte_size FROM node_file_transfer_parts
                 WHERE node_id=$1 AND upload_id=$2 ORDER BY part_index`,
                [input.nodeId,input.uploadId]);
            const required = numberOfParts(session.byte_size);
            if (result.rows.length !== required || result.rows.some((x,i)=>x.part_index !== i))
                throw new AtlasError('Node transfer is incomplete.', 'CONFLICT');
            bytes = Buffer.concat(result.rows.map(x=>x.bytes), session.byte_size);
            if (bytes.length !== session.byte_size ||
                createHash('sha256').update(bytes).digest('hex') !== session.checksum)
                throw new AtlasError('Node transfer integrity verification failed.', 'CONFLICT');
            fileName = session.file_name;
            mimeType = session.mime_type;
            const claimed = await db.query<{ updated_at: Date }>(`UPDATE node_file_transfer_sessions
                SET status='finalizing',updated_at=clock_timestamp()
                WHERE node_id=$1 AND upload_id=$2 RETURNING updated_at`,
                [input.nodeId,input.uploadId]);
            claimedAt = claimed.rows[0]!.updated_at;
            await db.query('COMMIT');
        } catch (error) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            db.release();
        }

        // Phase 2: independently authenticated, receipt-deduplicated final
        // upload. NO PostgreSQL client from Phase 1 remains checked out.
        let saved: Awaited<ReturnType<NodeFileIngestService['ingest']>>;
        try {
            saved = await this.ingest.ingest({ ...input, fileName, mimeType, bytes: bytes! });
        } catch (error) {
            // Release the claim for immediate retry, but only when it is
            // still OUR claim: an expired claimant must never reset a newer one.
            try {
                await this.pool.query(`UPDATE node_file_transfer_sessions SET status='active',updated_at=now()
                    WHERE node_id=$1 AND upload_id=$2 AND status='finalizing' AND updated_at=$3`,
                    [input.nodeId,input.uploadId,claimedAt]);
            } catch { /* Fail closed: a later claim expiry permits recovery. */ }
            throw error;
        }

        // Phase 3: finalize the checkpoint record in a fresh transaction.
        // An assignment/archive can invalidate the session after ingest has
        // committed; in that case the Files receipt still records success.
        const finalDb = await this.pool.connect();
        try {
            await finalDb.query('BEGIN');
            const session = await finalDb.query<TransferRow>(`SELECT status,completed_file_id
                FROM node_file_transfer_sessions WHERE node_id=$1 AND upload_id=$2 FOR UPDATE`,
                [input.nodeId,input.uploadId]);
            if (session.rows[0]) {
                if (session.rows[0].status !== 'complete') {
                    await finalDb.query(`UPDATE node_file_transfer_sessions
                        SET status='complete',completed_file_id=$3,updated_at=now()
                        WHERE node_id=$1 AND upload_id=$2`, [input.nodeId,input.uploadId,saved.file.id]);
                    await finalDb.query('DELETE FROM node_file_transfer_parts WHERE node_id=$1 AND upload_id=$2',
                        [input.nodeId,input.uploadId]);
                } else if (session.rows[0].completed_file_id !== saved.file.id) {
                    throw conflicting();
                }
            }
            await finalDb.query('COMMIT');
            return { fileId: saved.file.id, replayed: saved.replayed };
        } catch (error) {
            await finalDb.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally { finalDb.release(); }
    }

    async abort(input: NodeTransferIdentity) {
        await this.authorized(input);
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            await this.lockAuthorization(db,input);
            const session = await this.load(db,input,true);
            if (session.status !== 'active') throw new AtlasError('Completed transfers cannot be aborted.', 'CONFLICT');
            await db.query('DELETE FROM node_file_transfer_sessions WHERE node_id=$1 AND upload_id=$2',
                [input.nodeId,input.uploadId]);
            await db.query('COMMIT');
            return { aborted: true };
        } catch (error) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally { db.release(); }
    }
}
