import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { NodeUpdateIntentLedger } from '../apps/server/src/nodes/update-intents.js';
import { NodeShareApprovals } from '../apps/server/src/nodes/share-approvals.js';
import { NodeService } from '../apps/server/src/nodes/service.js';
import { AuditService } from '../apps/server/src/core/audit.js';
import type { NodeRelease } from '../apps/server/src/nodes/releases.js';

after(cleanupDatabases);
const sha = 'b'.repeat(40);
const candidate: NodeRelease = {
    component: 'desktop-node', platform: 'linux', architecture: 'any',
    channel: 'stable', version: '2.0.1', commit: sha.slice(0, 12),
    sourceCommit: sha, sourceOrder: 19, protocol: 2, minimumNodeJs: 20,
    publishedAt: '2026-10-21T12:00:00Z', notes: '',
    downloadUrl: '', checksumUrl: '', releaseUrl: '', sha256: 'a'.repeat(64),
    provenance: 'unverified',
};
const metadata = (row: any) => row.resulting as Record<string, unknown>;

test('Node lifecycle transport is sourced from trusted calls; checkout placement is project and workspace scoped', async () => {
    const f = await databaseFixture();
    const identity = new NodeIdentity(f.store.pool);
    const ticket = await identity.ticket(undefined, false, 'atlas-http');
    const first = await identity.enrol({ token: ticket.enrolmentToken, name: 'First', platform: 'linux' });
    await identity.update(first.nodeId, 'New name', 'atlas-mcp');
    const project = await f.catalog.createProject({ name: 'Scoped placement' });
    const local = (await f.store.pool.query("SELECT id FROM nodes WHERE local_key='local' LIMIT 1")).rows[0]!.id;
    const logical = (await f.store.pool.query("INSERT INTO logical_workspaces(id,name) VALUES(gen_random_uuid(),'Attribution') RETURNING id")).rows[0]!.id;
    const checkout = (await f.store.pool.query(
        "INSERT INTO workspaces(id,project_id,name,root_path,kind,adapter,node_id,logical_workspace_id) VALUES(gen_random_uuid(),$1,'Attribution','/tmp','generic',NULL,$2,$3) RETURNING id",
        [project.id, local, logical])).rows[0]!.id;
    await identity.assign({ projectId: project.id, workspaceId: checkout,
        nodeId: first.nodeId, expectedNodeId: local }, 'atlas-http');
    const audit = new AuditService(f.store);
    const scoped = await audit.monitoring({ projectId: project.id, workspaceId: checkout, safeDetails: true });
    const placed = scoped.items.find(e => e.operation === 'workspace.node_assigned');
    assert.ok(placed, 'Assignment must be visible through the Project/checkout scope');
    assert.equal(placed.projectId, project.id);
    assert.equal(placed.workspaceId, checkout);
    assert.equal(placed.client, 'atlas-http');
    assert.deepEqual(metadata(placed), { nodeId: first.nodeId, previousNodeId: local,
        transport: 'http', actorKind: 'transport' });
    const fromNode = await audit.monitoring({ nodeId: local, operation: 'workspace.node_assigned', safeDetails: true });
    const toNode = await audit.monitoring({ nodeId: first.nodeId, operation: 'workspace.node_assigned', safeDetails: true });
    assert.equal(fromNode.total, 1);
    assert.equal(toNode.total, 1);
    const other = await f.catalog.createProject({ name: 'Unrelated project' });
    assert.equal((await audit.monitoring({ projectId: other.id, operation: 'workspace.node_assigned', safeDetails: true })).total, 0);
    const updated = await audit.monitoring({ nodeId: first.nodeId, operation: 'node.updated', safeDetails: true });
    assert.equal(updated.items[0]?.client, 'atlas-mcp');
    assert.equal(metadata(updated.items[0]).transport, 'mcp');
    assert.ok(!JSON.stringify(updated).includes('New name'), 'arbitrary Node names stay out of safe details');
    const enrolled = await audit.monitoring({ nodeId: first.nodeId, operation: 'node.enrolled', safeDetails: true });
    assert.equal(enrolled.items[0]?.client, 'atlas-node-enrolment');
    assert.equal(metadata(enrolled.items[0]).actorKind, 'enrolment-token');
});

