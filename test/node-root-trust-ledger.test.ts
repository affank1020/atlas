import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { after, test } from 'node:test';
import { cleanupDatabases, databaseFixture } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { NodeUpdateIntentLedger } from '../apps/server/src/nodes/update-intents.js';
import { NodeRootTrustLedger, fingerprintHostRootKey } from '../apps/server/src/nodes/root-trust-ledger.js';
import { rootUpdateAttestationMessage } from '../apps/server/src/nodes/root-evidence.js';
import type { NodeRelease } from '../apps/server/src/nodes/releases.js';

after(cleanupDatabases);

const commit = 'b'.repeat(40);
const sha = 'd'.repeat(64);
const release: NodeRelease = {
    component:'desktop-node',platform:'linux',architecture:'any',channel:'stable',
    version:'2.0.1',commit:commit.slice(0,12),sourceCommit:commit,sourceOrder:19,
    protocol:2,minimumNodeJs:20,publishedAt:'2026-10-21T12:00:00Z',notes:'',
    downloadUrl:'https://github.com/affank1020/atlas/releases/download/node-v2.0.1-'
        +commit.slice(0,12)+'/atlas-node.tar.gz',
    checksumUrl:'',releaseUrl:'',sha256:sha,provenance:'unverified',
};
const fails = (code: string) => (error: any) => error.code === code;
async function fixture() {
    const db=await databaseFixture();
    const identity=new NodeIdentity(db.store.pool);
    const ticket=await identity.ticket();
    const node=await identity.enrol({ token:ticket.enrolmentToken,name:'Linux Node',
        platform:'linux',version:'2.0.0+'+'a'.repeat(12) });
    await db.store.pool.query("UPDATE nodes SET status='online' WHERE id=$1",[node.nodeId]);
    const metadata=await db.store.pool.query('SELECT version,credential_updated_at FROM nodes WHERE id=$1',[node.nodeId]);
    const intents=new NodeUpdateIntentLedger(db.store.pool);
    const prepared=await intents.prepare(node.nodeId,metadata.rows[0].version,
        new Date(metadata.rows[0].credential_updated_at).toISOString(),release);
    const ledger=new NodeRootTrustLedger(db.store.pool);
    const keys=generateKeyPairSync('ed25519');
    const pem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
    return {db,identity,node,intents,prepared,ledger,keys,pem};
}
async function claim(f: Awaited<ReturnType<typeof fixture>>) {
    return f.intents.claim(f.node.nodeId,f.prepared.id,f.node.credential,
        f.prepared.installedVersion,sha);
}
function signed(f:Awaited<ReturnType<typeof fixture>>,nonce:string) {
    const fields={
        nodeId:f.node.nodeId,intentId:f.prepared.id,
        challenge:nonce,activeVersion:'2.0.1+'+commit.slice(0,12),
        targetSha256:sha,observedPid:4242,
    };
    return { schema:1 as const,...fields,signature:sign(null,
        rootUpdateAttestationMessage(fields),f.keys.privateKey).toString('base64') };
}

