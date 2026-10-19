import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** The media service generates storage keys; clients never choose them. */
const validObjectKey = /^[a-f0-9]{64}(?:-(?:thumbnail|preview))?\.(?:jpg|png|webp|gif|avif|pdf)$/;
const safeKey = (key: string) => {
    if (!validObjectKey.test(key)) throw new Error("Invalid Atlas media object key.");
    return key;
};

export interface MediaObjectStore {
    put(key: string, bytes: Buffer, mimeType: string): Promise<void>;
    get(key: string): Promise<Buffer>;
}

export class MediaObjectNotFound extends Error {
    constructor() { super("Media object was not found."); this.name = "MediaObjectNotFound"; }
}

export class LocalMediaObjectStore implements MediaObjectStore {
    constructor(readonly root: string) {}
    async put(key: string, bytes: Buffer, _mimeType?: string) {
        await mkdir(this.root, { recursive: true });
        await writeFile(path.join(this.root, safeKey(key)), bytes, { flag: "wx" }).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
    }
    async get(key: string) {
        try { return await readFile(path.join(this.root, safeKey(key))); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MediaObjectNotFound();
            throw error;
        }
    }
}

export type R2MediaConfig = {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
};

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const mac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();

/** Minimal SigV4 client for R2's S3-compatible API, without AWS SDK credentials discovery. */
export class R2MediaObjectStore implements MediaObjectStore {
    private readonly endpoint: URL;
    private readonly request: typeof fetch;
    constructor(readonly config: R2MediaConfig, request: typeof fetch = fetch) {
        this.request = request;
        this.endpoint = new URL(config.endpoint);
        if (this.endpoint.protocol !== "https:" ||
            !/^[a-f0-9]+\.(?:(?:eu|us|fedramp)\.)?r2\.cloudflarestorage\.com$/.test(this.endpoint.hostname) ||
            this.endpoint.port || this.endpoint.username || this.endpoint.password ||
            this.endpoint.pathname !== "/" || this.endpoint.search || this.endpoint.hash)
            throw new Error("ATLAS_R2_ENDPOINT must be your Cloudflare R2 HTTPS S3 endpoint.");
        if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket))
            throw new Error("Invalid ATLAS_R2_BUCKET.");
        if (!config.accessKeyId || !config.secretAccessKey) throw new Error("R2 credentials are required.");
    }

    private async perform(method: "PUT" | "GET", key: string, bytes?: Buffer, mimeType?: string): Promise<Response> {
        const requestUrl = new URL(`${encodeURIComponent(this.config.bucket)}/${encodeURIComponent(safeKey(key))}`, this.endpoint);
        const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
        const date = timestamp.slice(0, 8);
        const payloadHash = digest(bytes ?? "");
        const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
        const headers = `host:${requestUrl.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}\n`;
        const canonical = `${method}\n${requestUrl.pathname}\n\n${headers}\n${signedHeaders}\n${payloadHash}`;
        const scope = `${date}/auto/s3/aws4_request`;
        const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${digest(canonical)}`;
        const signingKey = mac(mac(mac(mac(`AWS4${this.config.secretAccessKey}`, date), "auto"), "s3"), "aws4_request");
        const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
        const requestHeaders: Record<string, string> = {
            "x-amz-date": timestamp,
            "x-amz-content-sha256": payloadHash,
            authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        };
        if (mimeType) requestHeaders["content-type"] = mimeType;
        const response = await this.request(requestUrl, {
            method, headers: requestHeaders, ...(bytes ? { body: new Uint8Array(bytes) } : {}),
            signal: AbortSignal.timeout(30_000), redirect: "error",
        });
        if (response.status === 404 && method === "GET") throw new MediaObjectNotFound();
        if (!response.ok) throw new Error(`R2 media ${method} failed (HTTP ${response.status}).`);
        return response;
    }
    async put(key: string, bytes: Buffer, mimeType: string) { await this.perform("PUT", key, bytes, mimeType); }
    async get(key: string) { return Buffer.from(await (await this.perform("GET", key)).arrayBuffer()); }
}

/** Legacy local objects remain readable after switching new uploads to R2. */
export class R2WithLocalFallback implements MediaObjectStore {
    constructor(readonly remote: MediaObjectStore, readonly local: MediaObjectStore) {}
    async put(key: string, bytes: Buffer, mimeType: string) { await this.remote.put(key, bytes, mimeType); }
    async get(key: string) {
        try { return await this.remote.get(key); }
        catch (error) {
            if (error instanceof MediaObjectNotFound) return this.local.get(key);
            throw error;
        }
    }
}

export function createMediaObjectStore(root: string, r2?: R2MediaConfig | null): MediaObjectStore {
    const local = new LocalMediaObjectStore(root);
    return r2 ? new R2WithLocalFallback(new R2MediaObjectStore(r2), local) : local;
}
