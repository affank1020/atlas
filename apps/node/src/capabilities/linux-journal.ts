import { execFile } from 'node:child_process';
import { AtlasError } from '@atlas/protocol/errors';
import { redactNodeLog } from './node-logs.js';

const SCAN_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 48 * 1024;

/** The caller can select neither a journal unit nor executable flags. */
export type JournalRunner = (file: string, args: string[], options: {
    encoding: 'utf8'; maxBuffer: number; timeout: number; env: NodeJS.ProcessEnv;
}) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: JournalRunner = (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
});

/**
 * Read only the last N messages of Atlas' own systemd service. This is a
 * read-only, privilege-preserving adapter, not a general journal viewer.
 */
export async function readAtlasLinuxJournal(lines: number, runner: JournalRunner = defaultRunner) {
    if (!Number.isInteger(lines) || lines < 1 || lines > 200)
        throw new AtlasError('Invalid Atlas Node log request.', 'INVALID_REQUEST');
    try {
        const result = await runner('/usr/bin/journalctl',
            ['--no-pager', '--quiet', '--output=short-iso', '--unit=atlas-node.service', '--lines=' + lines],
            { encoding: 'utf8', maxBuffer: SCAN_LIMIT, timeout: 3000,
              env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
        // Do not return diagnostic stderr (it can contain paths or runtime state).
        if (result.stderr.trim()) return { source: 'journal' as const, lines: [], available: false, truncated: false };
        const entries = result.stdout.split(/\r?\n/).filter(Boolean);
        let output = redactNodeLog(entries.slice(-lines).join('\n'));
        let truncated = entries.length >= lines;
        if (Buffer.byteLength(output, 'utf8') > OUTPUT_LIMIT) {
            // Trim whole lines, not partial secrets or UTF-8 byte fragments.
            const kept: string[] = [];
            let bytes = 0;
            for (const line of output.split('\n').reverse()) {
                const size = Buffer.byteLength(line, 'utf8') + (kept.length ? 1 : 0);
                // A single oversized newest entry must not hide readable earlier lines.
                // Never emit partial entries (especially incomplete redacted secrets).
                if (size > OUTPUT_LIMIT) continue;
                if (bytes + size > OUTPUT_LIMIT) break;
                kept.push(line);
                bytes += size;
            }
            output = kept.reverse().join('\n');
            truncated = true;
        }
        return { source: 'journal' as const, lines: output ? output.split('\n') : [], available: true, truncated };
    } catch {
        // Permission denied, journalctl missing, timeout and excessive output
        // are all explicit unavailable states; never retry with elevated access.
        return { source: 'journal' as const, lines: [], available: false, truncated: false };
    }
}
