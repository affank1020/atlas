import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ActivityRows } from './ActivityFeed';
import type { AuditEvent } from './types';

afterEach(cleanup);

const event: AuditEvent = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    occurredAt: '2026-10-31T13:00:00Z',
    client: 'atlas-node',
    operation: 'node.update_outcome_reported',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    resulting: {
        transport: 'mcp', actorKind: 'node-credential',
        nodeId: '22222222-2222-4222-8222-222222222222',
        sourceNodeId: '33333333-3333-4333-8333-333333333333',
        targetNodeId: '44444444-4444-4444-8444-444444444444',
        intentId: '55555555-5555-4555-8555-555555555555',
        reportedState: 'requires_reconciliation', verified: false, clearsClaim: false,
    },
};

test('expanded Monitoring Activity distinguishes recorded transport, Node direction and unverified claims', () => {
    render(<ActivityRows events={[event]} scopeLinks />);
    fireEvent.click(screen.getByText('Node update outcome reported').closest('summary')!);
    const evidence = screen.getByRole('group', { name: 'Recorded operation provenance' });
    expect(within(evidence).getByText('Operation provenance')).toBeInTheDocument();
    expect(within(evidence).getByText(/do not establish a human operator/)).toBeInTheDocument();
    const byLabel = (label: string) => {
        const term = within(evidence).getByText(label);
        return term.closest('div')?.querySelector('dd')?.textContent;
    };
    expect(byLabel('Recorded client')).toBe('atlas-node');
    expect(byLabel('Transport')).toBe('mcp');
    expect(byLabel('Credential class')).toBe('node-credential');
    expect(byLabel('Source Node')).toBe('33333333-3333-4333-8333-333333333333');
    expect(byLabel('Target Node')).toBe('44444444-4444-4444-8444-444444444444');
    expect(byLabel('Node-reported activation')).toBe('requires_reconciliation');
    expect(byLabel('Verification flag')).toBe('false');
    expect(byLabel('Clears-claim flag')).toBe('false');
    expect(screen.getByRole('link', { name: 'Source Node activity' })).toHaveAttribute('href',
        '#/monitoring?tab=activity&nodeId=33333333-3333-4333-8333-333333333333');
    expect(screen.getByRole('link', { name: 'Target Node activity' })).toHaveAttribute('href',
        '#/monitoring?tab=activity&nodeId=44444444-4444-4444-8444-444444444444');
});

test('legacy recent activity previews do not imply Monitoring provenance or reveal new controls', () => {
    render(<ActivityRows events={[event]} />);
    fireEvent.click(screen.getByText('Node update outcome reported').closest('summary')!);
    expect(screen.queryByRole('group', { name: 'Recorded operation provenance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Related monitoring scopes' })).not.toBeInTheDocument();
});
