import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NodeSoftware, NodeSoftwareSummary, releaseUpdateState, type NodeRelease, type NodeUpdateIntent } from './NodeSoftware';
import { callTool } from './api';
import { mockTool } from './mockTools';
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
    vi.mocked(callTool).mockImplementation(async name => name === 'list_nodes' ? [] :
        { state: 'unavailable', releases: [], error: 'offline', checkedAt: '' });
    render(<NodeSoftware />);
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.queryByRole('link', { name: /Download release archive/ })).not.toBeInTheDocument();
    expect(screen.getByText(/not production-signed/i)).toBeInTheDocument();
});
it('offers only real published assets and retains platform separation', async () => {
    vi.mocked(callTool).mockImplementation(async name => name === 'list_nodes' ? [] :
        { state: 'ready', releases: [release], checkedAt: '' });
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
    expect(screen.getByRole('link',{name:/Open software management and downloads/}))
        .toHaveAttribute('href','#/nodes/software?node='+node.id);
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
        await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel update request' })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: 'Cancel update request' }));
        expect(callTool).toHaveBeenCalledWith('cancel_node_update_intent', { nodeId: node.id, intentId: request.id });
        expect(await screen.findByText('Update request: cancelled')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Cancel update request' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Install|Activate|Restart Node/ })).not.toBeInTheDocument();
    } finally { confirm.mockRestore(); }
});


it('rehydrates an existing pending update request after remount, Node switch and snapshot change', async () => {
    const node = {
        id: '11111111-1111-4111-8111-111111111111', name: 'Linux host', platform: 'linux',
        status: 'online' as const, version: '1.9.9', credentialState: 'active',
        credentialUpdatedAt: '2026-10-21T10:00:00.000Z',
        capabilities: [], lastSeen: null, hostedWorkspaceCount: 0,
    };
    const intent = {
        id: '22222222-2222-4222-8222-222222222222', nodeId: node.id,
        targetVersion: release.version, targetCommit: release.commit, installedVersion: node.version,
        status: 'requested' as const, createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(),
        approved: false as const, executable: false as const,
    };
    let persisted: NodeUpdateIntent[] = [intent];
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_node_releases') return { state: 'ready', releases: [release], checkedAt: '' };
        if (name === 'list_node_update_intents') return persisted;
        if (name === 'cancel_node_update_intent') {
            persisted = [{ ...intent, status: 'cancelled' as const }];
            return persisted[0];
        }
        throw new Error('Unexpected tool ' + name);
    });
    const view = render(<NodeSoftwareSummary node={node} />);
    expect(await screen.findByText('Update request: requested')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel update request' })).toBeEnabled();
    expect(callTool).not.toHaveBeenCalledWith('plan_node_update', expect.anything());

    view.unmount();
    render(<NodeSoftwareSummary node={node} />);
    expect(await screen.findByText('Update request: requested')).toBeInTheDocument();

    const switched = {
        ...node, id: '33333333-3333-4333-8333-333333333333',
    };
    const liveView = render(<NodeSoftwareSummary node={switched} />);
    liveView.rerender(<NodeSoftwareSummary node={{ ...switched, status: 'offline' }} />);
    liveView.rerender(<NodeSoftwareSummary node={node} />);
    await waitFor(() => expect(vi.mocked(callTool).mock.calls.filter(([name]) =>
        name === 'list_node_update_intents').length).toBeGreaterThanOrEqual(4));
    expect(screen.getAllByText('Update request: requested').length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel update request' })[0]!);
    expect(callTool).toHaveBeenCalledWith('cancel_node_update_intent', {
        nodeId: node.id, intentId: intent.id,
    });
    expect(await screen.findByText('Update request: cancelled')).toBeInTheDocument();
});

it('expires pending requests while the Software card is open, without a manual refresh', async () => {
    const node = {
        id: '11111111-1111-4111-8111-111111111111', name: 'Linux host',
        platform: 'linux', version: '1.9.9', status: 'online' as const,
        credentialState: 'active', capabilities: [], lastSeen: null, hostedWorkspaceCount: 0,
    };
    const intent = {
        id: '22222222-2222-4222-8222-222222222222', nodeId: node.id,
        status: 'requested' as const, targetVersion: release.version, targetCommit: release.commit,
        installedVersion: node.version, approved: false as const, executable: false as const,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 450).toISOString(),
    };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_node_releases') return { state: 'ready', releases: [release], checkedAt: '' };
        if (name === 'list_node_update_intents') return [intent];
        throw new Error('Unexpected tool ' + name);
    });
    render(<NodeSoftwareSummary node={node} />);
    expect(await screen.findByText('Update request: requested')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel update request' })).toBeInTheDocument();
    expect(await screen.findByText('Update request: expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel update request' })).not.toBeInTheDocument();
});

