import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { after, test } from 'node:test';
import { cleanupDatabases, databaseFixture } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { NodeUpdateIntentLedger } from '../apps/server/src/nodes/update-intents.js';
import { NodeRootTrustLedger } from '../apps/server/src/nodes/root-trust-ledger.js';
import { NodeUpdateReconciliationLedger } from '../apps/server/src/nodes/root-reconciliation.js';
import { rootUpdateAttestationMessage } from '../apps/server/src/nodes/root-evidence.js';
import type { NodeRelease } from '../apps/server/src/nodes/releases.js';

after(cleanupDatabases);
const commit = 'b'.repeat(40);
const target = '2.0.1+' + commit.slice(0,12);
const sha = 'd'.repeat(64);
const candidate: NodeRelease = {
    component:'desktop-node',platform:'linux',architecture:'any',channel:'stable',
    version:'2.0.1',commit:commit.slice(0,12),sourceCommit:commit,sourceOrder:19,
    protocol:2,minimumNodeJs:20,publishedAt:'2026-10-21T12:00:00Z',notes:'',
    downloadUrl:'https://github.com/affank1020/atlas/releases/download/node-v2.0.1-'
        +commit.slice(0,12)+'/atlas-node.tar.gz',
    checksumUrl:'',releaseUrl:'',sha256:sha,provenance:'unverified',
};
const fails=(code:string)=>(e:any)=>e.code===code;
async function fixture(){
    const db=await databaseFixture();
    const identity=new NodeIdentity(db.store.pool);
    const ticket=await identity.ticket();
    const node=await identity.enrol({token:ticket.enrolmentToken,name:'Linux Test Node',
        platform:'linux',version:'2.0.0+'+'a'.repeat(12)});
    await db.store.pool.query(`UPDATE nodes SET status='online',
        last_seen=clock_timestamp() WHERE id=$1`,[node.nodeId]);
    const info=(await db.store.pool.query(`SELECT version,credential_updated_at
        FROM nodes WHERE id=$1`,[node.nodeId])).rows[0];
    const intents=new NodeUpdateIntentLedger(db.store.pool);
    const prepared=await intents.prepare(node.nodeId,info.version,
        new Date(info.credential_updated_at).toISOString(),candidate);
    const roots=new NodeRootTrustLedger(db.store.pool);
    const reconcile=new NodeUpdateReconciliationLedger(db.store.pool);
    const keys=generateKeyPairSync('ed25519');
    const pem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
    const input={nodeId:node.nodeId,intentId:prepared.id,
        independentlyCheckedVersion:target,independentlyCheckedPid:4242,
        operatorCheckReference:'HOST-DRILL-2026-01'};
    return {db,identity,node,intents,prepared,roots,reconcile,keys,pem,input,credentialAt:info.credential_updated_at};
}
async function evidence(f:Awaited<ReturnType<typeof fixture>>){
    await f.roots.pin(f.node.nodeId,f.pem);
    await f.intents.claim(f.node.nodeId,f.prepared.id,f.node.credential,
        f.prepared.installedVersion,sha);
    const challenge=await f.roots.issue(f.node.nodeId,f.prepared.id);
    const fields={nodeId:f.node.nodeId,intentId:f.prepared.id,challenge:challenge.challenge,
        activeVersion:target,targetSha256:sha,observedPid:4242};
    const attestation={schema:1 as const,...fields,
        signature:sign(null,rootUpdateAttestationMessage(fields),f.keys.privateKey).toString('base64')};
    await f.roots.verify(f.node.nodeId,f.prepared.id,attestation);
    return {challenge,attestation};
}
const setLive=async(f:Awaited<ReturnType<typeof fixture>>)=>{
    await f.db.store.pool.query(`UPDATE nodes SET version=$2,last_seen=clock_timestamp(),
        status='online' WHERE id=$1`,[f.node.nodeId,target]);
};

