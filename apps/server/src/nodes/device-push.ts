import { createCipheriv, createDecipheriv, randomBytes, sign } from 'node:crypto';
import type { Pool } from 'pg';
import { AtlasError } from '../shared/errors.js';
import type { NodeShareApprovals } from './share-approvals.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[\x21-\x7e]{32,4096}$/;

export type FcmCredentials = Readonly<{ projectId: string; clientEmail: string; privateKey: string }>;

export function parseFcmCredentials(json: string | undefined): FcmCredentials | undefined {
    if (!json) return undefined;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(json) as Record<string, unknown>; }
    catch { throw new Error('ATLAS_FCM_SERVICE_ACCOUNT_JSON must contain a service-account JSON object.'); }
    if (raw.type !== 'service_account' ||
        typeof raw.project_id !== 'string' || !/^[a-z0-9][a-z0-9-]{3,62}$/.test(raw.project_id) ||
        typeof raw.client_email !== 'string' || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(raw.client_email) ||
        typeof raw.private_key !== 'string' || !raw.private_key.includes('BEGIN PRIVATE KEY'))
        throw new Error('Invalid FCM service-account configuration.');
    return { projectId: raw.project_id, clientEmail: raw.client_email, privateKey: raw.private_key };
}

type RequestFn = typeof fetch;

/** Server-only encrypted FCM registration. Push is a hint, never a share receipt. */
export class DevicePushService {
    private accessToken: { value: string; validUntil: number } | null = null;
    private tokenFlight: Promise<string> | null = null;

    constructor(
        private readonly pool: Pool,
        private readonly encryptionKey: Buffer,
        private readonly credentials: FcmCredentials,
        private readonly approvals: Pick<NodeShareApprovals, 'allowedForInbox'>,
        private readonly request: RequestFn = fetch,
    ) {
        if (encryptionKey.length !== 32) throw new Error('Invalid push-token encryption key.');
    }

    async register(nodeId: string, token: string, sessionId: string): Promise<void> {
        if (!UUID.test(nodeId) || !TOKEN.test(token)) throw new AtlasError('Invalid push registration.', 'INVALID_REQUEST');
        const node = nodeId.toLowerCase();
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
        cipher.setAAD(Buffer.from('atlas-fcm-token-v1\0' + node));
        const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        // Credential generation is copied directly inside PostgreSQL so it
        // retains microsecond precision and cannot be resurrected by re-pairing.
        const result = await this.pool.query(`
            INSERT INTO device_push_tokens(node_id,credential_updated_at,token_ciphertext,token_nonce,token_tag)
            SELECT id,credential_updated_at,$2,$3,$4 FROM nodes
            WHERE id=$1 AND platform='android' AND credential_state='active'
              AND capabilities @> ARRAY['device.inbox.receive']::text[]
              AND credential_updated_at IS NOT NULL AND metadata->>'session'=$5
            ON CONFLICT(node_id) DO UPDATE SET
                credential_updated_at=EXCLUDED.credential_updated_at,
                token_ciphertext=EXCLUDED.token_ciphertext,token_nonce=EXCLUDED.token_nonce,
                token_tag=EXCLUDED.token_tag,registered_at=now()
            RETURNING node_id
        `, [node,encrypted,nonce,tag,sessionId]);
        if (!result.rowCount) throw new AtlasError('Push registration not permitted.', 'SHARE_DENIED');
    }

    async unregister(nodeId: string, sessionId: string): Promise<void> {
        if (!UUID.test(nodeId)) throw new AtlasError('Invalid push registration.', 'INVALID_REQUEST');
        await this.pool.query(`DELETE FROM device_push_tokens p WHERE p.node_id=$1
            AND EXISTS (SELECT 1 FROM nodes n WHERE n.id=p.node_id
                AND n.credential_state='active' AND n.metadata->>'session'=$2)`,
            [nodeId.toLowerCase(),sessionId]);
    }