it('reconciles persisted intent after uncertain prepare result, even if eligibility runs concurrently', async () => {
    const node = {
        id: '11111111-1111-4111-8111-111111111111', name: 'Linux host',
        platform: 'linux', version: '1.9.9', status: 'online' as const,
        credentialState: 'active', capabilities: [], lastSeen: null, hostedWorkspaceCount: 0,
    };
    const intent = {
        id: '22222222-2222-4222-8222-222222222222', nodeId: node.id,
        status: 'requested' as const, targetVersion: release.version, targetCommit: release.commit,
        installedVersion: node.version, approved: false as const, executable: false as const,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    let saved: typeof intent | undefined;
    let rejectPrepare!: (reason: Error) => void;
    const pending = new Promise<unknown>((_, reject) => { rejectPrepare = reject; });
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_node_releases') return { state: 'ready', releases: [release], checkedAt: '' };
        if (name === 'list_node_update_intents') return saved ? [saved] : [];
        if (name === 'plan_node_update') return {
            nodeId: node.id, status: 'candidate', reason: 'Candidate available',
            candidate: release, canInstall: false, canActivate: false, provenanceVerified: false,
        };
        if (name === 'prepare_node_update') return pending;
        throw new Error('Unexpected tool ' + name);
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
        render(<NodeSoftwareSummary node={node} />);
        fireEvent.click(screen.getByRole('button', { name: 'Check Linux update eligibility' }));
        expect(await screen.findByText(/Candidate identified/)).toBeInTheDocument();
        fireEvent.click(await screen.findByRole('button', { name: /Prepare update request/ }));
        expect(screen.getByRole('button', { name: 'Recording request…' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Check Linux update eligibility' }));
        saved = intent; // simulated server commit followed by lost response
        await act(async () => { rejectPrepare(new Error('Connection interrupted')); await pending.catch(() => undefined); });
        expect(await screen.findByText('Update request: requested')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel update request' })).toBeEnabled());
    } finally { confirm.mockRestore(); }
});

it('shows a clean read-only Software card for the built-in demo Linux VPS', async () => {
    const linux = mockTool<Array<{ id: string; name: string }>>('list_nodes')
        .find(item => item.name === 'Demo Linux VPS');
    expect(linux).toBeDefined();
    const demo = mockTool<Parameters<typeof NodeSoftwareSummary>[0]['node']>('get_node', { nodeId: linux!.id });
    vi.mocked(callTool).mockImplementation(async (name, input = {}) => mockTool(name, input));
    render(<NodeSoftwareSummary node={demo} />);
    await waitFor(() => expect(callTool).toHaveBeenCalledWith(
        'list_node_update_intents', { nodeId: demo.id, limit: 20 },
    ));
    await waitFor(() => expect(screen.queryByText('Loading saved update requests…')).not.toBeInTheDocument());
    expect(screen.queryByText(/Update request error/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel update request' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Prepare update request/ })).not.toBeInTheDocument();
});

it('shows a claimed Node update as reserved rather than approved or installed', async () => {
    const node = {
        id: '11111111-1111-4111-8111-111111111111', name: 'Linux host', platform: 'linux',
        status: 'online' as const, credentialState: 'active',
        credentialUpdatedAt: '2026-10-21T10:00:00.000Z',
        version: '1.9.9', capabilities: [], lastSeen: null, hostedWorkspaceCount: 0,
    };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_node_update_intents') return [{
            id: '22222222-2222-4222-8222-222222222222', nodeId: node.id,
            installedVersion: node.version, targetVersion: release.version,
            targetCommit: release.commit, status: 'claimed',
            createdAt: new Date(Date.now() - 60000).toISOString(),
            expiresAt: new Date(Date.now() - 1000).toISOString(),
            approved: false, executable: false,
        }];
        if (name === 'list_node_releases') return { state: 'ready', checkedAt: '', releases: [release] };
        if (name === 'plan_node_update') return {
            nodeId: node.id, status: 'candidate', reason: 'A stable release is available.',
            candidate: release, canInstall: false, canActivate: false, provenanceVerified: false,
        };
        throw new Error('Unexpected tool ' + name);
    });
    render(<NodeSoftwareSummary node={node} />);
    expect(await screen.findByText('Update request: claimed')).toBeInTheDocument();
    expect(screen.getByText(/not a host approval or proof of installation/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check Linux update eligibility' }));
    expect(await screen.findByText(/Candidate identified/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Prepare update request/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel update request/ })).not.toBeInTheDocument();
});

it('automatically refreshes a requested intent after the native Node claims it', async () => {
    const node = {
        id: '11111111-1111-4111-8111-111111111111', name: 'Linux host',
        platform: 'linux', status: 'online' as const, credentialState: 'active',
        credentialUpdatedAt: '2026-10-21T10:00:00.000Z',
        version: '1.9.9', capabilities: [], lastSeen: null, hostedWorkspaceCount: 0,
    };
    const requested: NodeUpdateIntent = {
        id: '22222222-2222-4222-8222-222222222222', nodeId: node.id,
        installedVersion: node.version, targetVersion: release.version,
        targetCommit: release.commit, status: 'requested',
        expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(),
        createdAt: new Date().toISOString(), approved: false, executable: false,
    };
    let serverState: NodeUpdateIntent = requested;
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_node_releases') return { state: 'ready', checkedAt: '', releases: [release] };
        if (name === 'list_node_update_intents') return [serverState];
        if (name === 'cancel_node_update_intent') throw new Error('A stale cancel must never be sent.');
        throw new Error('Unexpected tool ' + name);
    });
    render(<NodeSoftwareSummary node={node} />);
    expect(await screen.findByText('Update request: requested')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel update request' })).toBeEnabled();

    // The Node claims the record without any corresponding Node snapshot change.
    serverState = { ...requested, status: 'claimed' };
    expect(await screen.findByText('Update request: claimed', {}, { timeout: 8_000 })).toBeInTheDocument();
    expect(screen.getByText(/not a host approval or proof of installation/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel update request' })).not.toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.filter(([name]) => name === 'list_node_update_intents').length)
        .toBeGreaterThanOrEqual(2);
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'cancel_node_update_intent')).toBe(false);
}, 12_000);

it('shows reported host outcome as unverified and keeps the claimed update fence', async () => {
    const node = {
        id: '11111111-1111-4111-8111-111111111111', name: 'Linux host',
        platform: 'linux', version: '2.0.0+aaaaaaaaaaaa', status: 'online' as const,
        credentialState: 'active', credentialUpdatedAt: '2026-10-21T10:00:00Z',
        capabilities: [], lastSeen: null, hostedWorkspaceCount: 0,
    };
    const requested: NodeUpdateIntent = {
        id: '22222222-2222-4222-8222-222222222222', nodeId: node.id,
        targetVersion: release.version, targetCommit: release.commit,
        installedVersion: node.version, status: 'claimed', approved: false,
        executable: false, createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now()-2000).toISOString(),
    };
    let observation: NodeUpdateIntent = requested;
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_node_update_intents') return [observation];
        if (name === 'list_node_releases') return { state:'ready', checkedAt:'', releases:[release] };
        if (name === 'plan_node_update') return {
            nodeId:node.id, status:'candidate',reason:'Candidate available',
            candidate:release,canInstall:false,canActivate:false,provenanceVerified:false,
        };
        throw new Error('Unexpected tool ' + name);
    });
    render(<NodeSoftwareSummary node={node} />);
    expect(await screen.findByText('Update request: claimed')).toBeInTheDocument();
    observation = { ...requested, reportedOutcome: {
        intentId:requested.id,nodeId:node.id,reportedState:'activated',
        reportedAt:new Date().toISOString(),verified:false,clearsClaim:false,
    }};
    expect(await screen.findByText(/Unverified Node-credential report/,{},{
        timeout:8_000,
    })).toBeInTheDocument();
    expect(screen.getByText(/does not clear the update lock/)).toBeInTheDocument();
    expect(screen.getByText('Not recorded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Check Linux update eligibility'}));
    expect(await screen.findByText(/Candidate identified/)).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:/Prepare update request/})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:/Cancel update request/})).not.toBeInTheDocument();
}, 12_000);

