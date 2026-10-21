import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { AtlasError } from '../shared/errors.js';
import type { AtlasFilesService, AtlasFile } from './atlas-files.js';
import type { NodeIdentity } from '../nodes/identity.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Node transfer is deliberately limited until a reviewed, resumable multipart
// protocol and per-account quotas are in place.
export const NODE_FILE_LIMIT_BYTES = 25 * 1024 * 1024;
export const NODE_WORKSPACE_LIMIT_BYTES = 1024 * 1024 * 1024;

const checkedUuid = (value: string, label: string) => {
    if (typeof value !== 'string' || !UUID.test(value)) throw new AtlasError(`Invalid ${label}.`);
    return value.toLowerCase();
};

type NodeUpload = {
    nodeId: string; credential: string; workspaceId: string; uploadId: string;
    fileName: string; mimeType: string; bytes: Buffer;
};

/**
 * The caller authenticates the Node *before reading request bytes*. This
 * service authenticates again under a database lock, then checks the Node's
 * current workspace placement. Only private workspace-owned Files are allowed.
 *
 * An upload ID is stable across retries and scoped to one Node. A Postgres
 * advisory transaction lock serialises duplicate uploads across server
 * instances, and the Files row and receipt commit in one transaction.
 */
export class NodeFileIngestService {
    constructor(readonly pool: Pool, readonly identity: NodeIdentity, readonly files: AtlasFilesService) {}

    async authorize(nodeId: string, credential: string, workspaceId: string): Promise<void> {
        checkedUuid(nodeId, 'Node ID'); checkedUuid(workspaceId, 'Workspace ID');
        if (typeof credential !== 'string' || credential.length < 32)
            throw new AtlasError('Invalid Node identity or credential.', 'NODE_AUTH_INVALID');
        await this.identity.authenticate(nodeId, credential);
        const found = await this.pool.query(`SELECT w.id FROM workspaces w
            LEFT JOIN projects p ON p.id=w.project_id
            WHERE w.id=$1 AND w.node_id=$2 AND w.status='active' AND w.archived_at IS NULL
              AND (w.project_id IS NULL OR (p.id IS NOT NULL AND p.archived_at IS NULL))`,
            [workspaceId, nodeId]);
        if (!found.rowCount) throw new AtlasError('Workspace is not assigned to this Node.', 'NOT_FOUND');
    }

    async ingest(input: NodeUpload): Promise<{ file: AtlasFile; replayed: boolean }> {
        const nodeId = checkedUuid(input.nodeId, 'Node ID');
        const workspaceId = checkedUuid(input.workspaceId, 'Workspace ID');
        const uploadId = checkedUuid(input.uploadId, 'Upload ID');
        if (!Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > NODE_FILE_LIMIT_BYTES)
            throw new AtlasError('Node Files uploads must be between 1 byte and 25 MiB.');
        // Do not trust a previous HTTP preflight across a credential rotation.
        await this.authorize(nodeId, input.credential, workspaceId);
        const checksum = createHash('sha256').update(input.bytes).digest('hex');
        const credentialHash = createHash('sha256').update(input.credential).digest('hex');
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            // Lock the Node credential and Workspace placement while saving.
            // A revoke, rotate, archive or reassignment must wait for commit.
            const owner = await db.query(`SELECT w.id FROM workspaces w
                JOIN nodes n ON n.id=w.node_id
                LEFT JOIN projects p ON p.id=w.project_id
                WHERE w.id=$1 AND w.node_id=$2 AND w.status='active' AND w.archived_at IS NULL
                  AND (w.project_id IS NULL OR (p.id IS NOT NULL AND p.archived_at IS NULL))
                  AND n.credential_state='active' AND n.credential_hash=$3
                FOR SHARE OF w, n`, [workspaceId, nodeId, credentialHash]);
            if (!owner.rowCount) throw new AtlasError('Node or Workspace authorization changed.', 'NODE_AUTH_INVALID');
            // Serialize quota checks for all Node uploads to the same Workspace,
            // and prevent simultaneous replays under the same Node/upload UUID.
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['node-files:' + workspaceId]);
            const existing = await db.query(`SELECT r.workspace_id,r.checksum,a.id,a.file_name,a.mime_type,a.byte_size,a.status
                FROM node_file_upload_receipts r JOIN atlas_files a ON a.id=r.file_id
                WHERE r.node_id=$1 AND r.upload_id=$2`, [nodeId, uploadId]);
            if (existing.rows[0]) {
                const row = existing.rows[0];
                if (row.workspace_id !== workspaceId || row.checksum !== checksum ||
                    row.file_name !== input.fileName.trim() || row.mime_type !== input.mimeType ||
                    Number(row.byte_size) !== input.bytes.length || row.status !== 'active')
                    throw new AtlasError('Upload ID was already used with different data or was archived.', 'CONFLICT');
                const file = await this.files.metadata({ kind: 'workspace', id: workspaceId }, row.id);
                await db.query('COMMIT');
                return { file, replayed: true };
            }
            const total = await db.query(`SELECT COALESCE(SUM(byte_size),0)::text AS bytes FROM atlas_files
                WHERE owner_kind='workspace' AND owner_id=$1`, [workspaceId]);
            if (BigInt(total.rows[0].bytes) + BigInt(input.bytes.length) > BigInt(NODE_WORKSPACE_LIMIT_BYTES))
                throw new AtlasError('Node Files Workspace quota reached (1 GiB, including archived files).', 'QUOTA_EXCEEDED');
            const file = await this.files.upload({
                owner: { kind: 'workspace', id: workspaceId }, fileName: input.fileName,
                mimeType: input.mimeType, bytes: input.bytes, visibility: 'private',
                client: 'atlas-node:' + nodeId, database: db,
            });
            await db.query(`INSERT INTO node_file_upload_receipts(node_id,upload_id,workspace_id,file_id,checksum)
                VALUES($1,$2,$3,$4,$5)`, [nodeId, uploadId, workspaceId, file.id, checksum]);
            await db.query('COMMIT');
            return { file, replayed: false };
        } catch (error) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            db.release();
        }
    }
}
