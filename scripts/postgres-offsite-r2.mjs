#!/usr/bin/env node
// Operator-only ciphertext publication. No database connections, decryptions or deletes.
import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4096;
const CONFIRM = "PUBLISH_PG_OFFSITE";
const HEX_SHA = /^[a-f0-9]{64}$/;
const ACCOUNT_HOST = /^([a-f0-9]{32})\.(?:(?:eu|us|fedramp)\.)?r2\.cloudflarestorage\.com$/;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hmac = (key, message) => createHmac("sha256", key).update(message).digest();
const fail = message => { throw new BackupError(message); };

export class BackupError extends Error {}

export function parseArgs(argv) {
    let mode = "dry-run", chosen = false, archive, confirmed = false;
    for (const arg of argv) {
        if (["--dry-run", "--verify", "--apply"].includes(arg)) {
            if (chosen) fail("choose one mode only");
            chosen = true;
            mode = arg.slice(2);
        } else if (arg.startsWith("--archive=")) {
            if (archive !== undefined) fail("duplicate archive path");
            archive = arg.slice("--archive=".length);
        } else if (arg === "--confirm=" + CONFIRM) {
            if (confirmed) fail("duplicate confirmation");
            confirmed = true;
        } else fail("unsupported option");
    }
    if (!archive || !archive.startsWith("/") || !archive.endsWith(".dump.age") ||
        archive.includes("\n") || archive.includes("\r"))
        fail("provide an absolute .dump.age archive path");
    if ((mode === "apply") !== confirmed)
        fail("apply requires exactly --confirm=" + CONFIRM);
    return { mode, archive };
}

async function privateBytes(filename, upperBound) {
    let fd;
    try {
        fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await fd.stat();
        if (!before.isFile() || before.uid !== process.getuid() ||
            (before.mode & 0o077) !== 0 || before.size < 1 ||
            before.size > upperBound || !Number.isSafeInteger(before.size))
            fail("source file must be a private, operator-owned bounded regular file");
        const bytes = await fd.readFile();
        const after = await fd.stat();
        if (bytes.length !== before.size || after.size !== before.size ||
            before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
            fail("source file changed during read");
        return bytes;
    } catch (error) {
        if (error instanceof BackupError) throw error;
        fail("source file cannot be opened or read safely");
    } finally {
        await fd?.close();
    }
}

export async function readSnapshot(archive) {
    const metadata = await privateBytes(archive + ".json", MAX_MANIFEST_BYTES);
    let manifest;
    try { manifest = JSON.parse(metadata.toString("utf8")); }
    catch { fail("invalid snapshot manifest JSON"); }
    if (!manifest || typeof manifest !== "object" || manifest.schemaVersion !== 1 || manifest.kind !== "postgres-custom-age" ||
        typeof manifest.database !== "string" || !/^[A-Za-z0-9_]+$/.test(manifest.database) ||
        typeof manifest.createdAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.createdAt) ||
        !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 128 ||
        manifest.bytes > MAX_ARCHIVE_BYTES || !HEX_SHA.test(manifest.ciphertextSha256) ||
        manifest.verifiedRestore !== false)
        fail("snapshot manifest does not satisfy the encrypted backup schema");
    const ciphertext = await privateBytes(archive, MAX_ARCHIVE_BYTES);
    if (ciphertext.length !== manifest.bytes ||
        sha256(ciphertext) !== manifest.ciphertextSha256)
        fail("local ciphertext size or SHA-256 differs from manifest");
    const prefix = "postgres-backups/v1/" + manifest.ciphertextSha256;
    return { manifest, ciphertext, metadata,
        archiveKey: prefix + ".dump.age", manifestKey: prefix + ".dump.age.json" };
}

function endpointAccount(raw) {
    let url;
    try { url = new URL(raw); } catch { fail("invalid R2 endpoint"); }
    const match = ACCOUNT_HOST.exec(url.hostname);
    if (url.protocol !== "https:" || !match || url.username || url.password ||
        url.port || url.pathname !== "/" || url.search || url.hash)
        fail("R2 endpoint must be an account-scoped Cloudflare HTTPS S3 endpoint");
    return { url, accountId: match[1] };
}

