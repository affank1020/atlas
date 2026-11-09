import { spawn } from 'node:child_process';

const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024;
const PDF_TIMEOUT_MS = 15000;

/**
 * A bounded, no-shell Poppler invocation. PDF data is sent over stdin; no
 * private file is written to a shared /tmp path. stdout is capped before it
 * can accumulate unbounded document content.
 */
export function extractPdfText(bytes: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'],
            { stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        let length = 0;
        let settled = false;
        const timer = setTimeout(() => fail(new Error('PDF text extraction timed out.')), PDF_TIMEOUT_MS);
        timer.unref();
        const cleanup = () => clearTimeout(timer);
        function fail(error: Error) {
            if (settled) return;
            settled = true;
            cleanup();
            child.kill('SIGKILL');
            reject(error);
        }
        child.on('error', error => fail(new Error(
            (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'PDF extraction is unavailable: pdftotext is not installed.'
                : 'PDF text extraction failed.'
        )));
        child.stdout.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > MAX_EXTRACTED_BYTES) {
                fail(new Error('PDF extracted text exceeds the supported limit.'));
                return;
            }
            chunks.push(chunk);
        });
        // Never echo stderr, which can contain information about private PDFs.
        child.stderr.on('data', () => undefined);
        child.stdin.on('error', () => undefined); // Handles EPIPE on malformed PDFs.
        child.on('close', code => {
            if (settled) return;
            settled = true;
            cleanup();
            if (code !== 0) {
                reject(new Error('PDF text extraction failed (encrypted, malformed or unsupported PDF).'));
                return;
            }
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        child.stdin.end(bytes);
    });
}

