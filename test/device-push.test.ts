import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { DevicePushService, parseFcmCredentials } from '../apps/server/src/nodes/device-push.js';

const source='11111111-1111-4111-8111-111111111111';
const target='22222222-2222-4222-8222-222222222222';
const delivery='33333333-3333-4333-8333-333333333333';
const token='fcm_'+ 'x'.repeat(84);

test('FCM config rejects malformed credentials, never requires credentials by default',()=>{
    assert.equal(parseFcmCredentials(undefined),undefined);
    assert.throws(()=>parseFcmCredentials('{'),/service-account/);
    assert.throws(()=>parseFcmCredentials(JSON.stringify({project_id:'project'})),/Invalid FCM/);
});

test('registered device token is encrypted; FCM receives only opaque wake data',async()=>{
    const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
    const privateKey=rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString();
    let saved:{nonce:Buffer;tag:Buffer;cipher:Buffer}|undefined;
    let removed=false;
    let allowed=true;
    const db={
        async query(sql:string, args:unknown[]){
            if(sql.includes('INSERT INTO device_push_tokens')){
                assert.equal(args[0],target);
                saved={cipher:args[1] as Buffer,nonce:args[2] as Buffer,tag:args[3] as Buffer};
                assert.equal(saved.cipher.includes(Buffer.from(token)),false);
                return {rowCount:1,rows:[{node_id:target}]};
            }
            if(sql.includes('SELECT p.token_ciphertext')){
                return {rowCount:1,rows:[{
                    token_ciphertext:saved!.cipher,token_nonce:saved!.nonce,token_tag:saved!.tag,
                }]};
            }
            if(sql.includes('DELETE FROM device_push_tokens')){
                removed=true;return{rowCount:1,rows:[]};
            }
            throw new Error('unexpected SQL');
        },
    } as unknown as Pool;
    const calls:Array<{url:string;init:RequestInit}>=[];
    const fakeFetch=async(input: string|URL|Request, init:RequestInit={}):Promise<Response>=>{
        const url=String(input);calls.push({url,init});
        return new Response(JSON.stringify(url.includes('/token')
            ? {access_token:'a'.repeat(80),expires_in:3600}
            : {name:'projects/atlas/messages/123'}),{status:200,headers:{'content-type':'application/json'}});
    };
    const service=new DevicePushService(db,randomBytes(32),{
        projectId:'atlas-test',clientEmail:'test@atlas-test.iam.gserviceaccount.com',privateKey,
    },{allowedForInbox:async()=>allowed} as never,fakeFetch as typeof fetch);
    await service.register(target,token);
    assert.ok(saved);
    await service.notifyQueued(source,target,delivery);
    assert.equal(calls.length,2);
    assert.equal(calls[0].url,'https://oauth2.googleapis.com/token');
    assert.ok(calls[1].url.endsWith('/projects/atlas-test/messages:send'));
    const payload=JSON.parse(String(calls[1].init.body));
    assert.equal(payload.message.token,token);
    assert.deepEqual(payload.message.data,{kind:'atlas_inbox',deliveryId:delivery});
    assert.equal(payload.message.android.priority,'HIGH');
    assert.equal(JSON.stringify(payload).includes('text'),false);
    allowed=false;
    await service.notifyQueued(source,target,delivery);
    assert.equal(calls.length,2,'revocation must block the wake');
    await service.unregister(target);
    assert.equal(removed,true);
});
