import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseFixture, cleanupDatabases } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { NodeShareApprovals } from '../apps/server/src/nodes/share-approvals.js';
import { DeviceShareRelay } from '../apps/server/src/infrastructure/nodes/share-relay.js';

after(cleanupDatabases);

test('directed sharing is denied by default, persisted, revocable and bounded to one peer direction', async () => {
    const f = await databaseFixture();
    const identity = new NodeIdentity(f.store.pool);
    const a = await identity.enrol({token:(await identity.ticket()).enrolmentToken,name:'Android',platform:'android'});
    const b = await identity.enrol({token:(await identity.ticket()).enrolmentToken,name:'Mac',platform:'darwin'});
    const sharing = new NodeShareApprovals(f.store.pool);
    assert.equal(await sharing.allowed(a.nodeId,b.nodeId),false);
    assert.deepEqual(await sharing.list(),[]);
    await assert.rejects(sharing.update({sourceNodeId:a.nodeId,targetNodeId:a.nodeId,enabled:true}),
        (err: any)=>err.code==='SHARE_DENIED');
    await sharing.update({sourceNodeId:a.nodeId,targetNodeId:b.nodeId,enabled:true});
    await sharing.update({sourceNodeId:a.nodeId,targetNodeId:b.nodeId,enabled:true});
    assert.equal((await sharing.list()).length,1);
    assert.equal(await sharing.allowed(a.nodeId.toUpperCase(),b.nodeId.toUpperCase()),true);
    assert.equal(await sharing.allowed(b.nodeId,a.nodeId),false);
    const fresh = new NodeShareApprovals(f.store.pool);
    assert.equal(await fresh.allowed(a.nodeId,b.nodeId),true);

    // New submissions check grants each time, including attempts reusing an
    // already successful delivery UUID after the operator revokes permission.
    const src = {getCapabilities:()=>['device.share.send']};
    let delivered=0;
    const dst = {getCapabilities:()=>['device.share.receive'],
        deliverDeviceShare:async()=>{delivered++;return {accepted:true}}};
    const nodes = {runtimes:new Map([[a.nodeId,src],[b.nodeId,dst]]),
        identity:{authenticate:async()=>true},
        get:async()=>({credentialState:'active',status:'online',capabilities:['device.share.receive']})};
    const relay = new DeviceShareRelay(nodes as any,new Set(),sharing);
    const id = randomUUID();
    const send = () => relay.forward({sourceId:a.nodeId,sourceRuntime:src as any,
        credential:a.credential,submission:{type:'device.share.submit',requestId:randomUUID(),
            deliveryId:id,targetNodeId:b.nodeId,text:'approved'}});
    assert.deepEqual(await send(),{accepted:true});
    assert.equal(delivered,1);
    await sharing.update({sourceNodeId:a.nodeId,targetNodeId:b.nodeId,enabled:false});
    assert.equal(await sharing.allowed(a.nodeId,b.nodeId),false);
    await assert.rejects(send(),(err:any)=>err.code==='SHARE_DENIED');
    assert.equal(delivered,1,'revocation prevents delivery even of an idempotent retry');
    const events=await f.store.pool.query(
        "SELECT operation FROM audit_events WHERE operation LIKE 'node.share.%' ORDER BY created_at,id");
    assert.equal(events.rowCount,3,'two grants and one revoke are audited');
});

test('revoking a Node credential also removes all managed share approvals', async()=>{
    const f=await databaseFixture();
    const identity=new NodeIdentity(f.store.pool);
    const a=await identity.enrol({token:(await identity.ticket()).enrolmentToken,name:'A',platform:'android'});
    const b=await identity.enrol({token:(await identity.ticket()).enrolmentToken,name:'B',platform:'darwin'});
    const sharing=new NodeShareApprovals(f.store.pool);
    await sharing.update({sourceNodeId:a.nodeId,targetNodeId:b.nodeId,enabled:true});
    await identity.revoke(a.nodeId);
    assert.deepEqual(await sharing.list(),[]);
});

test('environment approvals remain read-only and visible, not implicitly revoked by UI', async()=>{
    const f=await databaseFixture();
    const a=randomUUID(),b=randomUUID();
    const shares=new NodeShareApprovals(f.store.pool,new Set([a+':'+b]));
    assert.deepEqual(await shares.list(),[{sourceNodeId:a,targetNodeId:b,origin:'environment'}]);
    assert.equal(await shares.allowed(a,b),true);
    await assert.rejects(shares.update({sourceNodeId:a,targetNodeId:b,enabled:false}),
        (err:any)=>err.code==='SHARE_ENV_MANAGED');
});
