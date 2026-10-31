import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrderedPushMutations } from '../apps/server/src/nodes/ordered-push-mutations.js';

test('delayed register cannot commit after later unregister, even if second operation is faster',async()=>{
    const queue=new OrderedPushMutations();
    const events:string[]=[];
    let releaseRegister!:()=>void;
    const blocked=new Promise<void>(resolve=>{ releaseRegister=resolve; });
    const registration=queue.run(async()=>{
        events.push('register-start');
        await blocked;
        events.push('register-commit');
    });
    const removal=queue.run(async()=>{ events.push('unregister-commit'); });
    await Promise.resolve();
    assert.deepEqual(events,['register-start']);
    releaseRegister();
    await Promise.all([registration,removal]);
    assert.deepEqual(events,['register-start','register-commit','unregister-commit']);
});

test('queue continues after a rejected command and bounds buffered writes', async()=>{
    const queue=new OrderedPushMutations(2);
    let unblock!:()=>void;
    const barrier=new Promise<void>(resolve=>{unblock=resolve;});
    const first=queue.run(async()=>{await barrier;throw Error('auth failed');});
    const next=queue.run(async()=>42);
    await assert.rejects(queue.run(async()=>0),/busy/);
    unblock();
    await assert.rejects(first,/auth failed/);
    assert.equal(await next,42);
    assert.equal(await queue.run(async()=>7),7);
});
