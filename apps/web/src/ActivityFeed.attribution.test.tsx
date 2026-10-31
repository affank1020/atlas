import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ActivityRows } from './ActivityFeed';
import { monitoringHash } from './monitoringLinks';
import type { AuditEvent } from './types';

afterEach(cleanup);
const source = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const checkoutId = '44444444-4444-4444-8444-444444444444';

test('Node placement exposes scoped previous and destination Node navigation with safe transport fields', () => {
    const event: AuditEvent = { id: 'entry', occurredAt: '2026-10-31T12:00:00Z',
        client: 'atlas-mcp', operation: 'workspace.node_assigned',
        projectId, workspaceId: checkoutId, resulting: {
            nodeId: target, previousNodeId: source, transport: 'mcp', actorKind: 'transport',
        },
    };
    render(<ActivityRows events={[event]} scopeLinks />);
    fireEvent.click(screen.getByText('Workspace node assigned'));
    expect(screen.getByText('Transport')).toBeInTheDocument();
    expect(screen.getByText('mcp')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Node activity' }))
        .toHaveAttribute('href', monitoringHash('activity', { nodeId: target }));
    expect(screen.getByRole('link', { name: 'Previous Node activity' }))
        .toHaveAttribute('href', monitoringHash('activity', { nodeId: source }));
    expect(screen.getByRole('link', { name: 'Project activity' }))
        .toHaveAttribute('href', monitoringHash('activity', { projectId }));
});

test('Node update events render in the Node category and preserve bounded intent evidence', () => {
    const event: AuditEvent = { id: 'intent', occurredAt: '2026-10-31T12:00:00Z',
        client: 'atlas-node-credential', operation: 'node.update_intent_claimed',
        resulting: { nodeId: target, intentId: source, actorKind: 'node-credential',
            transport: 'http', approved: false, executable: false },
    };
    render(<ActivityRows events={[event]} scopeLinks />);
    expect(screen.getByText('atlas-node-credential · Node')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Node update intent claimed'));
    expect(screen.getByText('Intent Id')).toBeInTheDocument();
    expect(screen.getByText(source)).toBeInTheDocument();
    expect(screen.getByText('Executable')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Node activity' }))
        .toHaveAttribute('href', monitoringHash('activity', { nodeId: target }));
});