it('shows manually reconciled closure without claiming Atlas has verified a successful update',async()=>{
    const node={
        id:'11111111-1111-4111-8111-111111111111',
        name:'Linux host',platform:'linux',status:'online' as const,
        credentialState:'active',credentialUpdatedAt:'2026-10-21T10:00:00.000Z',
        version:'2.0.0+aaaaaaaaaaaa',capabilities:[],lastSeen:null,hostedWorkspaceCount:0,
    };
    const item:NodeUpdateIntent={
        id:'22222222-2222-4222-8222-222222222222',nodeId:node.id,
        installedVersion:'1.9.9+aaaaaaaaaaaa',targetVersion:'2.0.0',
        targetCommit:'aaaaaaaaaaaa',status:'reconciled',
        createdAt:new Date().toISOString(),expiresAt:new Date().toISOString(),
        approved:false,executable:false,
    };
    vi.mocked(callTool).mockImplementation(async name=>{
        if(name==='list_node_update_intents')return [item];
        if(name==='list_node_releases')return {state:'ready',checkedAt:'',releases:[release]};
        if(name==='plan_node_update')return {
            nodeId:node.id,status:'current',reason:'Current release',candidate:null,
            canInstall:false,canActivate:false,provenanceVerified:false,
        };
        throw new Error('Unexpected tool '+name);
    });
    render(<NodeSoftwareSummary node={node}/>);
    expect(await screen.findByText('Update request: reconciled')).toBeInTheDocument();
    expect(screen.getByText(/operator-acknowledged closure, not Atlas-measured health/)).toBeInTheDocument();
    expect(screen.getByText('Not recorded')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:/Cancel update request/})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:/Install|Activate|Update now/i})).not.toBeInTheDocument();
});