test('operator pins a single administrator key, issues one live challenge and verifies exactly once without clearing claim',async()=>{
    const f=await fixture();
    await assert.rejects(f.ledger.issue(f.node.nodeId,f.prepared.id),fails('CONFLICT'));
    const fp=fingerprintHostRootKey(f.pem);
    assert.equal(fp.length,64);
    const pinned=await f.ledger.pin(f.node.nodeId,f.pem);
    assert.equal(pinned.fingerprint,fp);
    await assert.rejects(f.ledger.pin(f.node.nodeId,f.pem),fails('CONFLICT'));
    await assert.rejects(f.ledger.issue(f.node.nodeId,f.prepared.id),fails('CONFLICT'),
        'unclaimed request must not receive challenge');
    await claim(f);
    const challenge=await f.ledger.issue(f.node.nodeId,f.prepared.id);
    assert.match(challenge.challenge,/^[a-f0-9]{64}$/);
    assert.equal(Date.parse(challenge.expiresAt)-Date.parse(challenge.issuedAt),5*60_000);
    await assert.rejects(f.ledger.issue(f.node.nodeId,f.prepared.id),fails('CONFLICT'));
    const result=await f.ledger.verify(f.node.nodeId,f.prepared.id,signed(f,challenge.challenge));
    assert.equal(result.clearsClaim,false);
    assert.equal(result.fingerprint,fp);
    assert.equal(result.activeVersion,'2.0.1+'+commit.slice(0,12));
    const state=await f.ledger.status(f.node.nodeId,f.prepared.id);
    assert.equal(state.pinnedFingerprint,fp);
    assert.equal(state.intentStatus,'claimed');
    assert.equal(state.clearsClaim,false);
    assert.ok(state.consumedAt);
    assert.ok(state.verifiedAt);
    const storedProof = await f.db.store.pool.query(
        'SELECT signature,observed_pid,key_fingerprint FROM node_update_root_evidence WHERE intent_id=$1',
        [f.prepared.id]);
    assert.equal(storedProof.rowCount,1);
    assert.equal(storedProof.rows[0].signature.trim(),signed(f,challenge.challenge).signature);
    assert.equal(storedProof.rows[0].key_fingerprint.trim(),fp);
    assert.equal(storedProof.rows[0].observed_pid,4242);
    assert.ok(!JSON.stringify(state).includes(storedProof.rows[0].signature.trim()),
        'operator status must not expose the stored signature');
    assert.ok(!JSON.stringify(state).includes(challenge.challenge),'status must not leak nonce');
    await assert.rejects(f.ledger.verify(f.node.nodeId,f.prepared.id,signed(f,challenge.challenge)),fails('CONFLICT'));
    await assert.rejects(f.intents.prepare(f.node.nodeId,f.prepared.installedVersion,
        new Date((await f.db.store.pool.query('SELECT credential_updated_at FROM nodes WHERE id=$1',
            [f.node.nodeId])).rows[0].credential_updated_at).toISOString(),release),fails('CONFLICT'));
    const dbState=await f.db.store.pool.query('SELECT status FROM node_update_intents WHERE id=$1',[f.prepared.id]);
    assert.equal(dbState.rows[0].status,'claimed');
    const audited=await f.db.store.pool.query(`SELECT operation,after_state FROM audit_events
        WHERE operation IN ('node.root_key_pinned','node.root_challenge_issued',
            'node.root_evidence_verified') ORDER BY created_at,id`);
    assert.equal(audited.rowCount,3);
    for (const row of audited.rows) {
        assert.equal(row.after_state.clearsClaim,false);
        assert.ok(!JSON.stringify(row.after_state).includes(challenge.challenge));
        assert.ok(!JSON.stringify(row.after_state).includes(f.pem));
    }
});

test('cross-node, wrong key, changed target and wrong challenge refuse proof without consuming',async()=>{
    const f=await fixture();
    const other=await fixture();
    await f.ledger.pin(f.node.nodeId,f.pem);
    await claim(f);
    const challenge=await f.ledger.issue(f.node.nodeId,f.prepared.id);
    const correct=signed(f,challenge.challenge);
    await assert.rejects(f.ledger.verify(other.node.nodeId,f.prepared.id,correct),fails('NOT_FOUND'));
    await assert.rejects(f.ledger.verify(f.node.nodeId,f.prepared.id,{
        ...correct,signature:sign(null,rootUpdateAttestationMessage(correct),
            other.keys.privateKey).toString('base64'),
    }),fails('CONFLICT'));
    await assert.rejects(f.ledger.verify(f.node.nodeId,f.prepared.id,{
        ...correct,targetSha256:'e'.repeat(64),
    }),fails('CONFLICT'));
    await assert.rejects(f.ledger.verify(f.node.nodeId,f.prepared.id,{
        ...correct,challenge:'e'.repeat(64),
    }),fails('CONFLICT'));
    await assert.rejects(f.ledger.verify(f.node.nodeId,f.prepared.id,{
        ...correct,activeVersion:'2.0.2+'+commit.slice(0,12),
    }),fails('CONFLICT'));
    assert.equal((await f.ledger.status(f.node.nodeId,f.prepared.id)).consumedAt,null);
    await f.ledger.verify(f.node.nodeId,f.prepared.id,correct);
});