    /** Called ONLY for a first-time committed queue admission; never a retry or live share. */
    async notifyQueued(sourceId: string, targetId: string, deliveryId: string): Promise<void> {
        if (![sourceId,targetId,deliveryId].every(s=>UUID.test(s))) return;
        // Recheck the item, both credential generations, and grant after commit.
        // This function never reads or sends the encrypted inbox contents.
        const result = await this.pool.query(`
            SELECT p.token_ciphertext,p.token_nonce,p.token_tag
            FROM device_push_tokens p
            JOIN nodes receiver ON receiver.id=p.node_id
            JOIN device_inbox i ON i.target_node_id=receiver.id
            JOIN nodes sender ON sender.id=i.source_node_id
            WHERE i.id=$1 AND i.source_node_id=$2 AND i.target_node_id=$3
              AND i.state='queued' AND i.expires_at>now()
              AND receiver.platform='android' AND receiver.credential_state='active'
              AND sender.credential_state='active'
              AND receiver.credential_updated_at=p.credential_updated_at
              AND receiver.credential_updated_at=i.target_credential_updated_at
              AND sender.credential_updated_at=i.source_credential_updated_at
        `,[deliveryId.toLowerCase(),sourceId.toLowerCase(),targetId.toLowerCase()]);
        if (!result.rowCount || !(await this.approvals.allowedForInbox(sourceId,targetId))) return;
        const row = result.rows[0];
        let token: string;
        try {
            const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, row.token_nonce);
            decipher.setAAD(Buffer.from('atlas-fcm-token-v1\0' + targetId.toLowerCase()));
            decipher.setAuthTag(row.token_tag);
            token = Buffer.concat([decipher.update(row.token_ciphertext),decipher.final()]).toString('utf8');
        } catch { return; } // The inbox still works when a stale key cannot decrypt a token.
        if (!TOKEN.test(token)) return;
        const accessToken = await this.getAccessToken();
        // Data-only high-priority push. Android displays its own user-visible,
        // lock-screen-private notification after verifying local opt-in.
        const response = await this.request(
            'https://fcm.googleapis.com/v1/projects/' + this.credentials.projectId + '/messages:send', {
                method:'POST',
                headers:{ Authorization:'Bearer ' + accessToken, 'Content-Type':'application/json' },
                body:JSON.stringify({message:{
                    token,
                    data:{kind:'atlas_inbox',deliveryId:deliveryId.toLowerCase()},
                    android:{priority:'HIGH',ttl:'3600s',collapse_key:'atlas_inbox'},
                }}),
                signal:AbortSignal.timeout(8_000),
            });
        if (!response.ok) {
            // Only an explicit FCM UNREGISTERED result invalidates a device token;
            // project errors, network failures and quota limits must not erase it.
            const body = await response.json().catch(()=>({})) as {
                error?: { details?: Array<{ errorCode?: string }> }
            };
            if (body.error?.details?.some(d=>d.errorCode==='UNREGISTERED')) {
                await this.pool.query(
                    'DELETE FROM device_push_tokens WHERE node_id=$1 AND token_tag=$2',
                    [targetId.toLowerCase(),row.token_tag],
                );
            }
        }
    }

    private async getAccessToken(): Promise<string> {
        if (this.accessToken && this.accessToken.validUntil > Date.now()) return this.accessToken.value;
        if (this.tokenFlight) return this.tokenFlight;
        const task = this.fetchToken();
        this.tokenFlight = task;
        try { return await task; } finally { if (this.tokenFlight===task) this.tokenFlight=null; }
    }

    private async fetchToken(): Promise<string> {
        const now = Math.floor(Date.now()/1000);
        const header = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
            iss:this.credentials.clientEmail,scope:'https://www.googleapis.com/auth/firebase.messaging',
            aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600,
        })).toString('base64url');
        const signingInput=header+'.'+payload;
        const signature=sign('RSA-SHA256',Buffer.from(signingInput),this.credentials.privateKey).toString('base64url');
        const form=new URLSearchParams({
            grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion:signingInput+'.'+signature,
        });
        const response=await this.request('https://oauth2.googleapis.com/token',{
            method:'POST',body:form,signal:AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error('FCM authentication unavailable.');
        const data=await response.json() as {access_token?:unknown;expires_in?:unknown};
        if (typeof data.access_token!=='string' || data.access_token.length<16 ||
            typeof data.expires_in!=='number' || data.expires_in<120)
            throw new Error('Invalid FCM authentication response.');
        this.accessToken={value:data.access_token,validUntil:Date.now()+(data.expires_in-60)*1000};
        return data.access_token;
    }
}
