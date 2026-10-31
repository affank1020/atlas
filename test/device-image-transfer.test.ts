import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { LiveImageRelay, isImage } from '../apps/server/src/nodes/live-image-relay.js';
import { RemoteNodeRuntime } from '../apps/server/src/infrastructure/nodes/remote-runtime.js';
import { MacImageReceiver, imagePasteboardScript } from '../apps/node/src/capabilities/device-share/mac-image-receiver.js';
import { deviceImageDeliverySchema, MAX_DEVICE_IMAGE_BYTES } from '@atlas/protocol/device-protocol';
import { loadDeviceImageConfig } from '../apps/server/src/server/config.js';
import { imageDimensions } from '@atlas/protocol/image-format';
import type { NodeService } from '../apps/server/src/nodes/service.js';
import type { NodeShareApprovals } from '../apps/server/src/nodes/share-approvals.js';

const source='11111111-1111-4111-8111-111111111111';
const target='22222222-2222-4222-8222-222222222222';
const delivery='33333333-3333-4333-8333-333333333333';
function png():Buffer {
    const bytes=Buffer.alloc(24);
    Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes,0);
    bytes.write('IHDR',12,'ascii');
    bytes.writeUInt32BE(3,16);
    bytes.writeUInt32BE(5,20);
    return bytes;
}
const bytes=png();
const sha256=createHash('sha256').update(bytes).digest('hex');
const expiresAt=()=>new Date(Date.now()+40_000).toISOString();
function harness() {
    let permitted=true;
    let credentialsValid=true;
    const remote=new RemoteNodeRuntime({} as never,['device.image.receive']);
    const runtimes=new Map<string,unknown>([
        [source,{getCapabilities:()=>['device.image.send']}],
        [target,remote],
    ]);
    const nodes={
        runtimes,
        identity:{authenticate:async (_id:string,_token:string)=>{
            if (!credentialsValid) throw Error('revoked');
        }},
        get:async (id:string)=>id===source
            ? {platform:'android',credentialState:'active',capabilities:['device.image.send']}
            : {platform:'darwin',credentialState:'active',capabilities:['device.image.receive']},
    } as unknown as NodeService;
    const approvals={allowedForInbox:async()=>permitted} as unknown as NodeShareApprovals;
    const imagePairs=new Set([source+':'+target]);
    const relay=new LiveImageRelay(nodes,approvals,imagePairs);
    return {relay,remote,runtimes,imagePairs,setPermission:(value:boolean)=>{permitted=value;},
        setCredentials:(value:boolean)=>{credentialsValid=value;}};
}

