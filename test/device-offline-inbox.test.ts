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
    return new DeviceOfflineInbox(pool, randomBytes(32), approval);
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
        (error:any)=>error.code==='NOT_FOUND',
        'atomic revocation erases the queued payload before returning');
    await grant.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:true});
    const rotation=await identity.ticket(target.nodeId,true);
    await identity.enrol({token:rotation.enrolmentToken,name:'Receiver',platform:'test'});
    assert.deepEqual(await inbox.list(target.nodeId),[]);
    await assert.rejects(inbox.read(target.nodeId,deliveryId),
        (error:any)=>error.code==='NOT_FOUND');
});


test('revoking a sender with 50 queued items releases the target quota and clears ciphertext', async () => {
    const fixture = await databaseFixture();
    const identity = new NodeIdentity(fixture.store.pool);
    const source = await enroll(identity, 'Old Sender');
    const target = await enroll(identity, 'Target');
    const fresh = await enroll(identity, 'Fresh Sender');
    await allowReceiving(fixture.store.pool, target.nodeId);
    const grants = new NodeShareApprovals(fixture.store.pool);
    await grants.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:true});
    await grants.update({sourceNodeId:fresh.nodeId,targetNodeId:target.nodeId,enabled:true});
    const inbox = inboxUsing(fixture.store.pool,grants);
    const ids: string[] = [];
    for(let n=0;n<50;n++) {
        const deliveryId=randomUUID();
        ids.push(deliveryId);
        await inbox.enqueue({sourceId:source.nodeId,targetId:target.nodeId,
            deliveryId,text:'Item '+n});
    }
    assert.equal((await inbox.list(target.nodeId)).length,50);
    await identity.revoke(source.nodeId);
    assert.deepEqual(await inbox.list(target.nodeId),[],
        'revoked source must not appear in recipient inbox');
    const freshId=randomUUID();
    assert.deepEqual(await inbox.enqueue({sourceId:fresh.nodeId,targetId:target.nodeId,
        deliveryId:freshId,text:'New authorised item'}),{
        deliveryId:freshId,status:'queued',queued:true,
    });
    assert.deepEqual((await inbox.list(target.nodeId)).map(item=>item.deliveryId),[freshId]);
    const retired=await fixture.store.pool.query(`
        SELECT state,payload_ciphertext,payload_nonce,payload_tag
        FROM device_inbox WHERE source_node_id=$1 ORDER BY id
    `,[source.nodeId]);
    assert.equal(retired.rowCount,50);
    for(const row of retired.rows) {
        assert.equal(row.state,'expired');
        assert.equal(row.payload_ciphertext,null);
        assert.equal(row.payload_nonce,null);
        assert.equal(row.payload_tag,null);
    }
    assert.equal(ids.length,50);
});

test('withdrawing a managed grant releases hidden quota without retiring other approved senders', async () => {
    const fixture=await databaseFixture();
    const identity=new NodeIdentity(fixture.store.pool);
    const source=await enroll(identity,'Old Sender');
    const target=await enroll(identity,'Target');
    const other=await enroll(identity,'Other Sender');
    await allowReceiving(fixture.store.pool,target.nodeId);
    const grants=new NodeShareApprovals(fixture.store.pool);
    await grants.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:true});
    await grants.update({sourceNodeId:other.nodeId,targetNodeId:target.nodeId,enabled:true});
    const inbox=inboxUsing(fixture.store.pool,grants);
    for(let n=0;n<49;n++) {
        await inbox.enqueue({sourceId:source.nodeId,targetId:target.nodeId,
            deliveryId:randomUUID(),text:'Before revoke '+n});
    }
    const stillValid=randomUUID();
    await inbox.enqueue({sourceId:other.nodeId,targetId:target.nodeId,
        deliveryId:stillValid,text:'Still approved'});
    await grants.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:false});
    const after=randomUUID();
    assert.equal((await inbox.enqueue({sourceId:other.nodeId,targetId:target.nodeId,
        deliveryId:after,text:'Fresh'})).status,'queued');
    const visible=(await inbox.list(target.nodeId)).map(x=>x.deliveryId);
    assert.deepEqual(visible.sort(),[stillValid,after].sort());
    const old=await fixture.store.pool.query(
        "SELECT count(*)::int AS total FROM device_inbox WHERE source_node_id=$1 AND state='queued'",
        [source.nodeId]);
    assert.equal(old.rows[0].total,0);
});

test('idempotent retry after receiver rotation is terminal, never a false queued success', async () => {
    const fixture=await databaseFixture();
    const identity=new NodeIdentity(fixture.store.pool);
    const source=await enroll(identity,'Sender');
    const target=await enroll(identity,'Target');
    await allowReceiving(fixture.store.pool,target.nodeId);
    const grants=new NodeShareApprovals(fixture.store.pool);
    await grants.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:true});
    const inbox=inboxUsing(fixture.store.pool,grants);
    const deliveryId=randomUUID();
    const input={sourceId:source.nodeId,targetId:target.nodeId,deliveryId,text:'Original'};
    assert.deepEqual(await inbox.enqueue(input),{deliveryId,status:'queued',queued:true});
    assert.deepEqual(await inbox.enqueue(input),{deliveryId,status:'queued',queued:false},
        'unchanged active generation returns the real queued status');
    const ticket=await identity.ticket(target.nodeId,true);
    await identity.enrol({token:ticket.enrolmentToken,name:'Target',platform:'test'});
    assert.deepEqual(await inbox.enqueue(input),{deliveryId,status:'expired',queued:false},
        'same delivery ID is a tombstone after credential replacement');
    assert.deepEqual(await inbox.list(target.nodeId),[]);
    const row=await fixture.store.pool.query(
        'SELECT state,payload_ciphertext FROM device_inbox WHERE id=$1',[deliveryId]);
    assert.equal(row.rows[0].state,'expired');
    assert.equal(row.rows[0].payload_ciphertext,null);
    const nextId=randomUUID();
    assert.equal((await inbox.enqueue({...input,deliveryId:nextId})).status,'queued');
});

