import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';

/**
 * Offline verifier for the *future* root-attested reconciliation protocol.
 *
 * This has no route, tool, database mutation or key enrolment in this phase.
 * Public keys must eventually be pinned by a separately trusted administrator
 * (never supplied by the Node or the signed message). A signature proves only
 * possession of the host-root key, not live health or successful deployment.
 */
export type RootUpdateAttestation = {
    schema: 1;
    nodeId: string;
    intentId: string;
    challenge: string;
    activeVersion: string;
    targetSha256: string;
    observedPid: number;
    signature: string;
};

export type ExpectedRootUpdate = {
    nodeId: string;
    intentId: string;
    challenge: string;
    activeVersion: string;
    targetSha256: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9]+[.][0-9]+[.][0-9]+[+][0-9a-f]{12}$/;
const BASE64_SIGNATURE = /^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/;

function validFields(value: Record<string, unknown>) {
    return Object.keys(value).sort().join(',') ===
        'activeVersion,challenge,intentId,nodeId,observedPid,schema,signature,targetSha256' &&
        value.schema === 1 && typeof value.nodeId === 'string' && UUID.test(value.nodeId) &&
        typeof value.intentId === 'string' && UUID.test(value.intentId) &&
        typeof value.challenge === 'string' && SHA256.test(value.challenge) &&
        typeof value.activeVersion === 'string' && VERSION.test(value.activeVersion) &&
        typeof value.targetSha256 === 'string' && SHA256.test(value.targetSha256) &&
        Number.isSafeInteger(value.observedPid) && (value.observedPid as number) > 1 &&
        (value.observedPid as number) <= 0x7fffffff &&
        typeof value.signature === 'string' && BASE64_SIGNATURE.test(value.signature);
}

/** The exact bytes signed by OpenSSL on the host, with domain separation. */
export function rootUpdateAttestationMessage(
    fields: Omit<RootUpdateAttestation, 'schema' | 'signature'>,
): Buffer {
    return Buffer.from([
        'atlas-node-root-update-attestation-v1',
        fields.nodeId,
        fields.intentId,
        fields.challenge,
        fields.activeVersion,
        fields.targetSha256,
        String(fields.observedPid),
        '',
    ].join('\n'), 'utf8');
}

export function verifyRootUpdateAttestation(
    input: unknown, pinnedPublicKeyPem: string, expected: ExpectedRootUpdate,
): boolean {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        !validFields(input as Record<string, unknown>)) return false;
    const value = input as RootUpdateAttestation;
    if (value.nodeId !== expected.nodeId || value.intentId !== expected.intentId ||
        value.challenge !== expected.challenge ||
        value.activeVersion !== expected.activeVersion ||
        value.targetSha256 !== expected.targetSha256) return false;
    // The PEM is a *trusted, administrator-pinned input*, never read from
    // the attestation or offered by the Node credential as an enrolment.
    try {
        if (typeof pinnedPublicKeyPem !== 'string' || pinnedPublicKeyPem.length > 4096)
            return false;
        const key = createPublicKey(pinnedPublicKeyPem);
        if (key.asymmetricKeyType !== 'ed25519') return false;
        return verifySignature(null, rootUpdateAttestationMessage(value), key,
            Buffer.from(value.signature, 'base64'));
    } catch {
        return false;
    }
}
