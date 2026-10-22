import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import {
    rootUpdateAttestationMessage,
    verifyRootUpdateAttestation,
    type RootUpdateAttestation,
    type ExpectedRootUpdate,
} from '../apps/server/src/nodes/root-evidence.js';

const expected: ExpectedRootUpdate = {
    nodeId: '01234567-89ab-4cde-8fab-0123456789ab',
    intentId: '12345678-90ab-4cde-8fab-1234567890ab',
    challenge: 'c'.repeat(64),
    activeVersion: '2.0.1+' + 'b'.repeat(12),
    targetSha256: 'a'.repeat(64),
};

function fixture() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const raw = {
        ...expected, observedPid: 4242,
    };
    const attestation: RootUpdateAttestation = {
        schema: 1,
        ...raw,
        signature: sign(null, rootUpdateAttestationMessage(raw), privateKey).toString('base64'),
    };
    return { publicPem, attestation };
}

test('valid host-root evidence verifies only under the independently pinned Ed25519 key', () => {
    const { attestation, publicPem } = fixture();
    assert.equal(verifyRootUpdateAttestation(attestation, publicPem, expected), true);
    assert.equal(verifyRootUpdateAttestation(attestation, fixture().publicPem, expected), false);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
        .export({ format: 'pem', type: 'spki' }).toString();
    assert.equal(verifyRootUpdateAttestation(attestation, rsa, expected), false);
    assert.equal(verifyRootUpdateAttestation(attestation, 'untrusted key text', expected), false);
});

test('identity, target, challenge and version cannot be substituted after signing', () => {
    const { attestation, publicPem } = fixture();
    for (const [key, value] of [
        ['nodeId', '22222222-2222-4222-8222-222222222222'],
        ['intentId', '33333333-3333-4333-8333-333333333333'],
        ['challenge', 'd'.repeat(64)],
        ['activeVersion', '2.0.2+' + 'b'.repeat(12)],
        ['targetSha256', 'e'.repeat(64)],
        ['observedPid', 4243],
        ['schema', 2],
        ['signature', Buffer.alloc(64).toString('base64')],
    ] as const) {
        assert.equal(verifyRootUpdateAttestation({ ...attestation, [key]: value },
            publicPem, expected), false, key);
    }
    for (const [key, value] of [
        ['nodeId', '22222222-2222-4222-8222-222222222222'],
        ['intentId', '33333333-3333-4333-8333-333333333333'],
        ['challenge', 'f'.repeat(64)],
        ['activeVersion', '2.0.2+' + 'b'.repeat(12)],
        ['targetSha256', 'e'.repeat(64)],
    ] as const) {
        assert.equal(verifyRootUpdateAttestation(attestation, publicPem,
            { ...expected, [key]: value }), false, key);
    }
});

test('untrusted evidence schema, signature, PID and encodings fail closed', () => {
    const { attestation, publicPem } = fixture();
    const invalid = [
        null, [], {}, 1, '',
        { ...attestation, extra: 'ignored?' },
        { ...attestation, observedPid: '4242' },
        { ...attestation, observedPid: -1 },
        { ...attestation, observedPid: 1.2 },
        { ...attestation, observedPid: Number.MAX_SAFE_INTEGER },
        { ...attestation, signature: 'a' },
        { ...attestation, signature: attestation.signature.replace(/.$/, '!') },
        { ...attestation, targetSha256: 'A'.repeat(64) },
        { ...attestation, challenge: 'f'.repeat(63) },
        { ...attestation, activeVersion: '2.0.1' },
        { ...attestation, schema: '1' },
        { ...attestation, signature: null },
    ];
    for (const item of invalid)
        assert.equal(verifyRootUpdateAttestation(item, publicPem, expected), false);
});