export function recoveryConfig(env) {
    const primary = endpointAccount(env.ATLAS_R2_ENDPOINT || "");
    const recovery = endpointAccount(env.ATLAS_R2_RECOVERY_ENDPOINT || "");
    if (primary.accountId === recovery.accountId)
        fail("recovery R2 must use a separate Cloudflare account, not just a separate bucket");
    const bucket = env.ATLAS_R2_RECOVERY_BUCKET || "";
    const accessKeyId = env.ATLAS_R2_RECOVERY_ACCESS_KEY_ID || "";
    const secretAccessKey = env.ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY || "";
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
        !accessKeyId || !secretAccessKey)
        fail("a valid private recovery bucket and separate R2 access credentials are required");
    if (accessKeyId === env.ATLAS_R2_ACCESS_KEY_ID ||
        secretAccessKey === env.ATLAS_R2_SECRET_ACCESS_KEY)
        fail("recovery credentials must not reuse primary R2 credentials");
    return { endpoint: recovery.url, bucket, accessKeyId, secretAccessKey };
}

async function boundedResponse(response, cap) {
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > cap)) {
        await response.body?.cancel();
        fail("remote response exceeds its byte budget");
    }
    if (!response.body) fail("remote response has no body");
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > cap) fail("remote response exceeds its byte budget");
            chunks.push(Buffer.from(next.value));
        }
        if (length !== null && total !== Number(length))
            fail("remote Content-Length mismatch");
        return Buffer.concat(chunks, total);
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

export class R2BackupStore {
    constructor(config, send = fetch) {
        this.config = config;
        this.send = send;
    }
    async request(method, key, payload, ifAbsent = false) {
        const { endpoint, bucket, accessKeyId, secretAccessKey } = this.config;
        const target = new URL(endpoint.href);
        target.pathname = "/" + encodeURIComponent(bucket) + "/" +
            key.split("/").map(encodeURIComponent).join("/");
        const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
        const date = timestamp.slice(0, 8);
        const bodyHash = sha256(payload || "");
        const headersList = ifAbsent ?
            "host;if-none-match;x-amz-content-sha256;x-amz-date" :
            "host;x-amz-content-sha256;x-amz-date";
        const canonicalHeaders = "host:" + target.host + "\n" +
            (ifAbsent ? "if-none-match:*\n" : "") +
            "x-amz-content-sha256:" + bodyHash + "\nx-amz-date:" + timestamp + "\n";
        const canonical = [method, target.pathname, "", canonicalHeaders,
            headersList, bodyHash].join("\n");
        const scope = date + "/auto/s3/aws4_request";
        const toSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonical)].join("\n");
        const signingKey = hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, date), "auto"), "s3"), "aws4_request");
        const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
        const headers = {
            "x-amz-date": timestamp,
            "x-amz-content-sha256": bodyHash,
            authorization: "AWS4-HMAC-SHA256 Credential=" + accessKeyId + "/" +
                scope + ", SignedHeaders=" + headersList + ", Signature=" + signature,
        };
        if (ifAbsent) headers["if-none-match"] = "*";
        let response;
        try {
            response = await this.send(target, {method, headers,
                ...(payload ? {body: payload} : {}),
                signal: AbortSignal.timeout(120000), redirect: "error"});
        } catch {
            fail("R2 network or request failure; outcome may be indeterminate");
        }
        if (method === "PUT" && ifAbsent && response.status === 412) {
            await response.body?.cancel();
            return { created: false };
        }
        if (method === "GET" && response.status === 404) {
            const data = await boundedResponse(response, 8192);
            const xml = data.toString("utf8");
            if (/^\s*(?:<\?xml[^>]*>\s*)?<Error(?:\s[^>]*)?>\s*<Code>\s*NoSuchKey\s*<\/Code>[\s\S]*<\/Error>\s*$/.test(xml))
                return { missing: true };
            fail("R2 returned HTTP 404 without confirming NoSuchKey");
        }
        if (!response.ok) {
            await response.body?.cancel();
            fail("R2 request failed (HTTP " + response.status + ")");
        }
        if (method === "PUT") {
            await response.body?.cancel();
            return { created: true };
        }
        return { response };
    }
    async get(key, maxBytes) {
        const response = await this.request("GET", key);
        if (response.missing) return null;
        return boundedResponse(response.response, maxBytes);
    }
    async putIfAbsent(key, bytes) {
        return (await this.request("PUT", key, bytes, true)).created;
    }
}

