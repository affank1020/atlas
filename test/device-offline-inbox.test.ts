import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { databaseFixture, cleanupDatabases } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { NodeShareApprovals } from '../apps/server/src/nodes/share-approvals.js';
import { DeviceOfflineInbox } from '../apps/server/src/nodes/offline-inbox.js';

after(cleanupDatabases);

async function enroll(identity: NodeIdentity, name: string) {
    const ticket = await identity.ticket();
    return identity.enrol({ token: ticket.enrolmentToken, name, platform: 'test' });
}
async function allowReceiving(pool: Pool, nodeId: string) {
    await pool.query("UPDATE nodes SET capabilities=ARRAY['device.share.receive']::text[] WHERE id=$1", [nodeId]);
}
function inboxUsing(pool: Pool, approval: NodeShareApprovals) {
    return new DeviceOfflineInbox(pool, randomBytes(32),
        (source, target, client) => approval.allowedForInbox(source,target,client));
}

test('enqueue does not deadlock by acquiring another pooled connection inside its transaction', async () => {
    const fixture = await databaseFixture();
    const identity = new NodeIdentity(fixture.store.pool);
    const source = await enroll(identity, 'Sender');
    const receiver = await enroll(identity, 'Receiver');
    await allowReceiving(fixture.store.pool, receiver.nodeId);
    await new NodeShareApprovals(fixture.store.pool)
        .update({sourceNodeId:source.nodeId,targetNodeId:receiver.nodeId,enabled:true});

    // A single-slot pool reproduces the SEV2: querying this pool while the
    // transaction owns its sole client would hang until connection timeout.
    const pool = new Pool({connectionString:fixture.databaseUrl,max:1,
        connectionTimeoutMillis:1_000,statement_timeout:2_000});
    try {
        const approval = new NodeShareApprovals(pool);
        const inbox = inboxUsing(pool,approval);
        const deliveryId = randomUUID();
        assert.deepEqual(await inbox.enqueue({
            sourceId:source.nodeId,targetId:receiver.nodeId,deliveryId,text:'One connection',
        }),{deliveryId,status:'queued',queued:true});
        assert.equal((await inbox.list(receiver.nodeId)).length,1);
        assert.equal((await inbox.read(receiver.nodeId,deliveryId)).text,'One connection');
    } finally { await pool.end(); }
});

test('concurrent independent pairs complete with all pool slots occupied', async () => {
    const fixture = await databaseFixture();
    const identity = new NodeIdentity(fixture.store.pool);
    const pairs = [];
    const grants = new NodeShareApprovals(fixture.store.pool);
    for (let i=0;i<2;i++) {
        const from = await enroll(identity,'Sender '+i);
        const to = await enroll(identity,'Receiver '+i);
        await allowReceiving(fixture.store.pool,to.nodeId);
        await grants.update({sourceNodeId:from.nodeId,targetNodeId:to.nodeId,enabled:true});
        pairs.push({sourceId:from.nodeId,targetId:to.nodeId,deliveryId:randomUUID(),text:'Note '+i});
    }
    const pool = new Pool({connectionString:fixture.databaseUrl,max:2,
        connectionTimeoutMillis:1_000,statement_timeout:2_000});
    try {
        const inbox = inboxUsing(pool,new NodeShareApprovals(pool));
        const results=await Promise.all(pairs.map(item=>inbox.enqueue(item)));
        assert.deepEqual(results.map(r=>r.status),['queued','queued']);
        for(const pair of pairs) assert.equal((await inbox.read(pair.targetId,pair.deliveryId)).text,pair.text);
    } finally { await pool.end(); }
});

test('environment grant cannot resurrect queued messages after sender credential rotation or revocation', async () => {
    const fixture = await databaseFixture();
    const identity = new NodeIdentity(fixture.store.pool);
    const source = await enroll(identity,'Sender');
    const target = await enroll(identity,'Receiver');
    await allowReceiving(fixture.store.pool,target.nodeId);
    const grant = new NodeShareApprovals(fixture.store.pool,
        new Set([source.nodeId+':'+target.nodeId]));
    const inbox = inboxUsing(fixture.store.pool,grant);
    const before = randomUUID();
    await inbox.enqueue({sourceId:source.nodeId,targetId:target.nodeId,deliveryId:before,text:'Old secret'});
    assert.equal((await inbox.list(target.nodeId)).length,1);

    const rotation = await identity.ticket(source.nodeId,true);
    assert.equal(await grant.allowed(source.nodeId,target.nodeId),true,
        'environment grants persist independently of Node credentials');
    assert.deepEqual(await inbox.list(target.nodeId),[]);
    await assert.rejects(inbox.read(target.nodeId,before),
        (error:any)=>error.code==='NOT_FOUND');

    await identity.enrol({token:rotation.enrolmentToken,name:'Sender',platform:'test'});
    assert.deepEqual(await inbox.list(target.nodeId),[],
        're-enrolment must not make messages from the old credential visible');
    await assert.rejects(inbox.read(target.nodeId,before),(error:any)=>error.code==='NOT_FOUND');

    const after = randomUUID();
    await inbox.enqueue({sourceId:source.nodeId,targetId:target.nodeId,deliveryId:after,text:'Fresh secret'});
    assert.deepEqual((await inbox.list(target.nodeId)).map(i=>i.deliveryId),[after]);
    await identity.revoke(source.nodeId);
    assert.deepEqual(await inbox.list(target.nodeId),[]);
    await assert.rejects(inbox.read(target.nodeId,after),(error:any)=>error.code==='NOT_FOUND');
});

test('managed grant revocation and receiver rotation both invalidate queued plaintext', async () => {
    const fixture=await databaseFixture();
    const identity=new NodeIdentity(fixture.store.pool);
    const source=await enroll(identity,'Sender');
    const target=await enroll(identity,'Receiver');
    await allowReceiving(fixture.store.pool,target.nodeId);
    const grant=new NodeShareApprovals(fixture.store.pool);
    await grant.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:true});
    const inbox=inboxUsing(fixture.store.pool,grant), deliveryId=randomUUID();
    await inbox.enqueue({sourceId:source.nodeId,targetId:target.nodeId,deliveryId,text:'Confidential'});
    await grant.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:false});
    assert.deepEqual(await inbox.list(target.nodeId),[]);
    await assert.rejects(inbox.read(target.nodeId,deliveryId),
        (error:any)=>error.code==='SHARE_DENIED');
    await grant.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:true});
    const rotation=await identity.ticket(target.nodeId,true);
    await identity.enrol({token:rotation.enrolmentToken,name:'Receiver',platform:'test'});
    assert.deepEqual(await inbox.list(target.nodeId),[]);
    await assert.rejects(inbox.read(target.nodeId,deliveryId),
        (error:any)=>error.code==='NOT_FOUND');
});
