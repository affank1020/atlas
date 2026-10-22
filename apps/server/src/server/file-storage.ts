import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, open, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

/** Object keys are generated server-side; callers never choose arbitrary filesystem paths. */
const validObjectKey = /^(?:[a-f0-9]{64}(?:-(?:thumbnail|preview))?\.(?:jpg|png|webp|gif|avif|pdf)|files-[a-f0-9]{32}-[a-f0-9]{64})$/;
const safeKey = (key: string) => {
    if (!validObjectKey.test(key)) throw new Error("Invalid Atlas media object key.");
    return key;
};

export type ListedFileObject = { key: string; size: number; modifiedAt: Date };

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

    /** Read legacy local Atlas Files for manual backup seeding with a hard
     * byte cap. Do not follow leaf symlinks or read files with unknown size. */
    async getBounded(key: string, maxBytes: number): Promise<Buffer> {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 25 * 1024 * 1024)
            throw new Error("Invalid bounded local Files size.");
        const filename = path.join(this.root, safeKey(key));
        let handle;
        try {
            handle = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            // An unmounted/misconfigured media root must not be interpreted
            // as ordinary key absence, giving a misleading complete dry run.
            const rootStat = await stat(this.root);
            if (!rootStat.isDirectory()) throw new Error("Atlas Files local storage root is not a directory.");
            throw new ObjectNotFound();
        }
        try {
            const info = await handle.stat();
            if (!info.isFile() || !Number.isSafeInteger(info.size) ||
                info.size < 1 || info.size > maxBytes)
                throw new Error("Local Files object is not a bounded regular file.");
            const bytes = Buffer.alloc(info.size);
            let offset = 0;
            while (offset < bytes.length) {
                const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
                if (bytesRead === 0) throw new Error("Local Files object was truncated while reading.");
                offset += bytesRead;
            }
            const final = await handle.stat();
            if (!final.isFile() || final.size !== info.size ||
                final.mtimeMs !== info.mtimeMs || final.ctimeMs !== info.ctimeMs)
                throw new Error("Local Files object changed while reading.");
            return bytes;
        } finally {
            await handle.close();
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

    private async perform(method: "PUT" | "GET" | "DELETE", key: string | null, bytes?: Buffer, mimeType?: string, query?: URLSearchParams, createOnly = false): Promise<Response> {
        const target = encodeURIComponent(this.config.bucket) + (key === null ? "" : "/" + encodeURIComponent(safeKey(key)));
        const requestUrl = new URL(target, this.endpoint);
        // SigV4 requires the actual query bytes to match this canonical encoding.
        const escaped = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g,
            char => "%" + char.charCodeAt(0).toString(16).toUpperCase());
        const canonicalQuery = query ? [...query.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([name, value]) => escaped(name) + "=" + escaped(value)).join("&") : "";
        if (canonicalQuery) requestUrl.search = canonicalQuery;
        const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
        const date = timestamp.slice(0, 8);
        const payloadHash = digest(bytes ?? "");
        const signedHeaders = createOnly ? "host;if-none-match;x-amz-content-sha256;x-amz-date" : "host;x-amz-content-sha256;x-amz-date";
        const headers = `host:${requestUrl.host}\n${createOnly ? "if-none-match:*\n" : ""}x-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}\n`;
        const canonical = `${method}\n${requestUrl.pathname}\n${canonicalQuery}\n${headers}\n${signedHeaders}\n${payloadHash}`;
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
        if (createOnly) requestHeaders["if-none-match"] = "*";
        const response = await this.request(requestUrl, {
            method, headers: requestHeaders, ...(bytes ? { body: new Uint8Array(bytes) } : {}),
            signal: AbortSignal.timeout(30_000), redirect: "error",
        });
        if (response.status === 404 && method === "GET" && key !== null) {
            // R2 returns S3 XML errors. NoSuchBucket and NoSuchKey both use
            // HTTP 404; *only* the latter proves a missing object. Bounded
            // parsing prevents oversized/proxy/malformed bodies from becoming
            // an unbounded allocation or a false-negative key lookup.
            const maxErrorBytes = 8192;
            const length = response.headers.get("content-length");
            if (length !== null && (!/^\\d+$/.test(length) || Number(length) > maxErrorBytes)) {
                await response.body?.cancel();
                throw new Error("R2 GET 404 response cannot be classified.");
            }
            if (!response.body) throw new Error("R2 GET 404 response has no error body.");
            const reader = response.body.getReader();
            const chunks: Buffer[] = [];
            let total = 0;
            try {
                for (;;) {
                    const part = await reader.read();
                    if (part.done) break;
                    total += part.value.byteLength;
                    if (total > maxErrorBytes)
                        throw new Error("R2 GET 404 error response exceeds size limit.");
                    chunks.push(Buffer.from(part.value));
                }
            } catch (error) {
                await reader.cancel().catch(() => undefined);
                throw error;
            } finally {
                reader.releaseLock();
            }
            if (length !== null && total !== Number(length))
                throw new Error("R2 GET 404 response length mismatch.");
            const xml = Buffer.concat(chunks, total).toString("utf8");
            if (/^\\s*(?:<\\?xml[^>]*>\\s*)?<Error(?:\\s[^>]*)?>\\s*<Code>\\s*NoSuchKey\\s*<\\/Code>[\\s\\S]*<\\/Error>\\s*$/.test(xml))
                throw new ObjectNotFound();
            throw new Error("R2 GET failed (HTTP 404; not a confirmed missing key).");
        }
        if (createOnly && method === "PUT" && response.status === 412) {
            await response.body?.cancel();
            return response;
        }
        if (!response.ok) throw new Error(`R2 object ${method} failed (HTTP ${response.status}).`);
        return response;
    }
    async put(key: string, bytes: Buffer, mimeType: string) { await this.perform("PUT", key, bytes, mimeType); }
    /** Atomically create an absent object. A 412 means another committed object
     * exists; callers MUST GET and checksum that object before accepting it. */
    async putIfAbsent(key: string, bytes: Buffer, mimeType: string): Promise<boolean> {
        if (bytes.length < 1 || bytes.length > 25 * 1024 * 1024)
            throw new Error("Invalid bounded R2 seed size.");
        const response = await this.perform("PUT", key, bytes, mimeType, undefined, true);
        return response.status !== 412;
    }
    async get(key: string) { return Buffer.from(await (await this.perform("GET", key)).arrayBuffer()); }
    async delete(key: string) { await this.perform("DELETE", key); }

    /** Read an Atlas Files object with a hard response budget. Never buffer an
     * untrusted/malformed Content-Length into an unbounded arrayBuffer().
     * This is also used for independent R2 backup recovery verification.
     */
    async getBounded(key: string, maxBytes: number): Promise<Buffer> {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 25 * 1024 * 1024)
            throw new Error("Invalid bounded R2 recovery size.");
        const response = await this.perform("GET", key);
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
            await response.body?.cancel();
            throw new Error("R2 recovery object exceeds byte limit.");
        }
        if (!response.body) throw new Error("R2 recovery object has no response body.");
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        try {
            for (;;) {
                const result = await reader.read();
                if (result.done) break;
                total += result.value.byteLength;
                if (total > maxBytes) throw new Error("R2 recovery object exceeds byte limit.");
                chunks.push(Buffer.from(result.value));
            }
            if (length !== null && total !== Number(length))
                throw new Error("R2 recovery object length differs from Content-Length.");
            return Buffer.concat(chunks,total);
        } catch (error) {
            await reader.cancel().catch(() => undefined);
            throw error;
        } finally { reader.releaseLock(); }
    }

    /** Read-only, signed ListObjectsV2. Each response is capped at 1000 keys. */
    async listFilesPage(token?: string, pageSize = 1000): Promise<{ objects: ListedFileObject[]; nextToken?: string }> {
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000)
            throw new Error("Invalid R2 inventory page size.");
        if (token !== undefined && (!token || token.length > 4096)) throw new Error("Invalid R2 inventory token.");
        const query = new URLSearchParams({
            "encoding-type": "url", "list-type": "2", "max-keys": String(pageSize), prefix: "files-",
        });
        if (token !== undefined) query.set("continuation-token", token);
        const response = await this.perform("GET", null, undefined, undefined, query);
        if (Number(response.headers.get("content-length") ?? 0) > 1024 * 1024)
            throw new Error("R2 inventory response exceeds size limit.");
        if (!response.body) throw new Error("R2 inventory returned no response body.");
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let bytesRead = 0;
        for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytesRead += part.value.byteLength;
            if (bytesRead > 1024 * 1024) {
                await reader.cancel();
                throw new Error("R2 inventory response exceeds size limit.");
            }
            chunks.push(Buffer.from(part.value));
        }
        const xml = Buffer.concat(chunks, bytesRead).toString("utf8");
        if (!/<ListBucketResult(?:\s|>)/.test(xml) ||
            !/<\/ListBucketResult>/.test(xml))
            throw new Error("Unexpected R2 inventory response.");
        const contents = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
        if (contents.length > pageSize) throw new Error("R2 returned too many inventory keys.");
        if ((xml.match(/<Contents>/g) ?? []).length !== contents.length)
            throw new Error("Incomplete R2 inventory object records.");
        const reportedCount = /<KeyCount>(\d+)<\/KeyCount>/.exec(xml);
        if (reportedCount && Number(reportedCount[1]) !== contents.length)
            throw new Error("Inconsistent R2 inventory object count.");
        const tag = (body: string, name: string): string => {
            const match = new RegExp("<" + name + ">([\\s\\S]*?)<\\/" + name + ">").exec(body);
            if (!match) throw new Error("Incomplete R2 inventory XML.");
            const raw = match[1]!;
            if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(raw))
                throw new Error("Unexpected R2 XML entity.");
            const decoded = raw.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
                const value = entity.slice(1, -1);
                if (value === "amp") return "&";
                if (value === "lt") return "<";
                if (value === "gt") return ">";
                if (value === "quot") return '"';
                if (value === "apos") return "'";
                const code = value.toLowerCase().startsWith("#x") ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
                if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff)
                    throw new Error("Invalid XML numeric entity.");
                return String.fromCodePoint(code);
            });
            return decoded;
        };
        const objects = contents.flatMap((match): ListedFileObject[] => {
            const encodedKey = tag(match[1]!, "Key");
            let key: string;
            try { key = decodeURIComponent(encodedKey); }
            catch {
                // The bucket can contain unrelated keys with malformed percent
                // sequences. They aren't Atlas Files inventory candidates.
                return [];
            }
            // S3's prefix is deliberately broader than the server-generated
            // key format. Ignore out-of-scope files without stopping the scan;
            // raw Contents count and continuation tokens still bound paging.
            if (!/^files-[a-f0-9]{32}-[a-f0-9]{64}$/.test(key)) return [];
            const rawSize = tag(match[1]!, "Size");
            const modifiedAt = new Date(tag(match[1]!, "LastModified"));
            const size = Number(rawSize);
            if (!/^\d+$/.test(rawSize) || !Number.isSafeInteger(size) || !Number.isFinite(modifiedAt.getTime()))
                throw new Error("Invalid R2 inventory metadata.");
            return [{ key, size, modifiedAt }];
        });
        const truncation = tag(xml, "IsTruncated");
        if (truncation !== "true" && truncation !== "false") throw new Error("Invalid R2 truncation flag.");
        const truncated = truncation === "true";
        const nextToken = truncated ? tag(xml, "NextContinuationToken") : undefined;
        if (truncated && !nextToken) throw new Error("Missing R2 continuation token.");
        return { objects, ...(nextToken ? { nextToken } : {}) };
    }
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