test('generic image metadata is strict and does not contain bytes or user text',()=>{
    const request={type:'request',kind:'device_image',requestId:delivery,
        deliveryId:delivery,sourceNodeId:source,mimeType:'image/png',
        byteLength:24,sha256,expiresAt:expiresAt()};
    assert.equal(deviceImageDeliverySchema.safeParse(request).success,true);
    assert.equal(deviceImageDeliverySchema.safeParse({...request,text:'sensitive'}).success,false);
    assert.equal(deviceImageDeliverySchema.safeParse({...request,byteLength:MAX_DEVICE_IMAGE_BYTES+1}).success,false);
});
test('format, dimensions and strict fingerprint gate both ordinary images and snips',()=>{
    assert.equal(isImage(bytes,'image/png'),true);
    assert.equal(isImage(Buffer.concat([bytes,Buffer.alloc(4)]),'image/jpeg'),false);
    const oversized=Buffer.from(bytes);oversized.writeUInt32BE(17_000,16);
    assert.equal(isImage(oversized,'image/png'),false);
    assert.equal(isImage(Buffer.alloc(24),'image/png'),false);
});
test('user-approved image handoff uses one target-only binary fetch, then confirmed paste',async()=>{
    const {relay,remote}=harness();
    const seen:string[]=[];
    const receiver=new MacImageReceiver(async()=>{seen.push('approve');return true;},
        async(input)=>{seen.push('image-paste');assert.deepEqual(input.bytes,bytes);});
    remote.deliverDeviceImage=async input=>{
        assert.equal(JSON.stringify(input).includes('bytes'),false);
        const image=await relay.consume(input.deliveryId,target,'x'.repeat(40));
        assert.deepEqual(image.bytes,bytes);
        await assert.rejects(relay.consume(input.deliveryId,target,'x'.repeat(40)));
        return receiver.receive({...input,bytes:image.bytes});
    };
    const admitted=await relay.admit(source,target,'x'.repeat(40));
    try {
        const result=await relay.deliver(admitted,{
            sourceId:source,targetId:target,deliveryId:delivery,
            mimeType:'image/png',sha256,bytes,
        }, 'x'.repeat(40));
        assert.deepEqual(result,{accepted:true});
        assert.deepEqual(seen,['approve','image-paste']);
        assert.equal(relay.pendingCount,0);
    } finally {admitted.release();}
});
test('unauthorised image sender or revoked direction cannot transfer',async()=>{
    const {relay,setPermission}=harness();
    setPermission(false);
    await assert.rejects(relay.admit(source,target,'x'.repeat(40)));
    assert.equal(relay.pendingCount,0);
});
test('image receiver does not copy after decline or expired receipt',async()=>{
    let copies=0;
    const receiver=new MacImageReceiver(async()=>false,async()=>{copies++;});
    const input={deliveryId:delivery,sourceNodeId:source,mimeType:'image/png' as const,
        sha256,bytes,byteLength:bytes.length,expiresAt:expiresAt()};
    assert.deepEqual(await receiver.receive(input),{accepted:false});
    assert.equal(copies,0);
    assert.deepEqual(await receiver.receive(input),{accepted:false});
    await assert.rejects(receiver.receive({...input,expiresAt:new Date(0).toISOString()}));
});
test('image pasteboard writes a native image type, not a plain-text pasteboard',()=>{
    const script=imagePasteboardScript({
        deliveryId:delivery,sourceNodeId:source,mimeType:'image/png',sha256,
        bytes,byteLength:bytes.length,expiresAt:expiresAt(),
    });
    assert.ok(script.includes('public.png'));
    assert.ok(script.includes('setDataForType'));
    assert.equal(script.includes('NSPasteboardTypeString'),false);
});

test('text sharing approval cannot implicitly authorize image transfer',async()=>{
    const {relay,imagePairs}=harness();
    imagePairs.clear();
    await assert.rejects(relay.admit(source,target,'x'.repeat(40)),/not authorised/);
});
test('image pair config is separate, directional and fail closed',()=>{
    assert.equal(loadDeviceImageConfig({} as NodeJS.ProcessEnv).approvedPairs.size,0);
    const config=loadDeviceImageConfig({ATLAS_DEVICE_IMAGE_PAIRS:source+':'+target} as NodeJS.ProcessEnv);
    assert.equal(config.approvedPairs.has(source+':'+target),true);
    assert.equal(config.approvedPairs.has(target+':'+source),false);
    assert.throws(()=>loadDeviceImageConfig({ATLAS_DEVICE_IMAGE_PAIRS:source+':'+source} as NodeJS.ProcessEnv));
});

test('cropped images do not require full-screen proportions and decompression bombs fail closed',()=>{
    const clipped=Buffer.from(bytes);
    clipped.writeUInt32BE(80,16);
    clipped.writeUInt32BE(40,20);
    assert.deepEqual(imageDimensions(clipped,'image/png'),{width:80,height:40});
    const bomb=Buffer.from(bytes);
    bomb.writeUInt32BE(8000,16);
    bomb.writeUInt32BE(8000,20);
    assert.equal(imageDimensions(bomb,'image/png'),null);
});
test('JPEG parser verifies SOF dimensions and blocks oversized pixel areas',()=>{
    const jpeg=Buffer.from([
        0xff,0xd8,
        0xff,0xe0,0x00,0x04,0x01,0x02,
        0xff,0xc0,0x00,0x0b,0x08,0x00,0x64,0x00,0x32,0x01,0x01,0x11,0x00,0x00,
        0xff,0xd9,0x00,0x00,
    ]);
    // A minimal metadata fixture; native image decoder is still the final
    // authority for actual complete JPEG pixel bytes.
    jpeg[jpeg.length-2]=0xff;jpeg[jpeg.length-1]=0xd9;
    assert.deepEqual(imageDimensions(jpeg,'image/jpeg'),{width:50,height:100});
    jpeg[14]=0xff;jpeg[15]=0xff;jpeg[16]=0xff;jpeg[17]=0xff;
    assert.equal(imageDimensions(jpeg,'image/jpeg'),null);
});