function same(actual, expected) {
    return actual !== null && actual.length === expected.length &&
        sha256(actual) === sha256(expected);
}

export async function publishSnapshot(snapshot, store, mode) {
    if (mode !== "verify" && mode !== "apply") fail("remote operations require verify or apply mode");
    // Read both before making writes. An existing manifest is a commit marker:
    // never produce it until matching ciphertext exists and was re-read.
    let remoteArchive = await store.get(snapshot.archiveKey, snapshot.ciphertext.length);
    let remoteManifest = await store.get(snapshot.manifestKey, MAX_MANIFEST_BYTES);
    if (remoteArchive !== null && !same(remoteArchive, snapshot.ciphertext))
        fail("existing offsite ciphertext differs; no overwrite permitted");
    if (remoteManifest !== null && !same(remoteManifest, snapshot.metadata))
        fail("existing offsite manifest differs; no overwrite permitted");
    if (remoteManifest !== null && remoteArchive === null)
        fail("offsite manifest exists but ciphertext is missing; manual investigation required");
    if (mode === "verify" && (remoteArchive === null || remoteManifest === null))
        fail("offsite snapshot is incomplete");
    let createdArchive = false, createdManifest = false;
    if (mode === "apply" && remoteArchive === null) {
        createdArchive = await store.putIfAbsent(snapshot.archiveKey, snapshot.ciphertext);
        remoteArchive = await store.get(snapshot.archiveKey, snapshot.ciphertext.length);
        if (!same(remoteArchive, snapshot.ciphertext))
            fail("offsite ciphertext PUT could not be verified");
    }
    if (mode === "apply" && remoteManifest === null) {
        createdManifest = await store.putIfAbsent(snapshot.manifestKey, snapshot.metadata);
        remoteManifest = await store.get(snapshot.manifestKey, MAX_MANIFEST_BYTES);
        if (!same(remoteManifest, snapshot.metadata))
            fail("offsite manifest PUT could not be verified");
    }
    return {
        mode, status: "verified", ciphertextSha256: snapshot.manifest.ciphertextSha256,
        bytes: snapshot.ciphertext.length, archiveKey: snapshot.archiveKey,
        manifestKey: snapshot.manifestKey, createdArchive, createdManifest,
        createdObjects: Number(createdArchive) + Number(createdManifest),
        restoreVerified: false, deleteOperations: 0,
    };
}

export async function run(argv, env = process.env, makeStore = config => new R2BackupStore(config)) {
    const options = parseArgs(argv);
    const snapshot = await readSnapshot(options.archive);
    if (options.mode === "dry-run")
        return {mode: "dry-run", status: "local-verified",
            ciphertextSha256: snapshot.manifest.ciphertextSha256,
            bytes: snapshot.ciphertext.length, archiveKey: snapshot.archiveKey,
            manifestKey: snapshot.manifestKey, remoteChecked: false, restoreVerified: false};
    const store = makeStore(recoveryConfig(env));
    return publishSnapshot(snapshot, store, options.mode);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    run(process.argv.slice(2)).then(report => {
        process.stdout.write(JSON.stringify(report) + "\n");
    }).catch(error => {
        const safe = error instanceof BackupError ? error.message : "unexpected error; no success claimed";
        process.stderr.write("PostgreSQL offsite publication aborted: " + safe + "\n");
        process.exitCode = 1;
    });
}
