import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { AtlasError } from '@atlas/protocol/errors';
import { redactNodeLog } from './node-logs.js';

const LOG_DIRECTORY = '/var/log/atlas-node';
const LOG_NAME = 'service.log';
const MAX_SCAN_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 48 * 1024;

type ServiceLogResult = { source: 'service'; lines: string[]; available: boolean; truncated: boolean };
const unavailable = (): ServiceLogResult => ({ source: 'service', lines: [], available: false, truncated: false });

/**
 * Only the fixed Atlas Node service output file, never a caller-supplied path.
 * The production directory must be root-owned and not writable by the Node,
 * while the regular file is owned by the unprivileged service account.
 * Optional directory/owner arguments are for disposable unit-test fixtures.
 */
export async function readAtlasLinuxServiceLog(
    lines: number, directory = LOG_DIRECTORY, trustedDirectoryUid = 0,
): Promise<ServiceLogResult> {
    if (!Number.isInteger(lines) || lines < 1 || lines > 200)
        throw new AtlasError('Invalid Atlas Node log request.', 'INVALID_REQUEST');

    let handle;
    try {
        const owner = process.getuid?.();
        const parent = await lstat(directory);
        if (owner === undefined || !parent.isDirectory() || parent.isSymbolicLink() ||
            parent.uid !== trustedDirectoryUid || (parent.mode & 0o022) !== 0)
            return unavailable();

        // O_NONBLOCK prevents a malicious FIFO replacing the log from hanging
        // open before the post-open regular-file check. No symlink traversal.
        handle = await open(join(directory, LOG_NAME),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.uid !== owner || stat.nlink !== 1 ||
            (stat.mode & 0o077) !== 0) return unavailable();

        const offset = Math.max(0, stat.size - MAX_SCAN_BYTES);
        const size = Math.min(stat.size, MAX_SCAN_BYTES);
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, offset);
        let tail = buffer.subarray(0, bytesRead).toString('utf8');

        // Avoid exposing partial records cut by a ring/window boundary or
        // incomplete concurrent appends. Only complete newline-terminated lines.
        if (offset > 0) {
            const boundary = tail.indexOf('\n');
            tail = boundary < 0 ? '' : tail.slice(boundary + 1);
        }
        const entries = tail.split(/\r?\n/);
        if (entries.length) entries.pop(); // incomplete final line, or final empty entry
        const selection = entries.slice(-lines);
        const redacted = redactNodeLog(selection.join('\n'));
        const kept: string[] = [];
        let bytes = 0;
        let outputTruncated = false;
        for (const line of redacted.split('\n').reverse()) {
            if (!line && kept.length === 0 && !redacted) break;
            const cost = Buffer.byteLength(line, 'utf8') + (kept.length ? 1 : 0);
            if (cost > MAX_OUTPUT_BYTES || bytes + cost > MAX_OUTPUT_BYTES) {
                outputTruncated = true;
                if (cost > MAX_OUTPUT_BYTES) continue;
                break;
            }
            kept.push(line);
            bytes += cost;
        }
        return {
            source: 'service', available: true, lines: kept.reverse(),
            truncated: offset > 0 || entries.length > lines || outputTruncated,
        };
    } catch {
        // No arbitrary paths, system diagnostics, stderr or elevated retries.
        return unavailable();
    } finally {
        await handle?.close().catch(() => undefined);
    }
}
