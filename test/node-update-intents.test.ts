import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { NodeUpdateIntentLedger } from '../apps/server/src/nodes/update-intents.js';
import type { NodeRelease } from '../apps/server/src/nodes/releases.js';

after(cleanupDatabases);

const sourceCommit = 'b'.repeat(40);
const candidate: NodeRelease = {
    component: 'desktop-node', platform: 'linux', architecture: 'any',
    channel: 'stable', version: '2.0.1', commit: sourceCommit.slice(0, 12),
    sourceCommit, sourceOrder: 19, protocol: 2, minimumNodeJs: 20,
    publishedAt: '2026-10-21T12:00:00Z', notes: '',
    downloadUrl: 'https://github.com/affank1020/atlas/releases/download/node-v2.0.1-' + sourceCommit.slice(0, 12) + '/atlas-node.tar.gz',
    checksumUrl: '', releaseUrl: '', sha256: 'a'.repeat(64),
    provenance: 'unverified',
};

async function fixture() {
    const db = await databaseFixture();
    const identity = new NodeIdentity(db.store.pool);
    const token = await identity.ticket();
    const enrolled = await identity.enrol({
        token: token.enrolmentToken, name: 'Linux Node', platform: 'linux', version: '2.0.0+aaaaaaaaaaaa',
    });
    await db.store.pool.query(`UPDATE nodes SET status='online' WHERE id=$1`, [enrolled.nodeId]);
    const row = await db.store.pool.query('SELECT version,credential_updated_at FROM nodes WHERE id=$1', [enrolled.nodeId]);
    const credentialAt = new Date(row.rows[0].credential_updated_at).toISOString();
    const ledger = new NodeUpdateIntentLedger(db.store.pool);
    return { db, identity, ledger, nodeId: enrolled.nodeId, credential: enrolled.credential,
        version: row.rows[0].version as string, credentialAt };
}
const fails = (code: string) => (error: any) => error.code === code;

test('prepare creates one durable, audited, non-executable Node intent and permits cancel', async () => {
    const f = await fixture();
    const initial = await f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate);
    assert.equal(initial.status, 'requested');
    assert.equal(initial.approved, false);
    assert.equal(initial.executable, false);
    assert.equal(initial.targetSourceCommit, sourceCommit);
    assert.equal(initial.targetSha256, candidate.sha256);
    assert.ok(Date.parse(initial.expiresAt) - Date.parse(initial.createdAt) <= 15 * 60 * 1000);
    assert.equal((await f.ledger.list(f.nodeId))[0]?.id, initial.id);

    const duplicate = await f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate)
        .then(() => null, (error: any) => error);
    assert.equal(duplicate.code, 'CONFLICT');
    const cancelled = await f.ledger.cancel(f.nodeId, initial.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.resolvedAt !== null, true);
    await assert.rejects(f.ledger.cancel(f.nodeId, initial.id), fails('CONFLICT'));
    const next = await f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate);
    assert.notEqual(next.id, initial.id);

    const audit = await f.db.store.pool.query(`SELECT operation,after_state FROM audit_events
        WHERE operation LIKE 'node.update_intent_%' ORDER BY created_at,id`);
    assert.equal(audit.rowCount, 3);
    assert.deepEqual(new Set(audit.rows.map(x => x.operation)),
        new Set(['node.update_intent_prepared','node.update_intent_cancelled']));
    assert.ok(audit.rows.every(x => x.after_state.approved === false && x.after_state.executable === false));
});

test('parallel prepare requests serialize and never create two active requests', async () => {
    const f = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 3 }, () =>
        f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate)));
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter(x => x.status === 'rejected').length, 2);
    const active = await f.db.store.pool.query(`SELECT count(*)::int AS total FROM node_update_intents
        WHERE node_id=$1 AND status='requested'`, [f.nodeId]);
    assert.equal(active.rows[0].total, 1);
});

test('expiration is visible and expired intents do not block new prepared requests', async () => {
    const f = await fixture();
    const first = await f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate);
    await f.db.store.pool.query(`UPDATE node_update_intents
        SET created_at=now()-interval '20 minutes',expires_at=now()-interval '5 minutes'
        WHERE id=$1`, [first.id]);
    assert.equal((await f.ledger.list(f.nodeId))[0]?.status, 'expired');
    await assert.rejects(f.ledger.cancel(f.nodeId, first.id), fails('CONFLICT'));
    const next = await f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate);
    assert.notEqual(next.id, first.id);
    const rows = await f.db.store.pool.query('SELECT status FROM node_update_intents WHERE id=$1', [first.id]);
    assert.equal(rows.rows[0].status, 'expired');
});

