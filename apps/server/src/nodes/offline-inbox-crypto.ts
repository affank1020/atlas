import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The server never places cleartext device content in PostgreSQL or audit logs. */
export type InboxEnvelope = { nonce: Buffer; tag: Buffer; ciphertext: Buffer };
export const DEVICE_INBOX_MAX_TEXT_BYTES = 32 * 1024;
export const DEVICE_INBOX_TTL_MS = 24 * 60 * 60 * 1000;
const keyBytes = 32;

export function readInboxKey(base64: string | undefined): Buffer {
    if (!base64 || !/^[A-Za-z0-9+/]{43}=$/.test(base64))
        throw new Error('ATLAS_DEVICE_INBOX_KEY must be a canonical 32-byte base64 secret.');
    const key = Buffer.from(base64, 'base64');
    if (key.length !== keyBytes || key.toString('base64') !== base64)
        throw new Error('ATLAS_DEVICE_INBOX_KEY is invalid.');
    return key;
}

export function validateInboxText(text: string): Buffer {
    if (!text || text.length > 16_384)
        throw new Error('Device share text must contain 1–16384 characters.');
    const bytes = Buffer.from(text, 'utf8');
    if (!bytes.length || bytes.length > DEVICE_INBOX_MAX_TEXT_BYTES)
        throw new Error('Device share exceeds the inbox byte limit.');
    return bytes;
}

const aad = (source: string, target: string, deliveryId: string) =>
    Buffer.from('atlas-device-inbox-v1\0' + source.toLowerCase() + '\0' +
        target.toLowerCase() + '\0' + deliveryId.toLowerCase(), 'utf8');

export function sealInboxText(key: Buffer, source: string, target: string, deliveryId: string, text: string): InboxEnvelope {
    if (key.length !== keyBytes) throw new Error('Invalid inbox encryption key.');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(source,target,deliveryId));
    const ciphertext = Buffer.concat([cipher.update(validateInboxText(text)), cipher.final()]);
    return { nonce, tag: cipher.getAuthTag(), ciphertext };
}

export function openInboxText(key: Buffer, source: string, target: string, deliveryId: string, envelope: InboxEnvelope): string {
    if (key.length !== keyBytes || envelope.nonce.length !== 12 || envelope.tag.length !== 16 ||
        envelope.ciphertext.length < 1 || envelope.ciphertext.length > DEVICE_INBOX_MAX_TEXT_BYTES)
        throw new Error('Invalid inbox envelope.');
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce);
    decipher.setAAD(aad(source,target,deliveryId));
    decipher.setAuthTag(envelope.tag);
    const bytes = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    validateInboxText(text);
    return text;
}

export function digestInboxSubmission(key: Buffer, target: string, text: string): string {
    if (key.length !== 32) throw new Error('Invalid inbox digest key.');
    // Keyed digest avoids offline dictionary attacks against predictable short notes.
    return createHmac('sha256', key).update(target.toLowerCase()).update('\0')
        .update(validateInboxText(text)).digest('hex');
}

export function sameDigest(left: string, right: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
    return timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
}
