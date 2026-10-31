import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sealInboxText, openInboxText, readInboxKey, digestInboxSubmission, sameDigest, validateInboxText } from '../src/nodes/offline-inbox-crypto.js';

const from = '123e4567-e89b-42d3-a456-426614174000';
const to = '123e4567-e89b-42d3-a456-426614174001';
const id = '123e4567-e89b-42d3-a456-426614174002';

describe('encrypted offline inbox envelope', () => {
  it('roundtrips unicode/newlines, never stores plaintext in ciphertext', () => {
    const key = randomBytes(32), text = 'notes 📝\n数学 ✅';
    const envelope = sealInboxText(key, from, to, id, text);
    assert.equal(openInboxText(key, from, to, id, envelope), text);
    assert.equal(envelope.ciphertext.includes(Buffer.from(text)), false);
    assert.equal(envelope.nonce.length, 12);
    assert.equal(envelope.tag.length, 16);
  });
  it('binds ciphertext to authenticated sender, target and delivery ID', () => {
    const key = randomBytes(32), envelope = sealInboxText(key, from, to, id, 'secret');
    assert.throws(() => openInboxText(key, to, from, id, envelope));
    assert.throws(() => openInboxText(key, from, to, from, envelope));
    assert.throws(() => openInboxText(randomBytes(32), from, to, id, envelope));
    const tampered = { ...envelope, ciphertext: Buffer.from(envelope.ciphertext) };
    tampered.ciphertext[0]! ^= 1;
    assert.throws(() => openInboxText(key, from, to, id, tampered));
  });
  it('fails closed for malformed key, invalid text and oversized content', () => {
    const key = randomBytes(32), encoded = key.toString('base64');
    assert.deepEqual(readInboxKey(encoded), key);
    assert.throws(() => readInboxKey(undefined));
    assert.throws(() => readInboxKey(encoded.slice(0,-1)));
    assert.throws(() => validateInboxText(''));
    assert.throws(() => validateInboxText('x'.repeat(16_385)));
    assert.throws(() => validateInboxText('🙂'.repeat(9_000)));
  });
  it('detects replay payload mismatch in constant-time comparison', () => {
    const a = digestInboxSubmission(to, 'hello');
    assert.equal(sameDigest(a, digestInboxSubmission(to, 'hello')), true);
    assert.equal(sameDigest(a, digestInboxSubmission(to, 'goodbye')), false);
    assert.equal(sameDigest(a, digestInboxSubmission(from, 'hello')), false);
  });
});