test('rotation, revocation, stale version or wrong platform prevent request creation', async () => {
    const f = await fixture();
    await assert.rejects(f.ledger.prepare(f.nodeId, '2.0.1+wrongversion', f.credentialAt, candidate), fails('CONFLICT'));
    await f.db.store.pool.query(`UPDATE nodes SET version='2.0.1+different',credential_updated_at=now()+interval '2 seconds'
        WHERE id=$1`, [f.nodeId]);
    await assert.rejects(f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate), fails('CONFLICT'));
    await f.identity.revoke(f.nodeId);
    await assert.rejects(f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate), fails('CONFLICT'));
    const node = await f.db.store.pool.query('SELECT id FROM node_update_intents WHERE node_id=$1', [f.nodeId]);
    assert.equal(node.rowCount, 0);
});

test('cancel is scoped to the Node and rejected for a mismatched ID', async () => {
    const a = await fixture(), b = await fixture();
    const intent = await a.ledger.prepare(a.nodeId, a.version, a.credentialAt, candidate);
    await assert.rejects(a.ledger.cancel(b.nodeId, intent.id), fails('NOT_FOUND'));
    assert.equal((await a.ledger.list(a.nodeId))[0]?.status, 'requested');
});

test('the ledger rejects untrusted release metadata before creating a request', async () => {
    const f = await fixture();
    await assert.rejects(f.ledger.prepare(f.nodeId, f.version, f.credentialAt, {
        ...candidate, sourceCommit: 'c'.repeat(40),
    }), fails('INVALID_INPUT'));
    await assert.rejects(f.ledger.prepare(f.nodeId, f.version, f.credentialAt, {
        ...candidate, platform: 'darwin',
    }), fails('INVALID_INPUT'));
});

test('claimed intent is single-use, immutable and prevents a second prepare', async () => {
    const f = await fixture();
    const intent = await f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate);
    const claimed = await f.ledger.claim(f.nodeId, intent.id, f.credential, f.version, candidate.sha256);
    assert.equal(claimed.status, 'claimed');
    assert.ok(claimed.resolvedAt, 'claim must be durable, not an in-memory flag');
    assert.equal(claimed.approved, false, 'Server claim is not host authorisation');
    assert.equal(claimed.executable, false, 'Server claim is not host execution');
    await assert.rejects(f.ledger.claim(f.nodeId, intent.id, f.credential, f.version, candidate.sha256), fails('CONFLICT'));
    await assert.rejects(f.ledger.cancel(f.nodeId, intent.id), fails('CONFLICT'));
    await assert.rejects(f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate), fails('CONFLICT'));
    const row = (await f.ledger.list(f.nodeId))[0]!;
    assert.equal(row.status, 'claimed');
    const event = await f.db.store.pool.query("SELECT after_state FROM audit_events WHERE operation='node.update_intent_claimed' AND after_state->>'intentId'=$1", [intent.id]);
    assert.equal(event.rowCount, 1);
    assert.equal(event.rows[0].after_state.executable, false);
});

test('claims reject wrong credential, identity, digest, build, cancellation and expiry', async () => {
    const f = await fixture();
    // Both identities must exist in the *same* database to exercise the
    // intent's Node scoping rather than an unknown Node credential.
    const ticket = await f.identity.ticket();
    const other = await f.identity.enrol({
        token: ticket.enrolmentToken, name: 'Other Linux Node',
        platform: 'linux', version: f.version,
    });
    await f.db.store.pool.query("UPDATE nodes SET status='online' WHERE id=$1", [other.nodeId]);
    const prepared = await f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate);
    const call = (credential: string, version=f.version, digest=candidate.sha256, id=prepared.id, node=f.nodeId) =>
        f.ledger.claim(node, id, credential, version, digest);
    await assert.rejects(call(other.credential), fails('NODE_AUTH_INVALID'));
    await assert.rejects(call(other.credential, f.version, candidate.sha256, prepared.id, other.nodeId), fails('NOT_FOUND'));
    await assert.rejects(call(f.credential, f.version, 'b'.repeat(64)), fails('CONFLICT'));
    await assert.rejects(call(f.credential, '2.0.1+bbbbbbbbbbbb'), fails('CONFLICT'));
    const after = (await f.ledger.list(f.nodeId))[0]!;
    assert.equal(after.status, 'requested', 'refusals never consume a valid intent');
    await f.ledger.cancel(f.nodeId, prepared.id);
    await assert.rejects(call(f.credential), fails('CONFLICT'));
    const prepared2 = await f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate);
    await f.db.store.pool.query("UPDATE node_update_intents SET created_at=now()-interval '20 minutes', expires_at=now()-interval '5 minutes' WHERE id=$1", [prepared2.id]);
    await assert.rejects(call(f.credential, f.version, candidate.sha256, prepared2.id), fails('CONFLICT'));
});