it('software fleet shows real Node versions and platform-specific capabilities without fabricated update buttons', async () => {
    const nodes = [
        { id:'11111111-1111-4111-8111-111111111111',name:'Linux VPS',platform:'linux',
            status:'online',version:'1.9.9+aaaaaaaaaaaa',capabilities:[],lastSeen:null,hostedWorkspaceCount:0 },
        { id:'22222222-2222-4222-8222-222222222222',name:'Mac desktop',platform:'darwin',
            status:'offline',version:'2.0.0+bbbbbbbbbbbb',capabilities:[],lastSeen:null,hostedWorkspaceCount:0 },
        { id:'33333333-3333-4333-8333-333333333333',name:'Android tablet',platform:'android',
            deviceType:'tablet',status:'online',version:'2.0.0',capabilities:[],lastSeen:null,hostedWorkspaceCount:0 },
        { id:'44444444-4444-4444-8444-444444444444',name:'Experimental device',platform:'freebsd',
            status:'unavailable',version:null,capabilities:[],lastSeen:null,hostedWorkspaceCount:0 },
    ];
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return nodes;
        if (name === 'list_node_update_intents') return [];
        if (name === 'list_node_releases') return { state:'ready',releases:[release],checkedAt:'' };
        throw new Error('Unexpected tool '+name);
    });
    render(<NodeSoftware />);
    const fleet = await screen.findByRole('region',{name:'Node software fleet'});
    expect(within(fleet).getByText('Linux VPS')).toBeInTheDocument();
    expect(within(fleet).getByText('Mac desktop')).toBeInTheDocument();
    expect(within(fleet).getAllByText('Android tablet').length).toBeGreaterThanOrEqual(1);
    expect(within(fleet).getByText('Experimental device')).toBeInTheDocument();
    expect(within(fleet).getAllByText('Newer release available').length).toBeGreaterThanOrEqual(1);
    expect(within(fleet).getByText('4 of 4 Nodes')).toBeInTheDocument();
    expect(within(fleet).queryByRole('button',{name:/Install|Activate|Update now/i})).not.toBeInTheDocument();
    fireEvent.click(within(fleet).getByRole('button',{name:/Android tablet/}));
    const detail = within(fleet).getByRole('region',{name:'Selected Node software details'});
    expect(within(detail).getByText('Android tablet')).toBeInTheDocument();
    expect(within(detail).getByText('No stable distribution')).toBeInTheDocument();
    expect(within(detail).getAllByText('Not supported')).toHaveLength(2);
    expect(within(detail).getByText(/Stable signed APK distribution/)).toBeInTheDocument();
    expect(within(detail).getByRole('link',{name:/Open Node details/}))
        .toHaveAttribute('href','#/nodes?node='+nodes[2].id);
    fireEvent.change(within(fleet).getByRole('combobox',{name:'Show Nodes'}),{target:{value:'linux'}});
    expect(within(fleet).getByText('1 of 4 Nodes')).toBeInTheDocument();
    expect(within(fleet).queryByRole('button',{name:/Android tablet/})).not.toBeInTheDocument();
    expect(within(fleet).getByRole('button',{name:/Linux VPS/})).toBeInTheDocument();
    expect(within(detail).getByRole('heading',{name:'Linux VPS'})).toBeInTheDocument();
    expect(within(detail).queryByRole('heading',{name:'Android tablet'})).not.toBeInTheDocument();
});

