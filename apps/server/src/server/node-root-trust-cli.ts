import { config as loadEnv } from 'dotenv';
import { createInterface } from 'node:readline/promises';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Pool } from 'pg';
import { requireDatabaseUrl } from './config.js';
import { fingerprintHostRootKey, NodeRootTrustLedger } from '../nodes/root-trust-ledger.js';

// No HTTP, MCP, background task or Node capability calls this executable.
// Run only from a separately authenticated administrator's Server-side
// terminal with explicit, scoped PostgreSQL privileges.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const help = 'Usage: node-root-trust-cli pin <nodeId> <public-pem-file> | issue <nodeId> <claimed-intent-id> | reissue-expired <nodeId> <claimed-intent-id> | verify <nodeId> <intentId> <attestation-json-file> | status <nodeId> <intentId>';

async function boundedLocalFile(filename: string, limit: number): Promise<string> {
    const file = await open(filename,constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > limit)
            throw new Error('Invalid or oversized operator-supplied file.');
        const data = Buffer.alloc(limit + 1);
        let used = 0;
        while (used <= limit) {
            const { bytesRead } = await file.read(data, used, limit + 1 - used, null);
            if (!bytesRead) break;
            used += bytesRead;
        }
        if (used > limit) throw new Error('File changed or exceeded size bound.');
        return data.subarray(0,used).toString('utf8');
    } finally { await file.close(); }
}

async function main() {
    loadEnv({path:'apps/server/.env',quiet:true});
    const args = process.argv.slice(2);
    const action = args[0];
    if (!process.stdin.isTTY ||
        (action === 'pin' && args.length !== 3) ||
        (action === 'verify' && args.length !== 4) ||
        (action === 'issue' && args.length !== 3) ||
        (action === 'reissue-expired' && args.length !== 3) ||
        (action === 'status' && args.length !== 3) ||
        !['pin','verify','issue','reissue-expired','status'].includes(action ?? '') ||
        !UUID.test(args[1] ?? '') ||
        (action !== 'pin' && !UUID.test(args[2] ?? '')))
        throw new Error(help);

    const nodeId = args[1]!;
    const pool = new Pool({
        connectionString:requireDatabaseUrl(),
        max:2,connectionTimeoutMillis:5000,
    });
    const ledger = new NodeRootTrustLedger(pool);
    // Avoid asking for confirmation while a database connection/lock is held.
    const prompt = createInterface({ input:process.stdin, output:process.stderr });
    try {
        let result: unknown;
        if (action === 'pin') {
            const pem = await boundedLocalFile(args[2]!,512);
            const fingerprint = fingerprintHostRootKey(pem);
            console.error('Independent host-root public key fingerprint: '+fingerprint);
            console.error('Compare this with the host public key over an independently trusted channel.');
            const typed = await prompt.question('Type PIN '+nodeId+' '+fingerprint+' to trust this key: ');
            if (typed !== 'PIN '+nodeId+' '+fingerprint)
                throw new Error('Operator declined host-root key pinning.');
            result = await ledger.pin(nodeId,pem);
        } else if (action === 'issue') {
            const intentId = args[2]!;
            const typed = await prompt.question('Type ISSUE '+intentId+' to create ONE 5-minute challenge: ');
            if (typed !== 'ISSUE '+intentId) throw new Error('Operator declined challenge issuance.');
            result = await ledger.issue(nodeId,intentId);
        } else if (action === 'reissue-expired') {
            const intentId = args[2]!;
            console.error('Recovery: this invalidates one EXPIRED unconsumed nonce permanently.');
            console.error('It does not reset the update claim, re-run installation, or clear evidence.');
            const typed = await prompt.question('Type REISSUE-EXPIRED '+intentId+
                ' to retire the old nonce and issue a new five-minute challenge: ');
            if (typed !== 'REISSUE-EXPIRED '+intentId)
                throw new Error('Operator declined expired challenge reissue.');
            result = await ledger.reissueExpired(nodeId,intentId);
        } else if (action === 'verify') {
            const intentId = args[2]!;
            const raw = await boundedLocalFile(args[3]!,4096);
            const attestation = JSON.parse(raw);
            const typed = await prompt.question('Type VERIFY '+intentId+
                ' to consume its challenge after verifying the pinned signature: ');
            if (typed !== 'VERIFY '+intentId) throw new Error('Operator declined verification.');
            result = await ledger.verify(nodeId,intentId,attestation);
        } else {
            result = await ledger.status(nodeId,args[2]!);
        }
        console.log(JSON.stringify(result,null,2));
    } finally { prompt.close(); await pool.end(); }
}
void main().catch(() => {
    // No SQL errors, DB URLs, key material or untrusted paths in console logs.
    console.error('Root-trust operator action refused or unavailable; no claim was cleared.');
    process.exitCode = 1;
});