test('operator reconciliation consumes verified root evidence and closes only the exact claim',async()=>{
    const f=await fixture();
    const proof=await evidence(f);
    await setLive(f);
    const result=await f.reconcile.reconcile(f.input);
    assert.equal(result.status,'reconciled');
    assert.equal(result.operatorAcknowledged,true);
    assert.equal(result.healthIndependentlyMeasuredByAtlas,false);
    assert.equal(result.independentlyCheckedVersion,target);
    assert.equal(result.independentlyCheckedPid,4242);
    assert.equal(result.evidenceChallengeId,proof.challenge.id);
    assert.equal((await f.intents.list(f.node.nodeId))[0]?.status,'reconciled');
    const saved=await f.db.store.pool.query(`SELECT i.status,i.resolved_at,r.operator_check_reference,
        r.evidence_challenge_id FROM node_update_intents i
        JOIN node_update_reconciliations r ON r.intent_id=i.id WHERE i.id=$1`,[f.prepared.id]);
    assert.equal(saved.rows[0].status,'reconciled');
    assert.equal(saved.rows[0].operator_check_reference,f.input.operatorCheckReference);
    assert.equal(saved.rows[0].evidence_challenge_id,proof.challenge.id);
    assert.ok(saved.rows[0].resolved_at);
    await assert.rejects(f.reconcile.reconcile(f.input),fails('CONFLICT'),
        'operator close-out cannot be repeated or silently modified');
    const old=(await f.intents.list(f.node.nodeId)).find(x=>x.id===f.prepared.id);
    assert.equal(old?.approved,false);
    assert.equal(old?.executable,false);
    const newRequest=await f.intents.prepare(f.node.nodeId,target,
        new Date(f.credentialAt).toISOString(),candidate);
    assert.notEqual(newRequest.id,f.prepared.id);
    assert.equal(newRequest.status,'requested');
    const audits=await f.db.store.pool.query(`SELECT client,after_state FROM audit_events
        WHERE operation='node.update_operator_reconciled'`);
    assert.equal(audits.rowCount,1);
    assert.equal(audits.rows[0].client,'atlas-node-root-operator');
    assert.equal(audits.rows[0].after_state.operatorAcknowledged,true);
    assert.equal(audits.rows[0].after_state.healthIndependentlyMeasuredByAtlas,false);
    assert.equal(audits.rows[0].after_state.executable,false);
    assert.ok(!JSON.stringify(audits.rows[0]).includes(proof.challenge.challenge));
    assert.ok(!JSON.stringify(audits.rows[0]).includes(proof.attestation.signature));
});

test('no root evidence or stale Node/host state leaves claim locked',async()=>{
    const f=await fixture();
    await f.intents.claim(f.node.nodeId,f.prepared.id,f.node.credential,
        f.prepared.installedVersion,sha);
    await setLive(f);
    await assert.rejects(f.reconcile.reconcile(f.input),fails('CONFLICT'));
    await f.roots.pin(f.node.nodeId,f.pem);
    const challenge=await f.roots.issue(f.node.nodeId,f.prepared.id);
    await assert.rejects(f.reconcile.reconcile(f.input),fails('CONFLICT'),
        'issued but unconsumed challenge is not root evidence');
    const fields={nodeId:f.node.nodeId,intentId:f.prepared.id,challenge:challenge.challenge,
        activeVersion:target,targetSha256:sha,observedPid:4242};
    await f.roots.verify(f.node.nodeId,f.prepared.id,{schema:1,...fields,
        signature:sign(null,rootUpdateAttestationMessage(fields),f.keys.privateKey).toString('base64')});
    await f.db.store.pool.query(`UPDATE nodes SET last_seen=clock_timestamp()-interval '5 minutes'
        WHERE id=$1`,[f.node.nodeId]);
    await assert.rejects(f.reconcile.reconcile(f.input),fails('CONFLICT'),'stale heartbeat');
    await f.db.store.pool.query(`UPDATE nodes SET status='offline',last_seen=clock_timestamp()
        WHERE id=$1`,[f.node.nodeId]);
    await assert.rejects(f.reconcile.reconcile(f.input),fails('CONFLICT'),'offline Node');
    await f.db.store.pool.query(`UPDATE nodes SET status='online',version='2.0.0+aaaaaaaaaaaa'
        WHERE id=$1`,[f.node.nodeId]);
    await assert.rejects(f.reconcile.reconcile(f.input),fails('CONFLICT'),'reported target mismatch');
    await setLive(f);
    await assert.rejects(f.reconcile.reconcile({...f.input,independentlyCheckedPid:4243}),
        fails('CONFLICT'),'independent PID differs from signed evidence');
    await assert.rejects(f.reconcile.reconcile({...f.input,independentlyCheckedVersion:
        '2.0.2+'+'b'.repeat(12)}),fails('CONFLICT'),'independent version differs from signed evidence');
    const still=await f.db.store.pool.query(`SELECT status FROM node_update_intents WHERE id=$1`,[f.prepared.id]);
    assert.equal(still.rows[0].status,'claimed');
    assert.equal((await f.db.store.pool.query(`SELECT count(*)::int n FROM node_update_reconciliations
        WHERE intent_id=$1`,[f.prepared.id])).rows[0].n,0);
    await assert.rejects(f.intents.prepare(f.node.nodeId,target,
        new Date(f.credentialAt).toISOString(),candidate),fails('CONFLICT'));
});

