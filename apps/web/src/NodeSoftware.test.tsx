import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NodeSoftware, NodeSoftwareSummary, releaseUpdateState, type NodeRelease } from './NodeSoftware';
import { callTool } from './api';
vi.mock('./api', () => ({ callTool: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const release: NodeRelease = {
    component: 'desktop-node', version: '2.0.0', commit: 'abc123abc123', platform: 'linux',
    architecture: 'any', channel: 'stable', protocol: 2, minimumNodeJs: 20,
    publishedAt: '2026-10-21T12:00:00Z', notes: 'Changes',
    downloadUrl: 'https://github.com/affank1020/atlas/releases/download/node-v2.0.0-abc123abc123/atlas-node-v2.0.0-abc123abc123.tar.gz',
    checksumUrl: 'https://github.com/affank1020/atlas/releases/download/node-v2.0.0-abc123abc123/atlas-node-v2.0.0-abc123abc123.tar.gz.sha256',
    releaseUrl: 'https://github.com/affank1020/atlas/releases/tag/node-v2.0.0-abc123abc123',
    sha256: 'a'.repeat(64), provenance: 'unverified',
};
it('keeps downloads absent until verified catalogue entries exist', async () => {
    vi.mocked(callTool).mockResolvedValue({ state: 'unavailable', releases: [], error: 'offline', checkedAt: '' });
    render(<NodeSoftware />);
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.queryByRole('link', { name: /Download release archive/ })).not.toBeInTheDocument();
    expect(screen.getByText(/not production-signed/i)).toBeInTheDocument();
});
it('offers only real published assets and retains platform separation', async () => {
    vi.mocked(callTool).mockResolvedValue({ state: 'ready', releases: [release], checkedAt: '' });
    render(<NodeSoftware />);
    const link = await screen.findByRole('link', { name: /Download release archive/ });
    expect(link).toHaveAttribute('href', release.downloadUrl);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/Build provenance is unverified by Atlas/)).toBeInTheDocument();
    expect(screen.queryByText(/attestation available for independent/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/no published immutable archive/i)).toHaveLength(1);
});
it('never guesses a newer build based only on a different commit', () => {
    expect(releaseUpdateState('2.0.0+abc123abc123', [release], 'linux')).toBe('current');
    expect(releaseUpdateState('2.0.0+ffffffffffff', [release], 'linux')).toBe('unknown');
    expect(releaseUpdateState('1.9.9', [release], 'linux')).toBe('available');
    expect(releaseUpdateState('2.1.0', [release], 'linux')).toBe('newer');
});

it('per-node Linux preflight remains explicit, read-only and reports unverified provenance', async () => {
    const node = {
        id: '11111111-1111-4111-8111-111111111111', name: 'Linux host', platform: 'linux',
        status: 'online' as const, capabilities: [], lastSeen: null, hostedWorkspaceCount: 0,
        version: '1.9.9',
    };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_node_releases') return { state: 'ready', checkedAt: '', releases: [release] };
        if (name === 'plan_node_update') return {
            nodeId: node.id, status: 'candidate',
            reason: 'A newer stable Linux release is available; provenance and host approval remain unverified.',
            candidate: release, canInstall: false, canActivate: false, provenanceVerified: false,
        };
        throw new Error('Unexpected tool: ' + name);
    });
    render(<NodeSoftwareSummary node={node} />);
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'plan_node_update')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Check Linux update eligibility' }));
    expect(callTool).toHaveBeenCalledWith('plan_node_update', { nodeId: node.id });
    expect(await screen.findByText(/Candidate identified/)).toBeInTheDocument();
    expect(screen.getByText(/Update execution is not enabled/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Install|^Activate|^Update now/i })).not.toBeInTheDocument();
});

it('non-Linux Nodes never expose a Linux update preflight control', async () => {
    vi.mocked(callTool).mockResolvedValue({ state: 'ready', checkedAt: '', releases: [] });
    render(<NodeSoftwareSummary node={{
        id: '11111111-1111-4111-8111-111111111111', name: 'Mac', platform: 'darwin',
        status: 'online', capabilities: [], lastSeen: null, hostedWorkspaceCount: 0, version: '2.0.0',
    }} />);
    expect(screen.queryByRole('button', { name: /Check Linux update eligibility/ })).not.toBeInTheDocument();
});

