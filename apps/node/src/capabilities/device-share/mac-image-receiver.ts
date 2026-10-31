import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AtlasError } from '@atlas/protocol/errors';
import { MAX_DEVICE_IMAGE_BYTES, type DeviceImageDelivery } from '@atlas/protocol/device-protocol';

export type IncomingImage = Omit<DeviceImageDelivery, 'type' | 'kind' | 'requestId'> & { bytes: Buffer };
type Approve = (input: IncomingImage, signal?: AbortSignal) => Promise<boolean>;
type Copy = (input: IncomingImage, signal?: AbortSignal) => Promise<void>;

/** Use osascript stdin exclusively: never put user image bytes in argv, an
 * environment variable, a log or a persistent temp file.
 */
async function osascript(script: string, language: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new AtlasError('Node stopped.', 'NODE_DISCONNECTED');
    return new Promise((resolve, reject) => {
        const child = spawn('osascript', [...language, '-'], {
            stdio: ['pipe', 'pipe', 'ignore'], signal,
        });
        let settled = false, output = '';
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            error ? reject(error) : resolve(output.trim());
        };
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish(Error('Image operation timed out.')); }, timeoutMs);
        child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(0, 32); });
        child.once('error', finish);
        child.once('close', code => finish(code === 0 ? undefined : Error('Image approval or clipboard write failed.')));
        child.stdin.once('error', () => undefined);
        child.stdin.end(script);
    });
}
export async function promptMacImage(input: IncomingImage, signal?: AbortSignal): Promise<boolean> {
    const src = input.sourceNodeId.slice(0, 8);
    const format = input.mimeType === 'image/png' ? 'PNG' : 'JPEG';
    const script = `display dialog "Atlas image from Node ${src} (${format}, ${Math.ceil(input.bytes.length / 1024)} KiB)" with title "Atlas" buttons {"Decline", "Copy image"} default button "Decline" giving up after 15
return button returned of result
`;
    try { return await osascript(script, [], 18_000, signal) === 'Copy image'; }
    catch { return false; }
}
export function imagePasteboardScript(input: IncomingImage): string {
    const encoded = input.bytes.toString('base64');
    // NSPasteboardTypePNG and public.jpeg carry genuine image bytes, not
    // a file URL or encoded text type. This accepts cropped snips too.
    const type = input.mimeType === 'image/png' ? 'public.png' : 'public.jpeg';
    return `ObjC.import('AppKit');
const data = $.NSData.alloc.initWithBase64EncodedStringOptions($('${encoded}'), 0);
if (!data || data.length !== ${input.bytes.length}) throw Error('Invalid image bytes');
const pasteboard = $.NSPasteboard.generalPasteboard;
const imageType = $('${type}');
pasteboard.declareTypesOwner($.NSArray.arrayWithObject(imageType), null);
if (!pasteboard.setDataForType(data, imageType)) throw Error('Image pasteboard write failed');
`;
}
export async function copyMacImage(input: IncomingImage, signal?: AbortSignal): Promise<void> {
    await osascript(imagePasteboardScript(input), ['-l', 'JavaScript'], 9_000, signal);
}
/** One explicit clipboard approval per image; at most one active prompt. */
export class MacImageReceiver {
    private active = false;
    private readonly seen = new Map<string, { digest: string; accepted: boolean; at: number }>();
    constructor(private readonly approve: Approve = promptMacImage, private readonly copy: Copy = copyMacImage) {}
    async receive(input: IncomingImage, signal?: AbortSignal): Promise<{ accepted: boolean }> {
        if (signal?.aborted || !Number.isFinite(Date.parse(input.expiresAt)) ||
            Date.parse(input.expiresAt) <= Date.now() ||
            input.bytes.length !== input.byteLength || input.bytes.length < 24 ||
            input.bytes.length > MAX_DEVICE_IMAGE_BYTES ||
            createHash('sha256').update(input.bytes).digest('hex') !== input.sha256)
            throw new AtlasError('Image expired or invalid.', 'SHARE_INVALID');
        const old = this.seen.get(input.deliveryId);
        if (old) {
            if (old.digest !== input.sha256) throw new AtlasError('Image ID reused.', 'SHARE_REPLAY');
            return { accepted: old.accepted };
        }
        if (this.active) throw new AtlasError('Mac already awaiting image approval.', 'SHARE_BUSY');
        this.active = true;
        try {
            const accepted = await this.approve(input, signal);
            if (!accepted || signal?.aborted || Date.parse(input.expiresAt) <= Date.now()) {
                this.remember(input, false);
                return { accepted: false };
            }
            try { await this.copy(input, signal); }
            catch { throw new AtlasError('Mac image clipboard write failed.', 'SHARE_CLIPBOARD_FAILED'); }
            this.remember(input, true);
            return { accepted: true };
        } finally { this.active = false; }
    }
    private remember(input: IncomingImage, accepted: boolean) {
        for (const [id, entry] of this.seen) if (entry.at + 300_000 < Date.now()) this.seen.delete(id);
        if (this.seen.size >= 512) this.seen.delete(this.seen.keys().next().value!);
        this.seen.set(input.deliveryId, { digest: input.sha256, accepted, at: Date.now() });
    }
}
