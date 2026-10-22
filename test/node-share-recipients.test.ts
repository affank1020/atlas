import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { databaseFixture, cleanupDatabases } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { composeServer } from '../apps/server/src/server/composition.js';
import { createHttpTransport } from '../apps/server/src/api/http/index.js';
import { loadServerConfig } from '../apps/server/src/server/config.js';

after(cleanupDatabases);
const reply = (ws: WebSocket) => once(ws, 'message').then(([bytes]) => JSON.parse(String(bytes)) as any);

test('authenticated recipient directory only shows sender-approved and active peers', async () => {
    const f = await databaseFixture();
    const identity = new NodeIdentity(f.store.pool);
    const names = ['Sender','Approved Mac','Private Node','Revoked Mac'];
    const enrolled = await Promise.all(names.map(async (name, i) => {
        const ticket = await identity.ticket();
        return identity.enrol({ token: ticket.enrolmentToken, name, platform: i === 0 ? 'android' : 'darwin' });
    }));
    const [sender, mac, privateNode, revoked] = enrolled;
    const config = loadServerConfig({
        DATABASE_URL:f.databaseUrl, ATLAS_NODE_EXECUTION:'remote', ATLAS_HOST:'127.0.0.1',
        ATLAS_DEVICE_SHARE_PAIRS: sender!.nodeId + ':' + revoked!.nodeId,
    });
    const services = composeServer(config);
    const http = createHttpTransport(services);
    http.listen(0,'127.0.0.1'); await once(http,'listening');
    const url = 'ws://127.0.0.1:' + (http.address() as AddressInfo).port + '/node/connect';
    const opened: WebSocket[] = [];
    const connect = async (node: typeof sender, caps: string[]) => {
        const ws = new WebSocket(url,{headers:{Authorization:'Bearer '+node!.credential}});
        opened.push(ws); await once(ws,'open');
        const message = reply(ws);
        ws.send(JSON.stringify({type:'register',protocol:2,nodeId:node!.nodeId,
            name:names[enrolled.indexOf(node)]!,platform:'test',capabilities:caps}));
        assert.equal((await message).type,'registered');
        return ws;
    };
    const lookup = async (ws: WebSocket) => {
        const pending = reply(ws), requestId = randomUUID();
        ws.send(JSON.stringify({type:'device.share.recipients',requestId}));
        const response = await pending;
        assert.equal(response.requestId,requestId);
        return response;
    };
    try {
        const source = await connect(sender!,['device.share.send']);
        await connect(mac!,['device.share.receive']);
        const other = await connect(privateNode!,['device.share.send']);
        await services.shareApprovals.update({
            sourceNodeId:sender!.nodeId,targetNodeId:mac!.nodeId,enabled:true });
        const first = await lookup(source);
        assert.equal(first.ok,true,JSON.stringify(first));
        assert.deepEqual(first.result.recipients.map((x:any)=>x.nodeId).sort(),
            [mac!.nodeId,revoked!.nodeId].sort(), 'No full Node registry or unapproved peers leak');
        assert.deepEqual(first.result.recipients.find((x:any)=>x.nodeId===mac!.nodeId),
            {nodeId:mac!.nodeId,name:'Approved Mac',platform:'test',status:'online',available:true});
        assert.deepEqual(first.result.recipients.find((x:any)=>x.nodeId===revoked!.nodeId),
            {nodeId:revoked!.nodeId,name:'Revoked Mac',platform:'darwin',status:'offline',available:false});
        assert.deepEqual((await lookup(other)).result,{recipients:[]},
            'Unapproved registered senders cannot discover any other Node');
        const throttled = await lookup(source);
        assert.equal(throttled.ok,false);
        assert.equal(throttled.error.code,'SHARE_RATE_LIMIT');
        await services.shareApprovals.update({
            sourceNodeId:sender!.nodeId,targetNodeId:mac!.nodeId,enabled:false });
        await identity.revoke(revoked!.nodeId);
        await new Promise(resolve=>setTimeout(resolve,2100));
        assert.deepEqual((await lookup(source)).result,{recipients:[]},
            'Revoked managed grants and inactive legacy receivers cannot appear');
        const withoutCapability = await connect(sender!,[]);
        const blocked = await lookup(withoutCapability);
        assert.equal(blocked.ok,false);
        assert.equal(blocked.error.code,'SHARE_DENIED');
    } finally {
        for (const ws of opened) ws.terminate();
        await new Promise<void>(resolve=>http.close(()=>resolve()));
        await services.lifecycle.close();
    }
});
