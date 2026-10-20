import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AtlasError } from '@atlas/protocol/errors';

export type AtlasLogSource = 'stdout' | 'stderr';
const LOG_FILES: Record<AtlasLogSource, string> = { stdout: 'node.log', stderr: 'node-error.log' };
const MAX_SCAN_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 48 * 1024;

export function redactNodeLog(text: string): string {
    return text
        // Never expose credentials, authorization headers, connection strings or tokens.
        .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [REDACTED]')
        .replace(/\b([A-Za-z][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
        .replace(/\b((?:postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqps?|https?):\/\/)[^\s"'<>@]+@/gi, '$1[REDACTED]@')
        .replace(/\b(eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '[REDACTED_JWT]')
        .replace(/([?&](?:token|secret|key|password|credential|code)=)[^&#\s]+/gi, '$1[REDACTED]');
}

export async function readAtlasNodeLog(
    source: AtlasLogSource, lines: number, platform: NodeJS.Platform = process.platform, home = homedir(),
) {
    if (platform !== 'darwin') throw new AtlasError('Atlas Node file logs are not configured for this platform.', 'CAPABILITY_UNAVAILABLE');
    if (!Object.hasOwn(LOG_FILES, source) || !Number.isInteger(lines) || lines < 1 || lines > 200)
        throw new AtlasError('Invalid Atlas Node log request.', 'INVALID_REQUEST');
    const file = join(home, 'Library', 'Logs', 'Atlas', LOG_FILES[source]);
    // Only two fixed locations. Do not resolve caller-supplied paths, follow symlinks,
    // execute commands, or read earlier history than the bounded end-of-file slice.
    let handle;
    try {
        const directory = await lstat(join(home, 'Library', 'Logs', 'Atlas'));
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Untrusted Atlas log directory');
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { source, lines: [], truncated: false, available: false };
        throw new AtlasError('Atlas Node log is not accessible.', 'LOG_UNAVAILABLE');
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new AtlasError('Atlas Node log is not a regular file.', 'LOG_UNAVAILABLE');
        const offset = Math.max(0, stat.size - MAX_SCAN_BYTES);
        const length = Math.min(stat.size, MAX_SCAN_BYTES);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        let tail = buffer.subarray(0, bytesRead).toString('utf8');
        if (offset) tail = tail.slice(tail.indexOf('\n') + 1);
        const entries = tail.split(/\r?\n/);
        if (!entries[entries.length - 1]) entries.pop();
        const selected = entries.slice(-lines);
        let output = redactNodeLog(selected.join('\n'));
        let outputTruncated = false;
        if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
            output = Buffer.from(output).subarray(-MAX_OUTPUT_BYTES).toString('utf8');
            output = output.slice(output.indexOf('\n') + 1);
            outputTruncated = true;
        }
        return {
            source,
            lines: output ? output.split('\n') : [],
            available: true,
            truncated: offset > 0 || entries.length > lines || outputTruncated,
        };
    } finally { await handle.close(); }
}