test('update request, claim and report distinguish transport from machine credentials and preserve intent correlation', async () => {
    const f = await databaseFixture();
    const identity = new NodeIdentity(f.store.pool);
    const ticket = await identity.ticket();
    const enrolled = await identity.enrol({
        token: ticket.enrolmentToken, name: 'Update host', platform: 'linux', version: '2.0.0+aaaaaaaaaaaa',
    });
    await f.store.pool.query("UPDATE nodes SET status='online' WHERE id=$1", [enrolled.nodeId]);
    const credential = (await f.store.pool.query('SELECT credential_updated_at FROM nodes WHERE id=$1',
        [enrolled.nodeId])).rows[0]!.credential_updated_at as Date;
    const ledger = new NodeUpdateIntentLedger(f.store.pool);
    const prepared = await ledger.prepare(enrolled.nodeId, '2.0.0+aaaaaaaaaaaa',
        new Date(credential).toISOString(), candidate, 'atlas-mcp');
    await ledger.cancel(enrolled.nodeId, prepared.id, 'atlas-http');
    const pending = await ledger.prepare(enrolled.nodeId, '2.0.0+aaaaaaaaaaaa',
        new Date(credential).toISOString(), candidate, 'atlas-http');
    await ledger.claim(enrolled.nodeId, pending.id, enrolled.credential,
        '2.0.0+aaaaaaaaaaaa', candidate.sha256);
    await ledger.report(enrolled.nodeId, pending.id, enrolled.credential,
        candidate.sha256, 'requires_reconciliation');
    const service = new AuditService(f.store);
    const filtered = await service.monitoring({ nodeId: enrolled.nodeId, category: 'node',
        safeDetails: true, limit: 100, groupOperations: true });
    const find = (operation: string, intentId: string) => filtered.items.find(event =>
        event.operation === operation && metadata(event).intentId === intentId);
    const request = find('node.update_intent_prepared', prepared.id);
    const cancelled = find('node.update_intent_cancelled', prepared.id);
    const claim = find('node.update_intent_claimed', pending.id);
    const report = find('node.update_outcome_reported', pending.id);
    assert.equal(request?.client, 'atlas-mcp');
    assert.equal(metadata(request).transport, 'mcp');
    assert.equal(cancelled?.client, 'atlas-http');
    assert.equal(metadata(cancelled).status, 'cancelled');
    assert.equal(claim?.client, 'atlas-node-credential');
    assert.equal(metadata(claim).actorKind, 'node-credential');
    assert.equal(metadata(claim).executable, false);
    assert.equal(report?.client, 'atlas-node-credential');
    assert.equal(metadata(report).reportedState, 'requires_reconciliation');
    assert.equal(metadata(report).verified, false);
    assert.equal(metadata(report).clearsClaim, false);
    assert.ok(!JSON.stringify(filtered).includes(enrolled.credential));
    assert.equal((await service.monitoring({ nodeId: enrolled.nodeId, client: 'atlas-mcp',
        operation: 'node.update_intent_claimed' })).total, 0,
        'Node-authenticated claim must not be attributed to MCP or the initiating request');
});

test('share approval attribution keeps the transport label and both Node links without shared data', async () => {
    const f = await databaseFixture();
    const identity = new NodeIdentity(f.store.pool);
    const enrol = async (name: string) => {
        const t = await identity.ticket();
        return identity.enrol({ token: t.enrolmentToken, name, platform: 'android' });
    };
    const a = await enrol('Source'), b = await enrol('Target');
    const approvals = new NodeShareApprovals(f.store.pool);
    await approvals.update({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, enabled: true }, 'atlas-mcp');
    const audit = new AuditService(f.store);
    for (const nodeId of [a.nodeId, b.nodeId]) {
        const page = await audit.monitoring({ nodeId, operation: 'node.share.approved', safeDetails: true });
        assert.equal(page.total, 1);
        assert.equal(page.items[0]?.client, 'atlas-mcp');
        assert.deepEqual(metadata(page.items[0]), {
            sourceNodeId: a.nodeId, targetNodeId: b.nodeId,
            transport: 'mcp', actorKind: 'transport',
        });
    }
});

test('NodeService passes the trusted origin, never a user-supplied client field, to Node identity and intent updates', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const intentId = '22222222-2222-4222-8222-222222222222';
    const received: unknown[] = [];
    const identity = {
        update: async (...args: unknown[]) => { received.push(['update', ...args]); return {}; },
        revoke: async (...args: unknown[]) => { received.push(['revoke', ...args]); return {}; },
        assign: async (...args: unknown[]) => { received.push(['assign', ...args]); return {}; },
    };
    const ledger = {
        cancel: async (...args: unknown[]) => { received.push(['cancel', ...args]); return {}; },
    };
    const nodeService = new NodeService({} as any, undefined, 'Local', identity as any, undefined, ledger as any);
    await nodeService.call('update_node', { nodeId: id, name: 'test' }, 'atlas-mcp');
    await nodeService.call('cancel_node_update_intent', { nodeId: id, intentId }, 'atlas-http');
    await nodeService.call('assign_workspace_node', {
        nodeId: id, projectId: id, workspaceId: id, expectedNodeId: id,
    }, 'atlas-mcp');
    await nodeService.call('revoke_node', { nodeId: id }, 'atlas-http');
    assert.deepEqual(received, [
        ['update', id, 'test', 'atlas-mcp'],
        ['cancel', id, intentId, 'atlas-http'],
        ['assign', { nodeId: id, projectId: id, workspaceId: id, expectedNodeId: id }, 'atlas-mcp'],
        ['revoke', id, 'atlas-http'],
    ]);
});
