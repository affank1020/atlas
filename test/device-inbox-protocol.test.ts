import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deviceInboxEnqueueSchema, deviceInboxListSchema,
  deviceInboxReadSchema, deviceInboxDecideSchema,
} from '../packages/protocol/src/device-protocol.js';

const requestId='123e4567-e89b-42d3-a456-426614174001';
const targetNodeId='123e4567-e89b-42d3-a456-426614174002';
const deliveryId='123e4567-e89b-42d3-a456-426614174003';

describe('separate offline inbox Node protocol',()=>{
  it('rejects untrusted source identity, unknown properties and malformed IDs',()=>{
    const base={type:'device.inbox.enqueue',requestId,targetNodeId,deliveryId,text:'Hello'};
    assert.equal(deviceInboxEnqueueSchema.safeParse(base).success,true);
    assert.equal(deviceInboxEnqueueSchema.safeParse({...base,sourceNodeId:requestId}).success,false);
    assert.equal(deviceInboxEnqueueSchema.safeParse({...base,targetNodeId:'not a uuid'}).success,false);
    assert.equal(deviceInboxEnqueueSchema.safeParse({...base,text:''}).success,false);
  });
  it('uses strict target-scoped list, read and decision requests',()=>{
    assert.equal(deviceInboxListSchema.safeParse({type:'device.inbox.list',requestId}).success,true);
    assert.equal(deviceInboxListSchema.safeParse({type:'device.inbox.list',requestId,targetNodeId}).success,false);
    assert.equal(deviceInboxReadSchema.safeParse({type:'device.inbox.read',requestId,deliveryId}).success,true);
    assert.equal(deviceInboxReadSchema.safeParse({type:'device.inbox.read',requestId,deliveryId,sourceNodeId:requestId}).success,false);
    assert.equal(deviceInboxDecideSchema.safeParse({
      type:'device.inbox.decide',requestId,deliveryId,decision:'user_copied'
    }).success,true);
    assert.equal(deviceInboxDecideSchema.safeParse({
      type:'device.inbox.decide',requestId,deliveryId,decision:'queued'
    }).success,false);
  });
});