test('idempotent retry after sender credential replacement cannot resurrect old plaintext', async () => {
    const fixture=await databaseFixture();
    const identity=new NodeIdentity(fixture.store.pool);
    const source=await enroll(identity,'Sender');
    const target=await enroll(identity,'Receiver');
    await allowReceiving(fixture.store.pool,target.nodeId);
    const grants=new NodeShareApprovals(fixture.store.pool,
        new Set([source.nodeId+':'+target.nodeId]));
    const inbox=inboxUsing(fixture.store.pool,grants);
    const deliveryId=randomUUID();
    const input={sourceId:source.nodeId,targetId:target.nodeId,deliveryId,text:'Before rotation'};
    await inbox.enqueue(input);
    const ticket=await identity.ticket(source.nodeId,true);
    await identity.enrol({token:ticket.enrolmentToken,name:'Sender',platform:'test'});
    assert.deepEqual(await inbox.enqueue(input),{deliveryId,status:'expired',queued:false});
    assert.deepEqual(await inbox.list(target.nodeId),[]);
});


test('managed grant revocation destroys queued content before reapproval, without another enqueue', async () => {
    const fixture=await databaseFixture();
    const identity=new NodeIdentity(fixture.store.pool);
    const source=await enroll(identity,'Sender');
    const target=await enroll(identity,'Receiver');
    await allowReceiving(fixture.store.pool,target.nodeId);
    const approvals=new NodeShareApprovals(fixture.store.pool);
    await approvals.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:true});
    const inbox=inboxUsing(fixture.store.pool,approvals);
    const deliveryId=randomUUID();
    const input={sourceId:source.nodeId,targetId:target.nodeId,
        deliveryId,text:'Must never resurrect'};
    await inbox.enqueue(input);
    assert.equal((await inbox.read(target.nodeId,deliveryId)).text,input.text);

    await approvals.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:false});
    const retired=await fixture.store.pool.query(`
        SELECT state,payload_ciphertext,payload_nonce,payload_tag,decided_at
        FROM device_inbox WHERE id=$1
    `,[deliveryId]);
    assert.equal(retired.rows[0].state,'expired');
    assert.equal(retired.rows[0].payload_ciphertext,null);
    assert.equal(retired.rows[0].payload_nonce,null);
    assert.equal(retired.rows[0].payload_tag,null);
    assert.ok(retired.rows[0].decided_at);

    await approvals.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:true});
    assert.deepEqual(await inbox.list(target.nodeId),[],
        'regrant must not expose revoked content before any new enqueue');
    await assert.rejects(inbox.read(target.nodeId,deliveryId),
        (error:any)=>error.code==='NOT_FOUND');
    assert.deepEqual(await inbox.enqueue(input),{deliveryId,status:'expired',queued:false},
        'same delivery ID must remain a terminal tombstone after reapproval');
    const newId=randomUUID();
    assert.equal((await inbox.enqueue({...input,deliveryId:newId})).status,'queued',
        'only fresh IDs can send content after reapproval');
});

test('disabling a managed grant erases pending data despite a valid environment overlay', async () => {
    const fixture=await databaseFixture();
    const identity=new NodeIdentity(fixture.store.pool);
    const source=await enroll(identity,'Sender');
    const target=await enroll(identity,'Receiver');
    await allowReceiving(fixture.store.pool,target.nodeId);
    const managed=new NodeShareApprovals(fixture.store.pool);
    await managed.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:true});
    const overlay=new NodeShareApprovals(fixture.store.pool,
        new Set([source.nodeId+':'+target.nodeId]));
    const inbox=inboxUsing(fixture.store.pool,overlay);
    const oldId=randomUUID();
    await inbox.enqueue({sourceId:source.nodeId,targetId:target.nodeId,
        deliveryId:oldId,text:'Queued while both grants exist'});
    await overlay.update({sourceNodeId:source.nodeId,targetNodeId:target.nodeId,enabled:false});
    assert.equal(await overlay.allowedForInbox(source.nodeId,target.nodeId),true,
        'environment grant still permits future sends');
    assert.deepEqual(await inbox.list(target.nodeId),[],
        'explicit managed revoke erases earlier queue despite environment overlay');
    await assert.rejects(inbox.read(target.nodeId,oldId),(error:any)=>error.code==='NOT_FOUND');
    const row=await fixture.store.pool.query(
        'SELECT state,payload_ciphertext FROM device_inbox WHERE id=$1',[oldId]);
    assert.deepEqual({state:row.rows[0].state,ciphertext:row.rows[0].payload_ciphertext},
        {state:'expired',ciphertext:null});
    const nextId=randomUUID();
    assert.equal((await inbox.enqueue({sourceId:source.nodeId,targetId:target.nodeId,
        deliveryId:nextId,text:'New item'})).status,'queued');
});