it('shows only the selected Linux claim and marks Node-credential outcomes as unverified', async () => {
    const one='11111111-1111-4111-8111-111111111111';
    const two='22222222-2222-4222-8222-222222222222';
    const nodes=[one,two].map((id,i)=>({id,name:i===0?'First Linux':'Second Linux',
        platform:'linux',status:'online',version:'2.0.0+abc123abc123',
        capabilities:[],lastSeen:null,hostedWorkspaceCount:0}));
    const claimed:NodeUpdateIntent={id:'44444444-4444-4444-8444-444444444444',nodeId:one,
        targetVersion:'2.0.1',targetCommit:'aaaaaaaaaaaa',installedVersion:'2.0.0+abc123abc123',
        status:'claimed',approved:false,executable:false,
        createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()-10_000).toISOString(),
        reportedOutcome:{intentId:'44444444-4444-4444-8444-444444444444',nodeId:one,
            reportedState:'activated',reportedAt:new Date().toISOString(),verified:false,clearsClaim:false}};
    vi.mocked(callTool).mockImplementation(async (name,args) => {
        if(name==='list_nodes') return nodes;
        if(name==='list_node_releases') return {state:'ready',releases:[release],checkedAt:''};
        if(name==='list_node_update_intents') return (args as {nodeId:string}).nodeId===one?[claimed]:[];
        throw new Error('Unexpected tool '+name);
    });
    render(<NodeSoftware />);
    const fleet=await screen.findByRole('region',{name:'Node software fleet'});
    expect((await within(fleet).findAllByText('Operator reconciliation needed')).length).toBeGreaterThanOrEqual(1);
    expect(within(fleet).getByText(/A claimed update blocks another request/)).toBeInTheDocument();
    expect(within(fleet).getByText(/Node-credential report: activated/)).toBeInTheDocument();
    expect(within(fleet).getAllByText('Not recorded').length).toBeGreaterThanOrEqual(1);
    fireEvent.change(within(fleet).getByRole('combobox',{name:'Show Nodes'}),{target:{value:'review'}});
    expect(within(fleet).getByText('1 of 2 Nodes')).toBeInTheDocument();
    expect(within(fleet).queryByRole('button',{name:/Second Linux/})).not.toBeInTheDocument();
    fireEvent.change(within(fleet).getByRole('combobox',{name:'Show Nodes'}),{target:{value:'all'}});
    fireEvent.click(within(fleet).getByRole('button',{name:/Second Linux/}));
    const detail=within(fleet).getByRole('region',{name:'Selected Node software details'});
    expect(within(detail).getByText('No update requests recorded.')).toBeInTheDocument();
    expect(within(detail).queryByText(/Node-credential report: activated/)).not.toBeInTheDocument();
    expect(within(detail).queryByText(/A claimed update blocks/)).not.toBeInTheDocument();
});

it('isolates failed intent lookup and unknown release provenance without inventing a clean state', async () => {
    const node={
        id:'11111111-1111-4111-8111-111111111111',name:'Unreachable history',platform:'linux',
        status:'offline',version:'2.0.0+abc123abc123',capabilities:[],
        lastSeen:null,hostedWorkspaceCount:0,
    };
    vi.mocked(callTool).mockImplementation(async name => {
        if(name==='list_nodes') return [node];
        if(name==='list_node_releases') return {state:'unavailable',releases:[],checkedAt:'',error:'offline'};
        if(name==='list_node_update_intents') throw new Error('Connection refused');
        throw new Error('Unexpected tool '+name);
    });
    render(<NodeSoftware />);
    const fleet=await screen.findByRole('region',{name:'Node software fleet'});
    expect(await within(fleet).findByText('Request history unavailable')).toBeInTheDocument();
    expect(within(fleet).getByText(/Update history unavailable/)).toBeInTheDocument();
    expect(within(fleet).getAllByText('Release status unknown').length).toBeGreaterThanOrEqual(1);
    expect(within(fleet).getByText(/Some Linux histories unavailable/)).toBeInTheDocument();
    expect(within(fleet).queryByText('Matches published release')).not.toBeInTheDocument();
});