it('invalidates a completed eligibility result when the same Node is revoked or updated', async () => {
    const linux = {
        id: '11111111-1111-4111-8111-111111111111', name: 'Linux host',
        platform: 'linux', version: '1.9.9', status: 'online' as const,
        credentialState: 'active', capabilities: [], lastSeen: null, hostedWorkspaceCount: 0,
    };
    vi.mocked(callTool).mockImplementation(async name => name === 'list_node_releases'
        ? { state: 'ready', releases: [release], checkedAt: '' }
        : { nodeId: linux.id, status: 'candidate', reason: 'A newer release is available.',
            candidate: release, canInstall: false, canActivate: false, provenanceVerified: false });
    const view = render(<NodeSoftwareSummary node={linux} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check Linux update eligibility' }));
    expect(await screen.findByText(/Candidate identified/)).toBeInTheDocument();

    // Parent refresh does not remount the selected Node details.
    view.rerender(<NodeSoftwareSummary node={{ ...linux, credentialState: 'revoked', status: 'offline' }} />);
    expect(screen.queryByText(/Candidate identified/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check Linux update eligibility' })).toBeEnabled();
    // Returning to the original snapshot must not resurrect the old result.
    view.rerender(<NodeSoftwareSummary node={linux} />);
    expect(screen.queryByText(/Candidate identified/)).not.toBeInTheDocument();
    view.rerender(<NodeSoftwareSummary node={{ ...linux, version: '2.0.0+abc123abc123' }} />);
    expect(screen.queryByText(/Candidate identified/)).not.toBeInTheDocument();
});

it('discards an in-flight eligibility result after a same-ID runtime changes', async () => {
    const linux = {
        id: '11111111-1111-4111-8111-111111111111', name: 'Linux host',
        platform: 'linux', version: '1.9.9', status: 'online' as const,
        credentialState: 'active', capabilities: [], lastSeen: null, hostedWorkspaceCount: 0,
    };
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    vi.mocked(callTool).mockImplementation(async name => name === 'list_node_releases'
        ? { state: 'ready', releases: [release], checkedAt: '' }
        : pending);
    const view = render(<NodeSoftwareSummary node={linux} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check Linux update eligibility' }));
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    view.rerender(<NodeSoftwareSummary node={{ ...linux, version: '2.0.0+abc123abc123', status: 'offline' }} />);
    expect(screen.queryByRole('button', { name: 'Checking…' })).not.toBeInTheDocument();
    await act(async () => {
        finish({ nodeId: linux.id, status: 'candidate', reason: 'Stale candidate',
            candidate: release, canInstall: false, canActivate: false, provenanceVerified: false });
        await pending;
    });
    expect(screen.queryByText(/Candidate identified/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Stale candidate/)).not.toBeInTheDocument();
    view.rerender(<NodeSoftwareSummary node={linux} />);
    await waitFor(() => expect(screen.queryByText(/Candidate identified/)).not.toBeInTheDocument());
});

it('prepares a non-executable, expiring Linux intent only after explicit confirmation, then permits cancellation', async () => {
    const node = {
        id: '11111111-1111-4111-8111-111111111111', name: 'Linux host', platform: 'linux',
        status: 'online' as const, credentialState: 'active',
        credentialUpdatedAt: '2026-10-21T10:00:00.000Z',
        version: '1.9.9', capabilities: [], lastSeen: null, hostedWorkspaceCount: 0,
    };
    const request = {
        id: '22222222-2222-4222-8222-222222222222', nodeId: node.id,
        status: 'requested', targetCommit: release.commit, targetVersion: release.version,
        installedVersion: node.version, approved: false, executable: false,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), createdAt: new Date().toISOString(),
    };
    let saved: typeof request | undefined;
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_node_update_intents') return saved ? [saved] : [];
        if (name === 'list_node_releases') return { state: 'ready', checkedAt: '', releases: [release] };
        if (name === 'plan_node_update') return {
            nodeId: node.id, status: 'candidate', reason: 'Newer stable release available.',
            candidate: release, canInstall: false, canActivate: false, provenanceVerified: false,
        };
        if (name === 'prepare_node_update') { saved = request; return request; }
        if (name === 'cancel_node_update_intent') { saved = { ...request, status: 'cancelled' }; return saved; }
        throw new Error('Unexpected tool ' + name);
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
        render(<NodeSoftwareSummary node={node} />);
        fireEvent.click(screen.getByRole('button', { name: 'Check Linux update eligibility' }));
        expect(await screen.findByText(/Candidate identified/)).toBeInTheDocument();
        fireEvent.click(await screen.findByRole('button', { name: /Prepare update request/ }));
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'prepare_node_update')).toBe(false);

        confirm.mockReturnValue(true);
        fireEvent.click(screen.getByRole('button', { name: /Prepare update request/ }));
        expect(callTool).toHaveBeenCalledWith('prepare_node_update', {
            nodeId: node.id, expectedVersion: node.version,
            expectedCredentialUpdatedAt: node.credentialUpdatedAt, targetCommit: release.commit,
        });
        expect(await screen.findByText('Update request: requested')).toBeInTheDocument();
        expect(screen.getByText(/Not approved. No installation or restart will occur/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel update request' }));
        expect(callTool).toHaveBeenCalledWith('cancel_node_update_intent', { nodeId: node.id, intentId: request.id });
        expect(await screen.findByText('Update request: cancelled')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Cancel update request' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Install|Activate|Restart Node/ })).not.toBeInTheDocument();
    } finally { confirm.mockRestore(); }
});
