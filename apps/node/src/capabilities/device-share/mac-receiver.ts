import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AtlasError } from '@atlas/protocol/errors';

export interface IncomingShare {
    deliveryId: string;
    sourceNodeId: string;
    text: string;
    expiresAt: string;
}
type Prompt = (input: IncomingShare, signal?: AbortSignal) => Promise<boolean>;
type Copy = (text: string, signal?: AbortSignal) => Promise<void>;

/** No share content goes to a command-line argument, environment or app logs. */
async function command(command: string, args: string[], stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('Node stopped');
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], signal });
        let finished = false, output = '';
        const finish = (error?: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            error ? reject(error) : resolve(output.trim());
        };
        const timeout = setTimeout(() => { proc.kill('SIGKILL'); finish(new Error('Share confirmation timed out')); }, timeoutMs);
        proc.stdout.on('data', bytes => { output = (output + String(bytes)).slice(0, 128); });
        proc.on('error', error => finish(error));
        proc.on('close', code => finish(code === 0 ? undefined : new Error('User declined or system UI unavailable')));
        proc.stdin.on('error', () => { /* Failure is observed on process exit. */ });
        proc.stdin.end(stdin);
    });
}
function escapeAppleScript(text: string) {
    return text.replace(/[\\"]/g, '\\$&').replace(/[\r\n\u2028\u2029]/g, ' ');
}
/** Operates in a macOS login session, not on Linux or a headless VPS. */
export async function promptMacShare(input: IncomingShare, signal?: AbortSignal): Promise<boolean> {
    const preview = input.text.slice(0, 180).replace(/[\u0000-\u001f\u007f]/g, ' ') +
        (input.text.length > 180 ? '…' : '');
    const source = input.sourceNodeId.slice(0, 8);
    const script = 'set response to display dialog "Atlas share from Node ' +
        escapeAppleScript(source) + '" & return & return & "' + escapeAppleScript(preview) +
        '" with title "Atlas" buttons {"Decline", "Copy"} default button "Decline" giving up after 15\n' +
        'return button returned of response\n';
    try { return (await command('osascript', ['-'], script, 18_000, signal)) === 'Copy'; }
    catch { return false; }
}
/** Use NSPasteboard's string type, not pbcopy header inference (RTF/EPS).
 * Base64 keeps all Unicode and RTF-looking user content out of JS source,
 * subprocess argv/environment and command diagnostics.
 */
export function plainTextPasteboardScript(text: string): string {
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    return `ObjC.import('AppKit');
const data = $.NSData.alloc.initWithBase64EncodedStringOptions($('${encoded}'), 0);
if (!data) throw Error('Invalid clipboard bytes');
const value = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
if (!value) throw Error('Clipboard text is not UTF-8');
const pasteboard = $.NSPasteboard.generalPasteboard;
// setStringForType requires the type to have been declared first.
// declareTypesOwner also clears existing clipboard contents atomically.
pasteboard.declareTypesOwner($.NSArray.arrayWithObject($.NSPasteboardTypeString), null);
if (!pasteboard.setStringForType(value, $.NSPasteboardTypeString))
    throw Error('Could not write macOS plain-text pasteboard');
`;
}
export async function copyMacShare(text: string, signal?: AbortSignal) {
    // JXA bridges NSPasteboard; its actual pasteboard data type is explicit.
    await command('osascript', ['-l', 'JavaScript', '-'], plainTextPasteboardScript(text), 7_000, signal);
}

/**
 * Explicit user approval before writing the clipboard. Serialized prompts,
 * strict expiry, bounded replay tracking. No disk persistence or file transfer.
 */
export class MacShareReceiver {
    private active = false;
    private readonly seen = new Map<string, { digest: string; accepted: boolean; at: number }>();
    constructor(private readonly prompt: Prompt = promptMacShare, private readonly copy: Copy = copyMacShare) {}
    async receive(input: IncomingShare, signal?: AbortSignal): Promise<{accepted: boolean}> {
        if (signal?.aborted || !Number.isFinite(Date.parse(input.expiresAt)) ||
            Date.parse(input.expiresAt) <= Date.now())
            throw new AtlasError('Share expired or Node is stopping.', 'SHARE_EXPIRED');
        const digest = createHash('sha256').update(input.sourceNodeId).update('\\0').update(input.text).digest('hex');
        const previous = this.seen.get(input.deliveryId);
        if (previous) {
            if (previous.digest !== digest) throw new AtlasError('Delivery ID reused.', 'SHARE_REPLAY');
            return { accepted: previous.accepted };
        }
        if (this.active) throw new AtlasError('Mac is already awaiting a share decision.', 'SHARE_BUSY');
        this.active = true;
        try {
            const approved = await this.prompt(input, signal);
            if (!approved || signal?.aborted || Date.parse(input.expiresAt) <= Date.now()) {
                this.store(input.deliveryId, digest, false);
                return { accepted: false };
            }
            try {
                await this.copy(input.text, signal);
            } catch {
                // Never forward JXA errors or clipboard content to the sender/logs.
                if (signal?.aborted) throw new AtlasError('Share interrupted.', 'SHARE_EXPIRED');
                throw new AtlasError('Mac could not write the clipboard.', 'SHARE_CLIPBOARD_FAILED');
            }
            this.store(input.deliveryId, digest, true);
            return { accepted: true };
        } finally {
            this.active = false;
        }
    }
    private store(id: string, digest: string, accepted: boolean) {
        for (const [key, value] of this.seen) if (value.at < Date.now() - 300_000) this.seen.delete(key);
        if (this.seen.size >= 512) this.seen.delete(this.seen.keys().next().value!);
        this.seen.set(id, { digest, accepted, at: Date.now() });
    }
}