it('fleet poll detects a Node claiming and an operator reconciling without manual Refresh', async () => {
    const nodeId='11111111-1111-4111-8111-111111111111';
    const node={id:nodeId,name:'Review host',platform:'linux',status:'online',
        version:'1.9.9+aaaaaaaaaaaa',capabilities:[],lastSeen:null,hostedWorkspaceCount:0};
    const prepared:NodeUpdateIntent={id:'22222222-2222-4222-8222-222222222222',
        nodeId,installedVersion:node.version,targetVersion:'2.0.0',
        targetCommit:'abc123abc123',status:'requested',approved:false,executable:false,
        createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30_000).toISOString()};
    let authoritative:NodeUpdateIntent=prepared;
    vi.mocked(callTool).mockImplementation(async name => {
        if(name==='list_nodes')return [node];
        if(name==='list_node_update_intents')return [authoritative];
        if(name==='list_node_releases')return {state:'ready',checkedAt:'',releases:[release]};
        throw new Error('Unexpected tool '+name);
    });
    const originalInterval=window.setInterval;
    const ticks:Array<()=>void>=[];
    const spy=vi.spyOn(window,'setInterval').mockImplementation((handler,timeout,...args)=>{
        if(timeout===5_000 && typeof handler==='function')
            ticks.push(()=>handler(...args));
        return originalInterval(handler,timeout,...args);
    });
    try {
        render(<NodeSoftware />);
        const fleet=await screen.findByRole('region',{name:'Node software fleet'});
        expect(await within(fleet).findAllByText('Request prepared')).not.toHaveLength(0);
        // Both the display clock and intent request polling use this interval.
        await act(async()=>{await Promise.resolve();});
        expect(ticks.length).toBeGreaterThanOrEqual(2);
        authoritative={...prepared,status:'claimed'};
        await act(async()=>{for(const tick of [...ticks])tick();await Promise.resolve();});
        await waitFor(()=>expect(within(fleet).getAllByText('Operator reconciliation needed').length)
            .toBeGreaterThanOrEqual(1));
        fireEvent.change(within(fleet).getByRole('combobox',{name:'Show Nodes'}),
            {target:{value:'review'}});
        expect(within(fleet).getByText('1 of 1 Nodes')).toBeInTheDocument();
        authoritative={...prepared,status:'reconciled'};
        await act(async()=>{for(const tick of [...ticks])tick();await Promise.resolve();});
        await waitFor(()=>expect(within(fleet).getByText('0 of 1 Nodes')).toBeInTheDocument());
        expect(within(fleet).queryByRole('button',{name:/Review host/})).not.toBeInTheDocument();
        fireEvent.change(within(fleet).getByRole('combobox',{name:'Show Nodes'}),
            {target:{value:'all'}});
        expect(within(fleet).getAllByText('Operator acknowledged').length).toBeGreaterThanOrEqual(1);
        expect(within(fleet).queryByText(/Operator reconciliation required/)).not.toBeInTheDocument();
        expect(within(fleet).getAllByText('Not recorded').length).toBeGreaterThanOrEqual(1);
        expect(vi.mocked(callTool).mock.calls.filter(([name])=>
            name==='list_node_update_intents').length).toBeGreaterThanOrEqual(3);
    } finally {
        spy.mockRestore();
    }
});

it('fleet expires prepared requests at the deadline without a network refresh or button click', async () => {
    const nodeId='11111111-1111-4111-8111-111111111111';
    const node={id:nodeId,name:'Expiring host',platform:'linux',status:'online',
        version:'1.9.9',capabilities:[],lastSeen:null,hostedWorkspaceCount:0};
    const request:NodeUpdateIntent={id:'22222222-2222-4222-8222-222222222222',
        nodeId,installedVersion:'1.9.9',targetVersion:'2.0.0',
        targetCommit:'abc123abc123',status:'requested',approved:false,executable:false,
        createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1_000).toISOString()};
    vi.mocked(callTool).mockImplementation(async name => {
        if(name==='list_nodes')return [node];
        if(name==='list_node_update_intents')return [request];
        if(name==='list_node_releases')return {state:'ready',checkedAt:'',releases:[release]};
        throw new Error('Unexpected tool '+name);
    });
    render(<NodeSoftware />);
    const fleet=await screen.findByRole('region',{name:'Node software fleet'});
    expect((await within(fleet).findAllByText('Request prepared')).length).toBeGreaterThanOrEqual(1);
    expect((await within(fleet).findAllByText('Request expired',{},{
        timeout:2_500,
    })).length).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(callTool).mock.calls.filter(([name])=>
        name==='list_node_update_intents')).toHaveLength(1);
},5_000);

