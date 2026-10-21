import test from 'node:test';
import assert from 'node:assert/strict';
import { registrationSchema, nodeRequestSchema } from '../packages/protocol/src/node-protocol.js';
import {
    MAX_DEVICE_SHARE_TEXT, deviceShareSubmissionSchema,
    deviceShareDeliverySchema, deviceShareReceiptSchema,
} from '../packages/protocol/src/device-protocol.js';

const sourceId = '00000000-0000-4000-8000-000000000021';
const targetId = '00000000-0000-4000-8000-000000000022';
const requestId = '00000000-0000-4000-8000-000000000023';
const deliveryId = '00000000-0000-4000-8000-000000000024';

test('existing protocol v2 registration stays backwards compatible with empty and old capability sets', () => {
    const base = { type: 'register', protocol: 2, nodeId: sourceId, name: 'Android', platform: 'android', version: '0.2.0' };
    assert.equal(registrationSchema.safeParse({ ...base, capabilities: [] }).success, true);
    assert.equal(registrationSchema.safeParse({ ...base, capabilities: ['workspace.files'] }).success, true);
    assert.equal(registrationSchema.safeParse({ ...base, capabilities: ['device.share.send'] }).success, true);
    assert.equal(registrationSchema.safeParse({ ...base, capabilities: ['device.share.receive'] }).success, true);
    assert.equal(registrationSchema.safeParse({ ...base, capabilities: ['device.shell'] }).success, false);
});

test('device submissions cannot supply their own authenticated source or arbitrary payload', () => {
    const safe = { type: 'device.share.submit', requestId, deliveryId, targetNodeId: targetId, text: 'hello' };
    assert.equal(deviceShareSubmissionSchema.safeParse(safe).success, true);
    assert.equal(deviceShareSubmissionSchema.safeParse({ ...safe, sourceNodeId: sourceId }).success, false);
    assert.equal(deviceShareSubmissionSchema.safeParse({ ...safe, command: 'rm -rf' }).success, false);
    assert.equal(deviceShareSubmissionSchema.safeParse({ ...safe, text: '' }).success, false);
    assert.equal(deviceShareSubmissionSchema.safeParse({ ...safe, text: 'x'.repeat(MAX_DEVICE_SHARE_TEXT + 1) }).success, false);
    assert.equal(deviceShareSubmissionSchema.safeParse({ ...safe, targetNodeId: 'not-a-uuid' }).success, false);
});

test('delivered messages are bounded, source-identified and have validated expiry', () => {
    const safe = { type: 'request', kind: 'device_share', requestId, deliveryId, sourceNodeId: sourceId,
        text: 'hello', expiresAt: '2026-10-21T18:00:00Z' };
    assert.equal(deviceShareDeliverySchema.safeParse(safe).success, true);
    assert.equal(deviceShareDeliverySchema.safeParse({ ...safe, expiresAt: 'whenever' }).success, false);
    assert.equal(deviceShareDeliverySchema.safeParse({ ...safe, text: 'x'.repeat(MAX_DEVICE_SHARE_TEXT + 1) }).success, false);
    assert.equal(deviceShareDeliverySchema.safeParse({ ...safe, rootPath: '/private' }).success, false);
});

test('legacy Node gateway does not accidentally admit device requests before authorised routing exists', () => {
    const delivery = { type: 'request', kind: 'device_share', requestId, deliveryId, sourceNodeId: sourceId,
        text: 'hello', expiresAt: '2026-10-21T18:00:00Z' };
    assert.equal(nodeRequestSchema.safeParse(delivery).success, false);
    assert.equal(deviceShareReceiptSchema.safeParse({ accepted: true }).success, true);
    assert.equal(deviceShareReceiptSchema.safeParse({ accepted: false }).success, true);
    assert.equal(deviceShareReceiptSchema.safeParse({ accepted: true, copiedToClipboard: true }).success, false);
});
