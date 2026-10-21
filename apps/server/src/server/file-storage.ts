import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

/** Object keys are generated server-side; callers never choose arbitrary filesystem paths. */
const validObjectKey = /^(?:[a-f0-9]{64}(?:-(?:thumbnail|preview))?\.(?:jpg|png|webp|gif|avif|pdf)|files-[a-f0-9]{32}-[a-f0-9]{64})$/;
const safeKey = (key: string) => {
    if (!validObjectKey.test(key)) throw new Error("Invalid Atlas media object key.");
    return key;
};

export interface ObjectStore {
    put(key: string, bytes: Buffer, mimeType: string): Promise<void>;
    get(key: string): Promise<Buffer>;
    /** Idempotent removal used only for a uniquely generated, uncommitted object. */
    delete(key: string): Promise<void>;
}

export class ObjectNotFound extends Error {
    constructor() { super("Media object was not found."); this.name = "ObjectNotFound"; }
}

export class LocalObjectStore implements ObjectStore {
    constructor(readonly root: string) {}
    async put(key: string, bytes: Buffer, _mimeType?: string) {
        await mkdir(this.root, { recursive: true });
        await writeFile(path.join(this.root, safeKey(key)), bytes, { flag: "wx" }).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
    }
    async delete(key: string) {
        await unlink(path.join(this.root, safeKey(key))).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
    }
    async get(key: string) {
        try { return await readFile(path.join(this.root, safeKey(key))); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ObjectNotFound();
            throw error;
        }
    }
}

export type R2StorageConfig = {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
};

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const mac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();

/** Minimal SigV4 client for R2's S3-compatible API, without AWS SDK credentials discovery. */
export class R2ObjectStore implements ObjectStore {
    private readonly endpoint: URL;
    private readonly request: typeof fetch;
    constructor(readonly config: R2StorageConfig, request: typeof fetch = fetch) {
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

    private async perform(method: "PUT" | "GET" | "DELETE", key: string, bytes?: Buffer, mimeType?: string): Promise<Response> {
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
        if (response.status === 404 && method === "GET") throw new ObjectNotFound();
        if (!response.ok) throw new Error(`R2 object ${method} failed (HTTP ${response.status}).`);
        return response;
    }
    async put(key: string, bytes: Buffer, mimeType: string) { await this.perform("PUT", key, bytes, mimeType); }
    async get(key: string) { return Buffer.from(await (await this.perform("GET", key)).arrayBuffer()); }
    async delete(key: string) { await this.perform("DELETE", key); }
}

/** Legacy local objects remain readable after switching new uploads to R2. */
export class R2WithLocalFallback implements ObjectStore {
    constructor(readonly remote: ObjectStore, readonly local: ObjectStore) {}
    async put(key: string, bytes: Buffer, mimeType: string) { await this.remote.put(key, bytes, mimeType); }
    async delete(key: string) {
        // Clean both stores; R2 may be active alongside legacy local objects.
        await this.remote.delete(key);
        await this.local.delete(key);
    }
    async get(key: string) {
        try { return await this.remote.get(key); }
        catch (error) {
            if (error instanceof ObjectNotFound) return this.local.get(key);
            throw error;
        }
    }
}

export function createObjectStore(root: string, r2?: R2StorageConfig | null): ObjectStore {
    const local = new LocalObjectStore(root);
    return r2 ? new R2WithLocalFallback(new R2ObjectStore(r2), local) : local;
}