test('forged source UUID and invalid credential never charge legitimate sender rate',async()=>{
    const {relay,setCredentials}=harness();
    setCredentials(false);
    for(let i=0;i<20;i++) {
        await assert.rejects(relay.admit(source,target,'invalid-token','192.0.2.4'),/revoked/);
    }
    assert.equal(relay.authenticatedRateEntries,0);
    assert.equal(relay.pendingAuthCount,0);
    setCredentials(true);
    const admitted=await relay.admit(source,target,'x'.repeat(40),'192.0.2.5');
    admitted.release();
    assert.equal(relay.authenticatedRateEntries,1);
});

test('pre-auth flood defense is independently peer keyed and hard bounded',async()=>{
    const {relay,setCredentials}=harness();
    setCredentials(false);
    // Thousands of arbitrary source UUIDs or attacker-provided XFF strings
    // must not grow the sender map or the pre-auth peer map without limit.
    for(let i=0;i<700;i++) {
        const fake='00000000-0000-4000-8000-'+i.toString(16).padStart(12,'0');
        await assert.rejects(relay.admit(fake,target,'invalid-token','test-peer-'+i),/revoked/);
    }
    assert.equal(relay.authenticatedRateEntries,0);
    assert.ok(relay.preAuthRateEntries<=128);
    assert.equal(relay.pendingAuthCount,0);
    setCredentials(true);
    const admitted=await relay.admit(source,target,'x'.repeat(40),'valid-peer');
    admitted.release();
});

test('unauthenticated peer is throttled but cannot poison other source budget',async()=>{
    const {relay,setCredentials}=harness();
    setCredentials(false);
    for(let i=0;i<60;i++)
        await assert.rejects(relay.admit(source,target,'invalid-token','abusive-peer'),/revoked/);
    await assert.rejects(relay.admit(source,target,'invalid-token','abusive-peer'),
        (error:{code?:string})=>error.code==='SHARE_RATE_LIMIT');
    assert.equal(relay.authenticatedRateEntries,0);
    setCredentials(true);
    const admitted=await relay.admit(source,target,'x'.repeat(40),'unrelated-peer');
    admitted.release();
});

test('authenticated sender budget is capped and rate storage never grows without bound',async()=>{
    const {relay}=harness();
    for(let i=0;i<12;i++){
        const admitted=await relay.admit(source,target,'x'.repeat(40),'good-peer');
        admitted.release();
    }
    await assert.rejects(relay.admit(source,target,'x'.repeat(40),'good-peer'),
        (error:{code?:string})=>error.code==='SHARE_RATE_LIMIT');
    assert.equal(relay.authenticatedRateEntries,1);
    for(let i=0;i<600;i++) {
        const fake='aaaaaaaa-aaaa-4aaa-8aaa-'+i.toString(16).padStart(12,'0');
        // Identity authentication is deliberately mocked to accept these
        // IDs, but fake identities lack an Android runtime and get denied.
        await assert.rejects(relay.admit(fake,target,'x'.repeat(40),'peer-'+i));
    }
    assert.ok(relay.authenticatedRateEntries<=512);
    assert.equal(relay.pendingAuthCount,0);
});

test('image relay depends on structural delivery interface, not concrete infrastructure',async()=>{
    const {relay,remote,runtimes}=harness();
    // An infrastructure adapter can be replaced by another live implementation
    // satisfying only the explicit domain-side image delivery contract.
    const other={getCapabilities:()=>['device.image.receive'],
        deliverDeviceImage:async()=>({accepted:false})};
    runtimes.set(target,other);
    const admitted=await relay.admit(source,target,'x'.repeat(40),'adapter-peer');
    assert.equal(admitted.target,other);
    admitted.release();
    // Restore only to avoid making the original fixture's remote unused.
    runtimes.set(target,remote);
});
