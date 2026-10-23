import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
