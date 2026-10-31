import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { serveNodeImages } from '../apps/server/src/api/http/node-images.js';
import type { ServerServices } from '../apps/server/src/server/composition.js';

const source='11111111-1111-4111-8111-111111111111';
const target='22222222-2222-4222-8222-222222222222';
const id='33333333-3333-4333-8333-333333333333';
const bytes=Buffer.alloc(24);
Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
bytes.write('IHDR',12,'ascii'); bytes.writeUInt32BE(5,16); bytes.writeUInt32BE(3,20);
const hash=createHash('sha256').update(bytes).digest('hex');

async function withServer(relay:unknown, fn:(origin:string)=>Promise<void>) {
    const server=createServer((request,response)=>{
        void serveNodeImages(request,response,{imageRelay:relay} as Pick<ServerServices,'imageRelay'>)
            .then(handled=>{if(!handled){response.writeHead(404);response.end();}})
            .catch(()=>{response.writeHead(500);response.end();});
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
    const address=server.address();
    assert.ok(address && typeof address!=='string');
    try { await fn('http://127.0.0.1:'+address.port); }
    finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
}
const auth={authorization:'Bearer '+'x'.repeat(43),'x-atlas-node-id':source};
const headers={
    ...auth,'x-atlas-target-id':target,'x-atlas-delivery-id':id,
    'x-atlas-image-mime':'image/png','x-atlas-image-sha256':hash,
    'content-type':'application/octet-stream',
};

test('binary image endpoint never accepts web origins, including same-site',async()=>{
    await withServer(undefined,async origin=>{
        const response=await fetch(origin+'/node/images/upload',{
            method:'POST',headers:{...headers,origin:'https://atlas.example.com'},body:bytes,
        });
        assert.equal(response.status,403);
    });
});
test('binary route rejects unauthenticated upload before allocating image bytes',async()=>{
    await withServer(undefined,async origin=>{
        const response=await fetch(origin+'/node/images/upload',{
            method:'POST',headers:{...headers,authorization:'Bearer bad'},body:bytes,
        });
        assert.equal(response.status,401);
    });
});
test('authenticated image send returns only confirmed Mac approval, fetch is binary',async()=>{
    let released=0,admitted=0,consumed=0;
    const relay={
        admit:async(node:string,targetNode:string)=>{
            assert.equal(node,source);assert.equal(targetNode,target);admitted++;
            return {target:{},sourceRuntime:{},release:()=>{released++;}};
        },
        deliver:async(_admitted:unknown,offer:{bytes:Buffer;sha256:string},credential:string)=>{
            assert.equal(credential,'x'.repeat(43));
            assert.deepEqual(offer.bytes,bytes);assert.equal(offer.sha256,hash);
            return {accepted:true};
        },
        consume:async(readId:string,node:string,credential:string)=>{
            consumed++;assert.equal(readId,id);assert.equal(node,target);
            assert.equal(credential,'x'.repeat(43));
            return {bytes,mimeType:'image/png',sha256:hash};
        },
    };
    await withServer(relay,async origin=>{
        const posted=await fetch(origin+'/node/images/upload',{
            method:'POST',headers,body:bytes,
        });
        assert.equal(posted.status,200);
        assert.deepEqual(await posted.json(),{accepted:true});
        const fetched=await fetch(origin+'/node/images/'+id,{
            headers:{...auth,'x-atlas-node-id':target},
        });
        assert.equal(fetched.status,200);
        assert.equal(fetched.headers.get('content-type'),'image/png');
        assert.equal(fetched.headers.get('cache-control'),'no-store');
        assert.equal(fetched.headers.get('x-atlas-image-sha256'),hash);
        assert.deepEqual(Buffer.from(await fetched.arrayBuffer()),bytes);
    });
    assert.equal(admitted,1);assert.equal(released,1);assert.equal(consumed,1);
});
test('image transport refuses unsupported methods and missing metadata',async()=>{
    await withServer(undefined,async origin=>{
        const get=await fetch(origin+'/node/images/upload',{method:'GET',headers:auth});
        assert.equal(get.status,405);
        const upload=await fetch(origin+'/node/images/upload',{
            method:'POST',headers:{...auth,'content-type':'application/octet-stream'},body:bytes,
        });
        assert.equal(upload.status,400);
    });
});
