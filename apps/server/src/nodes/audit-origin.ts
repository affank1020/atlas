import type { ShareAuditClient } from './share-approvals.js';

/** A trusted entrypoint, not a user-provided header or a verified human actor. */
export type NodeAuditOrigin = {
    client: string;
    transport: 'http' | 'mcp' | 'server' | 'node-credential' | 'enrolment-token';
    actorKind: 'transport' | 'node-credential' | 'enrolment-token';
};

export function toolAuditOrigin(caller: ShareAuditClient): NodeAuditOrigin {
    return { client: caller,
        transport: caller === 'atlas-http' ? 'http' : caller === 'atlas-mcp' ? 'mcp' : 'server',
        actorKind: 'transport' };
}

/** Only set after verifying a Node credential or consuming an enrolment ticket. */
export const nodeCredentialOrigin: NodeAuditOrigin = {
    client: 'atlas-node-credential', transport: 'node-credential', actorKind: 'node-credential',
};
export const enrolmentOrigin: NodeAuditOrigin = {
    client: 'atlas-node-enrolment', transport: 'enrolment-token', actorKind: 'enrolment-token',
};