test('expiry, revoked Node and parallel same-proof requests fail closed',async()=>{
    const f=await fixture();
    await f.ledger.pin(f.node.nodeId,f.pem);
    await claim(f);
    const challenge=await f.ledger.issue(f.node.nodeId,f.prepared.id);
    const att=signed(f,challenge.challenge);
    await f.db.store.pool.query(`UPDATE node_update_root_challenges
        SET issued_at=clock_timestamp()-interval '6 minutes',
            expires_at=clock_timestamp()-interval '2 minutes'
        WHERE id=$1`,[challenge.id]);
    await assert.rejects(f.ledger.verify(f.node.nodeId,f.prepared.id,att),fails('CONFLICT'));
    assert.equal((await f.ledger.status(f.node.nodeId,f.prepared.id)).consumedAt,null);
    await assert.rejects(f.ledger.issue(f.node.nodeId,f.prepared.id),fails('CONFLICT'),
        'expired nonce must not be silently regenerated');
    await f.db.store.pool.query(`UPDATE node_update_root_challenges
        SET issued_at=clock_timestamp(), expires_at=clock_timestamp()+interval '4 minutes'
        WHERE id=$1`,[challenge.id]);
    const results=await Promise.allSettled([
        f.ledger.verify(f.node.nodeId,f.prepared.id,att),
        f.ledger.verify(f.node.nodeId,f.prepared.id,att),
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.filter(x=>x.status==='rejected').length,1);
    await f.identity.revoke(f.node.nodeId);
    await assert.rejects(f.ledger.verify(f.node.nodeId,f.prepared.id,att),fails('CONFLICT'));
    const e=(await f.db.store.pool.query('SELECT count(*)::int AS n FROM node_update_root_evidence WHERE intent_id=$1',[f.prepared.id])).rows[0].n;
    assert.equal(e,1);
});

test('invalid/noncanonical public keys and non-Linux Node cannot enrol trust',async()=>{
    const f=await fixture();
    await assert.rejects(f.ledger.pin(f.node.nodeId,'junk'),fails('INVALID_INPUT'));
    const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey
        .export({format:'pem',type:'spki'}).toString();
    await assert.rejects(f.ledger.pin(f.node.nodeId,rsa),fails('INVALID_INPUT'));
    await assert.rejects(f.ledger.pin(f.node.nodeId,f.pem.trim()),fails('INVALID_INPUT'));
    await f.db.store.pool.query("UPDATE nodes SET platform='darwin' WHERE id=$1",[f.node.nodeId]);
    await assert.rejects(f.ledger.pin(f.node.nodeId,f.pem),fails('CONFLICT'));
});

test('explicit expired reissue retains history, invalidates old proof and verifies only the new nonce',async()=>{
    const f=await fixture();
    await f.ledger.pin(f.node.nodeId,f.pem);
    await claim(f);
    const first=await f.ledger.issue(f.node.nodeId,f.prepared.id);
    const stale=signed(f,first.challenge);
    await assert.rejects(f.ledger.reissueExpired(f.node.nodeId,f.prepared.id),fails('CONFLICT'),
        'live challenge must never be replaceable');
    await f.db.store.pool.query(`UPDATE node_update_root_challenges
        SET issued_at=clock_timestamp()-interval '6 minutes',
            expires_at=clock_timestamp()-interval '2 minutes'
        WHERE id=$1`,[first.id]);
    await assert.rejects(f.ledger.verify(f.node.nodeId,f.prepared.id,stale),fails('CONFLICT'));
    const next=await f.ledger.reissueExpired(f.node.nodeId,f.prepared.id);
    assert.notEqual(next.id,first.id);
    assert.notEqual(next.challenge,first.challenge);
    assert.equal(Date.parse(next.expiresAt)-Date.parse(next.issuedAt),300_000);
    const history=await f.db.store.pool.query(`SELECT id,nonce,invalidated_at,consumed_at
        FROM node_update_root_challenges WHERE intent_id=$1 ORDER BY issued_at`,[f.prepared.id]);
    assert.equal(history.rowCount,2);
    assert.equal(history.rows[0].nonce.trim(),first.challenge);
    assert.ok(history.rows[0].invalidated_at,'retired challenge retained');
    assert.equal(history.rows[0].consumed_at,null);
    assert.equal(history.rows[1].id,next.id);
    assert.equal(history.rows[1].invalidated_at,null);
    assert.equal(history.rows[1].consumed_at,null);
    const status=await f.ledger.status(f.node.nodeId,f.prepared.id);
    assert.equal(status.intentStatus,'claimed');
    assert.equal(status.clearsClaim,false);
    assert.equal(status.challengeId,next.id);
    assert.equal(status.challengeAttempts,2);
    assert.equal(status.invalidatedAt,null);
    assert.ok(!JSON.stringify(status).includes(first.challenge));
    assert.ok(!JSON.stringify(status).includes(next.challenge));
    await assert.rejects(f.ledger.verify(f.node.nodeId,f.prepared.id,stale),fails('CONFLICT'),
        'retired signature must never verify even with a correct pinned key');
    await assert.rejects(f.ledger.issue(f.node.nodeId,f.prepared.id),fails('CONFLICT'),
        'normal issuance must not silently replace historical attempts');
    await assert.rejects(f.ledger.reissueExpired(f.node.nodeId,f.prepared.id),fails('CONFLICT'),
        'fresh reissued nonce must not be replaced');
    const verified=await f.ledger.verify(f.node.nodeId,f.prepared.id,signed(f,next.challenge));
    assert.equal(verified.clearsClaim,false);
    await assert.rejects(f.ledger.reissueExpired(f.node.nodeId,f.prepared.id),fails('CONFLICT'),
        'consumed challenge with verified evidence can never be reissued');
    const audit=await f.db.store.pool.query(`SELECT after_state FROM audit_events
        WHERE operation='node.root_challenge_reissued'`);
    assert.equal(audit.rowCount,1);
    assert.equal(audit.rows[0].after_state.supersededChallengeId,first.id);
    assert.equal(audit.rows[0].after_state.challengeId,next.id);
    assert.equal(audit.rows[0].after_state.clearsClaim,false);
    assert.ok(!JSON.stringify(audit.rows[0].after_state).includes(next.challenge));
    const intent=(await f.db.store.pool.query('SELECT status FROM node_update_intents WHERE id=$1',
        [f.prepared.id])).rows[0];
    assert.equal(intent.status,'claimed');
});

test('parallel reissues retire a nonce only once; failed attempts preserve the active challenge',async()=>{
    const f=await fixture();
    const other=await fixture();
    await f.ledger.pin(f.node.nodeId,f.pem);
    await claim(f);
    const first=await f.ledger.issue(f.node.nodeId,f.prepared.id);
    await assert.rejects(f.ledger.reissueExpired(other.node.nodeId,f.prepared.id),fails('NOT_FOUND'));
    await assert.rejects(f.ledger.reissueExpired(f.node.nodeId,other.prepared.id),fails('NOT_FOUND'));
    await f.db.store.pool.query(`UPDATE node_update_root_challenges
        SET issued_at=clock_timestamp()-interval '6 minutes',
            expires_at=clock_timestamp()-interval '2 minutes'
        WHERE id=$1`,[first.id]);
    const results=await Promise.allSettled([
        f.ledger.reissueExpired(f.node.nodeId,f.prepared.id),
        f.ledger.reissueExpired(f.node.nodeId,f.prepared.id),
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.filter(x=>x.status==='rejected').length,1);
    const fresh=(results.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<typeof f.ledger.reissueExpired>>>).value;
    const rows=await f.db.store.pool.query(`SELECT id,nonce,invalidated_at,consumed_at FROM
        node_update_root_challenges WHERE intent_id=$1`,[f.prepared.id]);
    assert.equal(rows.rowCount,2);
    assert.equal(rows.rows.filter(x=>x.invalidated_at !== null).length,1);
    assert.equal(rows.rows.filter(x=>x.invalidated_at === null && x.consumed_at === null).length,1);
    assert.equal(rows.rows.find(x=>x.invalidated_at === null).nonce.trim(),fresh.challenge);
    // The only live nonce remains valid even after a competing failed reissue.
    await f.ledger.verify(f.node.nodeId,f.prepared.id,signed(f,fresh.challenge));
    await f.identity.revoke(f.node.nodeId);
    await assert.rejects(f.ledger.reissueExpired(f.node.nodeId,f.prepared.id),fails('CONFLICT'));
});

test('reissuing cannot turn an unclaimed, missing-key or non-Linux intent into verified evidence',async()=>{
    const f=await fixture();
    await assert.rejects(f.ledger.reissueExpired(f.node.nodeId,f.prepared.id),fails('CONFLICT'));
    await claim(f);
    await assert.rejects(f.ledger.reissueExpired(f.node.nodeId,f.prepared.id),fails('CONFLICT'));
    await f.ledger.pin(f.node.nodeId,f.pem);
    const first=await f.ledger.issue(f.node.nodeId,f.prepared.id);
    await f.db.store.pool.query(`UPDATE node_update_root_challenges
        SET issued_at=clock_timestamp()-interval '6 minutes',
            expires_at=clock_timestamp()-interval '2 minutes'
        WHERE id=$1`,[first.id]);
    await f.db.store.pool.query("UPDATE nodes SET platform='darwin' WHERE id=$1",[f.node.nodeId]);
    await assert.rejects(f.ledger.reissueExpired(f.node.nodeId,f.prepared.id),fails('CONFLICT'));
    const status=await f.ledger.status(f.node.nodeId,f.prepared.id);
    assert.equal(status.challengeId,first.id);
    assert.equal(status.invalidatedAt,null);
    assert.equal(status.challengeAttempts,1);
});