test('claims refuse rotated/revoked credentials, changed Node versions and offline Nodes', async () => {
    const f = await fixture();
    const first = await f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate);
    await f.db.store.pool.query("UPDATE nodes SET status='offline' WHERE id=$1", [f.nodeId]);
    await assert.rejects(f.ledger.claim(f.nodeId, first.id, f.credential, f.version, candidate.sha256), fails('CONFLICT'));
    await f.db.store.pool.query("UPDATE nodes SET status='online',version='2.1.0+eeeeeeeeeeee' WHERE id=$1", [f.nodeId]);
    await assert.rejects(f.ledger.claim(f.nodeId, first.id, f.credential, f.version, candidate.sha256), fails('CONFLICT'));
    await f.db.store.pool.query("UPDATE nodes SET version=$2,credential_updated_at=now()+interval '1 minute' WHERE id=$1", [f.nodeId,f.version]);
    await assert.rejects(f.ledger.claim(f.nodeId, first.id, f.credential, f.version, candidate.sha256), fails('CONFLICT'));
    await f.identity.revoke(f.nodeId);
    await assert.rejects(f.ledger.claim(f.nodeId, first.id, f.credential, f.version, candidate.sha256), fails('NODE_AUTH_INVALID'));
});

test('simultaneous claims and cancellation produce at most one terminal decision', async () => {
    const f = await fixture();
    const prepared = await f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate);
    const results = await Promise.allSettled([
        f.ledger.claim(f.nodeId, prepared.id, f.credential, f.version, candidate.sha256),
        f.ledger.claim(f.nodeId, prepared.id, f.credential, f.version, candidate.sha256),
        f.ledger.cancel(f.nodeId, prepared.id),
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    const current = (await f.ledger.list(f.nodeId))[0]!;
    assert.ok(current.status === 'cancelled' || current.status === 'claimed');
    assert.equal(results.filter(x => x.status === 'rejected').length, 2);
});

test('claims legacy SemVer-only Node versions that planning and preparation accept', async () => {
    const f = await fixture();
    const legacy = '1.9.9';
    await f.db.store.pool.query('UPDATE nodes SET version=$2 WHERE id=$1', [f.nodeId, legacy]);
    const intent = await f.ledger.prepare(f.nodeId, legacy, f.credentialAt, candidate);
    assert.equal(intent.installedVersion, legacy);
    await assert.rejects(
        f.ledger.claim(f.nodeId, intent.id, f.credential, '1.9.9+aaaaaaaaaaaa', candidate.sha256),
        fails('CONFLICT'),
    );
    const result = await f.ledger.claim(f.nodeId, intent.id, f.credential, legacy, candidate.sha256);
    assert.equal(result.status, 'claimed');
    assert.equal(result.installedVersion, legacy);
    assert.equal(result.executable, false);
});

test('an intent that expires while claim waits for its Node lock cannot be claimed', async () => {
    const f = await fixture();
    const intent = await f.ledger.prepare(f.nodeId, f.version, f.credentialAt, candidate);
    // Use actual PostgreSQL lock contention. PostgreSQL now() would still
    // evaluate at transaction start, allowing a stale claim after this wait.
    const blocker = await f.db.store.pool.connect();
    let claim: Promise<unknown> | undefined;
    try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM nodes WHERE id=$1 FOR UPDATE', [f.nodeId]);
        await blocker.query(`UPDATE node_update_intents
            SET expires_at=clock_timestamp()+interval '3 seconds'
            WHERE id=$1`, [intent.id]);
        // The UPDATE belongs to the blocker transaction; commit expiry first,
        // while preserving the Node row lock via a separate transaction.
        // The committed expiry can be checked from another connection.
        await blocker.query('COMMIT');
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM nodes WHERE id=$1 FOR UPDATE', [f.nodeId]);
        claim = f.ledger.claim(f.nodeId, intent.id, f.credential, f.version, candidate.sha256);
        // Prove the claim began BEFORE expiry, but is blocked on the Node lock.
        let waiting = false;
        for (let attempt = 0; attempt < 80; attempt++) {
            const state = await blocker.query(`SELECT EXISTS(
                SELECT 1 FROM pg_stat_activity
                WHERE datname=current_database() AND wait_event_type='Lock'
                  AND query LIKE '%FROM nodes WHERE id=$1 FOR UPDATE%'
            ) AS blocked`);
            if (state.rows[0].blocked) { waiting = true; break; }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(waiting, true, 'claim should be blocked before the intent expires');
        let expired = false;
        for (let attempt = 0; attempt < 50; attempt++) {
            const check = await blocker.query(`SELECT clock_timestamp() >= expires_at AS expired
                FROM node_update_intents WHERE id=$1`, [intent.id]);
            if (check.rows[0].expired) { expired = true; break; }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(expired, true, 'intent must have expired while claim holds its transaction');
        await blocker.query('COMMIT');
        await assert.rejects(claim, fails('CONFLICT'));
        claim = undefined;
        const saved = (await f.ledger.list(f.nodeId))[0]!;
        assert.equal(saved.status, 'expired');
        const record = await f.db.store.pool.query(
            'SELECT status,resolved_at FROM node_update_intents WHERE id=$1', [intent.id]);
        assert.equal(record.rows[0].status, 'requested');
        assert.equal(record.rows[0].resolved_at, null);
    } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
        if (claim) await claim.catch(() => undefined);
    }
});
