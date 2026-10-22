import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { serveNodeUpdateReport } from '../apps/server/src/api/http/node-update-report.js';

const nodeId = 'ff20f4df-0b6b-4e4a-8ac4-8b2485af3c37';
const intentId = 'ad42bf7f-a74f-4ccb-a09b-a47719869f63';
const token = 'a'.repeat(43);
const digest = 'b'.repeat(64);
const data = { intentId, targetSha256: digest, reportedState: 'activated' };

async function fixture(disabled = false) {
    const called: string[] = [];
    const services = {
        config: { nodeUpdateClaims: { enabled: !disabled } },
        identity: { authenticate: async (node: string, key: string) => {
            called.push('auth');
            assert.equal(node,nodeId); assert.equal(key,token);
        }},
        nodes: { updateIntents: { report: async (...args: unknown[]) => {
            called.push('report');
            assert.deepEqual(args,[nodeId,intentId,token,digest,'activated']);
            return { intentId,nodeId,reportedState:'activated',
                reportedAt:'2026-10-22T12:00:00.000Z',verified:false,clearsClaim:false };
        } }},
    };
    const server = createServer((request,response) => { void serveNodeUpdateReport(request,response,
        services as unknown as Parameters<typeof serveNodeUpdateReport>[2]).then(handled => {
        if (!handled) { response.writeHead(404); response.end(); }
    }); });
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing port');
    const url = `http://127.0.0.1:${address.port}/node/update-intents/report`;
    const headers = { authorization:'Bearer '+token,'x-atlas-node-id':nodeId,'content-type':'application/json' };
    const close=()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    return {url,headers,called,close};
}

test('Node outcome reporting is unverified and never claims execution authority',async t=>{
    const f=await fixture(); t.after(f.close);
    const res=await fetch(f.url,{method:'POST',headers:f.headers,body:JSON.stringify(data)});
    assert.equal(res.status,200);
    const body=await res.json() as any;
    assert.equal(body.report.reportedState,'activated');
    assert.equal(body.report.verified,false);
    assert.equal(body.report.clearsClaim,false);
    assert.equal(res.headers.get('cache-control'),'no-store');
    assert.deepEqual(f.called,['auth','report']);
});

test('Node outcome reporting rejects browser Origins, invalid tokens and methods',async t=>{
    const f=await fixture(); t.after(f.close);
    for(const entry of [
        {method:'GET',headers:f.headers,status:405},
        {method:'POST',headers:{...f.headers,origin:'https://atlas.example.com'},status:403},
        {method:'POST',headers:{...f.headers,authorization:'Bearer too-short'},status:401},
        {method:'POST',headers:{...f.headers,'x-atlas-node-id':'wrong'},status:401},
    ]){
        const res=await fetch(f.url,{method:entry.method,headers:entry.headers,
            ...(entry.method==='POST'&&{body:JSON.stringify(data)})});
        assert.equal(res.status,entry.status);
    }
    assert.deepEqual(f.called,[]);
});

test('Node outcome reports authenticate before rejecting malformed, oversized or executable payloads',async t=>{
    const f=await fixture(); t.after(f.close);
    const cases=[
        '{',
        JSON.stringify({ ...data, approved:true }),
        JSON.stringify({ ...data, executable:true }),
        JSON.stringify({ ...data, reportedState:'verified' }),
        JSON.stringify({ ...data, targetSha256:'0' }),
        JSON.stringify({ ...data, intentId:'wrong' }),
        JSON.stringify({ junk:'x'.repeat(4096) }),
    ];
    for(const body of cases){
        const res=await fetch(f.url,{method:'POST',headers:f.headers,body});
        assert.equal(res.status,400,body.slice(0,80));
    }
    assert.equal(f.called.length,cases.length);
    assert.ok(f.called.every(x=>x==='auth'));
});

test('Node outcome endpoint stays closed with the existing Server claim feature flag',async t=>{
    const f=await fixture(true);t.after(f.close);
    const res=await fetch(f.url,{method:'POST',headers:f.headers,body:JSON.stringify(data)});
    assert.equal(res.status,404);
    assert.deepEqual(f.called,[]);
});