test('tampering, expired root proof and credential rotation fail closed',async()=>{
    const f=await fixture();
    const proof=await evidence(f);
    await setLive(f);
    await f.db.store.pool.query(`UPDATE node_update_root_evidence
        SET verified_at=clock_timestamp()-interval '6 minutes'
        WHERE intent_id=$1`,[f.prepared.id]);
    await assert.rejects(f.reconcile.reconcile(f.input),fails('CONFLICT'),'root signature too old');
    await f.db.store.pool.query(`UPDATE node_update_root_evidence SET verified_at=clock_timestamp()
        WHERE intent_id=$1`,[f.prepared.id]);
    await f.db.store.pool.query(`UPDATE node_update_root_evidence SET signature=$2 WHERE intent_id=$1`,
        [f.prepared.id,'A'.repeat(86)+'==']);
    await assert.rejects(f.reconcile.reconcile(f.input),fails('CONFLICT'),'tampered proof');
    await f.db.store.pool.query(`UPDATE node_update_root_evidence SET signature=$2 WHERE intent_id=$1`,
        [f.prepared.id,proof.attestation.signature]);
    await f.db.store.pool.query(`UPDATE node_update_root_challenges SET invalidated_at=clock_timestamp(),
        consumed_at=NULL WHERE id=$1`,[proof.challenge.id]);
    await assert.rejects(f.reconcile.reconcile(f.input),fails('CONFLICT'),'retired challenge');
    await f.db.store.pool.query(`UPDATE node_update_root_challenges SET invalidated_at=NULL,
        consumed_at=clock_timestamp() WHERE id=$1`,[proof.challenge.id]);
    await f.db.store.pool.query(`UPDATE nodes SET credential_updated_at=clock_timestamp()
        WHERE id=$1`,[f.node.nodeId]);
    await assert.rejects(f.reconcile.reconcile(f.input),fails('CONFLICT'),
        'credential generation changed after update was prepared');
    await f.identity.revoke(f.node.nodeId);
    await assert.rejects(f.reconcile.reconcile(f.input),fails('CONFLICT'),'revoked Node');
    assert.equal((await f.intents.list(f.node.nodeId))[0]?.status,'claimed');
});

test('cross Node, invalid operator assertion and parallel close-out cannot bypass checks',async()=>{
    const f=await fixture();
    const other=await fixture();
    await evidence(f);await setLive(f);
    await assert.rejects(f.reconcile.reconcile({...f.input,nodeId:other.node.nodeId}),
        fails('NOT_FOUND'));
    await assert.rejects(f.reconcile.reconcile({...f.input,operatorCheckReference:'x'}),
        fails('INVALID_INPUT'));
    await assert.rejects(f.reconcile.reconcile({...f.input,independentlyCheckedPid:1}),
        fails('INVALID_INPUT'));
    await assert.rejects(f.reconcile.reconcile({...f.input,independentlyCheckedVersion:'bad'}),
        fails('INVALID_INPUT'));
    const results=await Promise.allSettled([
        f.reconcile.reconcile(f.input),f.reconcile.reconcile(f.input),
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.filter(x=>x.status==='rejected').length,1);
    const db=await f.db.store.pool.query(`SELECT count(*)::int n FROM node_update_reconciliations
        WHERE intent_id=$1`,[f.prepared.id]);
    assert.equal(db.rows[0].n,1);
    const audits=await f.db.store.pool.query(`SELECT count(*)::int n FROM audit_events
        WHERE operation='node.update_operator_reconciled'`);
    assert.equal(audits.rows[0].n,1);
});
