import { expect, it } from 'vitest';
import {
    effectiveIntentStatus, latestSoftwareIntent, lifecycleLabel,
    nodeSoftwareCapability,
} from './node-software-model';
import type { NodeUpdateIntent } from './NodeSoftware';

const now = Date.parse('2026-10-23T12:00:00.000Z');
const nodeId = '11111111-1111-4111-8111-111111111111';
const target = (status: NodeUpdateIntent['status'], id: string, node = nodeId): NodeUpdateIntent => ({
    id,nodeId:node,installedVersion:'2.0.0+aaaaaaaaaaaa',
    targetVersion:'2.0.1',targetCommit:'bbbbbbbbbbbb',
    status,createdAt:'2026-10-23T10:00:00Z',expiresAt:'2026-10-23T11:00:00Z',
    approved:false,executable:false,
});

it('explicit platform capabilities do not infer privileged update permission from Node presence',()=>{
    const linux=nodeSoftwareCapability({platform:'linux'});
    expect(linux.preparation).toBe('request-only');
    expect(linux.execution).toBe('external-operator');
    const mac=nodeSoftwareCapability({platform:'darwin'});
    expect(mac.distribution).toBe('published-archive');
    expect(mac.execution).toBe('manual');
    const android=nodeSoftwareCapability({platform:'android',deviceType:'tablet'});
    expect(android.platformLabel).toBe('Android tablet');
    expect(android.distribution).toBe('not-available');
    expect(android.execution).toBe('not-supported');
    const other=nodeSoftwareCapability({platform:'win32'});
    expect(other.preparation).toBe('not-supported');
    expect(other.execution).toBe('not-supported');
    expect(nodeSoftwareCapability({}).distribution).toBe('not-available');
});

it('never confuses expired prepared requests, scoped claims or operator reconciliation with installation proof',()=>{
    const expired=target('requested','22222222-2222-4222-8222-222222222222');
    const claimed=target('claimed','33333333-3333-4333-8333-333333333333');
    const otherClaim=target('claimed','44444444-4444-4444-8444-444444444444','other');
    const reviewed=target('reconciled','55555555-5555-4555-8555-555555555555');
    expect(effectiveIntentStatus(expired,now)).toBe('expired');
    expect(lifecycleLabel(expired,now)).toBe('Request expired');
    expect(latestSoftwareIntent([expired,otherClaim,reviewed,claimed],nodeId,now)?.id).toBe(claimed.id);
    expect(lifecycleLabel(claimed,now)).toBe('Operator reconciliation needed');
    expect(lifecycleLabel(reviewed,now)).toBe('Operator acknowledged');
    expect(latestSoftwareIntent([otherClaim],nodeId,now)).toBeUndefined();
    expect(effectiveIntentStatus({...expired,expiresAt:'not-a-date'},now)).toBe('expired');
    expect(effectiveIntentStatus({...expired,expiresAt:'2026-10-24T00:00:00Z'},now)).toBe('requested');
});