it('fleet inspector follows new node deep links while the software route remains mounted', async () => {
    const first='11111111-1111-4111-8111-111111111111';
    const second='22222222-2222-4222-8222-222222222222';
    const nodes=[first,second].map((id,index)=>({id,name:index===0?'First host':'Second host',
        platform:'darwin',status:'online',version:'2.0.0',capabilities:[],
        lastSeen:null,hostedWorkspaceCount:0}));
    const oldHash=window.location.hash;
    vi.mocked(callTool).mockImplementation(async name => {
        if(name==='list_nodes')return nodes;
        if(name==='list_node_releases')return {state:'ready',checkedAt:'',releases:[]};
        throw new Error('Unexpected tool '+name);
    });
    try {
        window.location.hash='#/nodes/software?node='+first;
        render(<NodeSoftware />);
        const detail=await screen.findByRole('region',{name:'Selected Node software details'});
        expect(within(detail).getByRole('heading',{name:'First host'})).toBeInTheDocument();
        await act(async()=>{
            window.location.hash='#/nodes/software?node='+second;
            window.dispatchEvent(new Event('hashchange'));
        });
        expect(within(detail).getByRole('heading',{name:'Second host'})).toBeInTheDocument();
        expect(within(detail).getByRole('link',{name:/Open Node details/}))
            .toHaveAttribute('href','#/nodes?node='+second);
        await act(async()=>{
            window.location.hash='#/nodes/software?node='+first;
            window.dispatchEvent(new Event('hashchange'));
        });
        expect(within(detail).getByRole('heading',{name:'First host'})).toBeInTheDocument();
    } finally {
        window.location.hash=oldHash;
        window.dispatchEvent(new Event('hashchange'));
    }
});


it('cancels obsolete Linux history reads across Refresh and unmount without exceeding three active requests', async () => {
    const nodes = Array.from({length:5},(_,index)=>({
        id:'11111111-1111-4111-8111-'+String(index+1).padStart(12,'0'),
        name:'Slow Linux '+index,platform:'linux',status:'online',version:'2.0.0',
        capabilities:[],lastSeen:null,hostedWorkspaceCount:0,
    }));
    const signals: AbortSignal[]=[];
    let active=0;
    let peak=0;
    let aborted=0;
    vi.mocked(callTool).mockImplementation(async (name,_args,signal)=>{
        if(name==='list_nodes')return nodes;
        if(name==='list_node_releases')return {state:'ready',releases:[release],checkedAt:''};
        if(name==='list_node_update_intents'){
            if(!signal)throw new Error('History reads must have a cancellation signal.');
            if(signal.aborted)throw new DOMException('Aborted','AbortError');
            signals.push(signal);
            return await new Promise<never>((_resolve,reject)=>{
                active++;
                peak=Math.max(peak,active);
                signal.addEventListener('abort',()=>{
                    active--;
                    aborted++;
                    reject(new DOMException('Aborted','AbortError'));
                },{once:true});
            });
        }
        throw new Error('Unexpected tool '+name);
    });
    const view=render(<NodeSoftware />);
    try {
        await waitFor(()=>expect(signals).toHaveLength(3));
        expect(active).toBe(3);
        const old=signals.slice();
        fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
        await waitFor(()=>expect(signals).toHaveLength(6));
        expect(old.every(signal=>signal.aborted)).toBe(true);
        expect(aborted).toBe(3);
        expect(active).toBe(3);
        expect(peak).toBe(3);
        await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh'})).toBeEnabled());
        fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
        await waitFor(()=>expect(signals).toHaveLength(9));
        expect(signals.slice(3,6).every(signal=>signal.aborted)).toBe(true);
        expect(peak).toBe(3);
        expect(active).toBe(3);
    } finally {
        view.unmount();
    }
    expect(signals.every(signal=>signal.aborted)).toBe(true);
    expect(active).toBe(0);
    expect(aborted).toBe(9);
});
