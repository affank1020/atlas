import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Workspaces } from './Workspaces';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn(), IS_MOCK_MODE: false }));
const node = { id: 'node', name: 'Linux VPS', status: 'online', platform: 'linux',
    capabilities: ['workspace.files', 'workspace.git'], hostedWorkspaceCount: 2, lastSeen: null };
const manager = { id: 'root', nodeId: 'node', projectId: null, name: 'Development root',
    rootPath: '/srv/atlas/workspaces', kind: 'generic', status: 'active' };
const repo = { id: 'repo', nodeId: 'node', projectId: null, name: 'Atlas',
    rootPath: '/srv/atlas/workspaces/atlas', kind: 'generic', status: 'active' };
const sha = 'a'.repeat(40);

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => { resolve = res; });
    return { promise, resolve };
}

beforeEach(() => {
    location.hash = '/workspaces';
    vi.mocked(callTool).mockReset().mockImplementation(async (name) => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [manager, repo];
        if (name === 'list_github_repositories') return { repositories: [
            { repository: 'example/atlas', private: true, defaultBranch: 'main', archived: false },
        ] };
        if (name === 'workspace_git_status') return { available: true, branch: 'atlas/feature',
            head: sha, dirty: false, originRepository: 'example/atlas' };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        return {};
    });
});
afterEach(() => { cleanup(); location.hash = ''; });
/** Navigate the Workspace rail, then open one physical Node checkout. */
function openWorkspaceCheckout(browser: HTMLElement, workspaceName: string, path?: string) {
    const scope = within(browser);
    fireEvent.click(scope.getByRole('button', { name: 'Browse ' + workspaceName }));
    const buttons = scope.getAllByRole('button', { name: /^Checkout on / });
    const target = path ? buttons.find(button => button.getAttribute('aria-label')?.endsWith(' at ' + path)) : buttons[0];
    if (!target) throw new Error('Missing checkout ' + (path || 'for ' + workspaceName));
    fireEvent.click(target);
}


test('Workspaces browse independent directories across Nodes and follow deep links', async () => {
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    expect(await within(browser).findByRole('button', { name: 'Browse Atlas' })).toBeInTheDocument();
    expect(within(browser).getAllByText(/checkout/).length).toBeGreaterThan(0);
    openWorkspaceCheckout(browser, 'Atlas');
    expect(location.hash).toBe('#/workspaces?group=repo');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    expect(await within(inspector).findByText('atlas/feature')).toBeInTheDocument();
    fireEvent.click(within(inspector).getByText('Git details'));
    expect(within(inspector).getByText('example/atlas')).toBeInTheDocument();
    expect(within(inspector).queryByRole('button', { name: 'Push feature branch to GitHub' })).not.toBeInTheDocument();
    fireEvent.click(within(inspector).getByText('Git actions'));
    expect(await within(inspector).findByRole('button', { name: 'Push feature branch to GitHub' })).toBeEnabled();
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('workspace_git_status', {
        checkoutId: repo.id,
    }));
    expect(callTool).toHaveBeenCalledWith('workspace_git_list_worktrees', {
        checkoutId: repo.id,
    });
    // Checkout selection is transient; existing ?workspace= deep links remain
    // readable, but Node operations always use the physical checkout ID.
    expect(vi.mocked(callTool).mock.calls.filter(([name]) => ['workspace_git_status',
        'workspace_git_list_worktrees'].includes(name)).every(([, input]) =>
        !(input as any)?.workspaceId && !!(input as any)?.checkoutId)).toBe(true);
});

test('opening, switching and closing checkouts never navigate or mount hidden Git forms', async () => {
    const second = { ...repo, id: 'second', name: 'Atlas feature', rootPath: '/srv/atlas/feature' };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [repo, second];
        if (name === 'list_logical_workspaces') return [{
            id: 'atlas-logical', name: 'Atlas', repository: 'example/atlas',
            kind: 'git', checkouts: [repo, second],
        }];
        if (name === 'workspace_git_status') return {
            available: true, branch: 'atlas/feature', head: sha, dirty: false,
            originRepository: 'example/atlas',
        };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    await within(browser).findByRole('button', { name: 'Browse Atlas' });
    fireEvent.click(within(browser).getByRole('button', { name: 'Browse Atlas' }));
    const workspaceUrl = location.href;
    const first = within(browser).getByRole('button', {
        name: 'Checkout on Linux VPS at /srv/atlas/workspaces/atlas',
    });
    const next = within(browser).getByRole('button', {
        name: 'Checkout on Linux VPS at /srv/atlas/feature',
    });
    fireEvent.click(first);
    expect(location.href).toBe(workspaceUrl);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    const inline = within(browser).getByRole('region', { name: 'Checkout details' });
    expect(within(inline).getByText('Git actions')).toBeInTheDocument();
    expect(within(inline).queryByRole('button', { name: 'Create worktree' })).not.toBeInTheDocument();
    await within(inline).findByText('atlas/feature');
    fireEvent.click(within(inline).getByText('Git actions'));
    expect(await within(inline).findByRole('button', { name: 'Create worktree' })).toBeInTheDocument();
    fireEvent.click(next);
    expect(location.href).toBe(workspaceUrl);
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(next).toHaveAttribute('aria-expanded', 'true');
    const secondDetails = within(browser).getByRole('region', { name: 'Checkout details' });
    expect(within(secondDetails).getByText('Git actions').closest('details')).not.toHaveAttribute('open');
    expect(secondDetails.querySelector('button[type="submit"]')).not.toBeInTheDocument();
    fireEvent.click(next);
    expect(location.href).toBe(workspaceUrl);
    expect(next).toHaveAttribute('aria-expanded', 'false');
    expect(within(browser).queryByRole('region', { name: 'Checkout details' })).not.toBeInTheDocument();
    // The same checkout must reopen with no hidden Git forms in its DOM.
    fireEvent.click(first);
    const reopened = within(browser).getByRole('region', { name: 'Checkout details' });
    expect(within(reopened).getByText('Git actions').closest('details')).not.toHaveAttribute('open');
    expect(reopened.querySelector('form')).not.toBeInTheDocument();
    fireEvent.click(first);

    // Legacy deep links still open the right checkout on navigation, but a
    // subsequent interaction clears their stale URL selection without navigating.
    location.hash = '/workspaces?workspace=repo';
    fireEvent(window, new Event('hashchange'));
    await waitFor(() => expect(first).toHaveAttribute('aria-expanded', 'true'));
    fireEvent.click(next);
    expect(location.hash).toBe('#/workspaces?group=atlas-logical');
    expect(next).toHaveAttribute('aria-expanded', 'true');
});

test('publishing and creating feature worktrees use the selected checkoutId', async () => {
    vi.mocked(callTool).mockImplementation(async (name) => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [manager, repo];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: true, branch: 'atlas/feature',
            head: sha, dirty: false, originRepository: 'example/atlas' };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        if (name === 'workspace_git_create_worktree') return {
            workspace: { ...repo, id: 'new-checkout' }, head: sha, branch: 'atlas/feature-x',
        };
        if (name === 'workspace_git_open_pull_request') return {
            number: 42, url: 'https://github.com/example/atlas/pull/42', draft: true,
        };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    await within(browser).findByRole('button', { name: 'Browse Atlas' });
    openWorkspaceCheckout(browser, 'Atlas');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    await within(inspector).findByText('atlas/feature');
    fireEvent.click(within(inspector).getByText('Git actions'));
    const push = await within(inspector).findByRole('button', { name: 'Push feature branch to GitHub' });
    fireEvent.click(push);
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('workspace_git_push_branch', {
        checkoutId: repo.id, repository: 'example/atlas', branch: 'atlas/feature', expectedHead: sha,
    }));
    // The form requires a nonempty title before the button can be enabled.
    // Populate it first, then wait for the post-push checkout refresh.
    fireEvent.change(within(inspector).getByLabelText('Pull request title'), {
        target: { value: 'Finish checkout selector migration' },
    });
    await waitFor(() => expect(within(inspector).getByRole('button', { name: 'Open draft PR' })).toBeEnabled());
    fireEvent.click(within(inspector).getByRole('button', { name: 'Open draft PR' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('workspace_git_open_pull_request', {
        checkoutId: repo.id, repository: 'example/atlas', branch: 'atlas/feature',
        expectedHead: sha, title: 'Finish checkout selector migration', body: '',
    }));
    fireEvent.change(within(inspector).getByLabelText('Branch'), {
        target: { value: 'atlas/feature-x' },
    });
    fireEvent.change(within(inspector).getByLabelText('Destination on Node'), {
        target: { value: '/srv/atlas/workspaces/atlas-feature-x' },
    });
    await waitFor(() => expect(within(inspector).getByRole('button', { name: 'Create worktree' })).toBeEnabled());
    fireEvent.click(within(inspector).getByRole('button', { name: 'Create worktree' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('workspace_git_create_worktree', {
        checkoutId: repo.id, branch: 'atlas/feature-x',
        targetPath: '/srv/atlas/workspaces/atlas-feature-x',
    }));
});

test('retirement requires successful read-only preflight before enabling deletion', async () => {
    const feature = { ...repo, id: 'feature', name: 'Temporary worktree',
        rootPath: '/srv/atlas/workspaces/temp-feature' };
    let eligible = false;
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [repo, feature];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: true, branch: 'main',
            head: sha, dirty: false, originRepository: 'affank1020/atlas' };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [
            { rootPath: repo.rootPath, branch: 'main', head: sha },
            { rootPath: feature.rootPath, branch: 'atlas/feature', head: sha },
        ] };
        if (name === 'workspace_git_retirement_preflight')
            return eligible ? { eligible: true, estimatedReclaimedBytes: 4096,
                mergedPullRequest: { number: 42, url: 'https://github.com/affank1020/atlas/pull/42' } }
                : { eligible: false, reason: 'No merged PR' };
        if (name === 'workspace_git_remove_worktree')
            return { removed: true, estimatedReclaimedBytes: 4096 };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    await within(browser).findByRole('button', { name: 'Browse Atlas' });
    openWorkspaceCheckout(browser, 'Atlas');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    await within(inspector).findByText('main');
    fireEvent.click(within(inspector).getByText('Git actions'));
    const check = await within(inspector).findByRole('button', { name: 'Check eligibility' });
    expect(within(inspector).queryByRole('button', { name: 'Retire' })).not.toBeInTheDocument();
    fireEvent.click(check);
    expect(await within(inspector).findByText(/Not ready: No merged PR/)).toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'workspace_git_remove_worktree')).toBe(false);

    eligible = true;
    fireEvent.click(check);
    expect(await within(inspector).findByText(/Ready · merged PR #42/)).toBeInTheDocument();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
        fireEvent.click(within(inspector).getByRole('button', { name: 'Retire' }));
        await waitFor(() => expect(vi.mocked(callTool).mock.calls.some(([name, input]) =>
            name === 'workspace_git_remove_worktree' &&
            (input as any).checkoutId === repo.id &&
            (input as any).targetCheckoutId === feature.id &&
            (input as any).expectedHead === sha)).toBe(true));
    } finally { confirm.mockRestore(); }
});

test('logical repository appears once while Mac and VPS checkouts remain selectable', async () => {
    const mac = { ...repo, id: 'mac', nodeId: 'mac-node', name: 'Portfolio Site', rootPath: '/mac/portfolio' };
    const vps = { ...repo, id: 'vps', name: 'Portfolio Site (VPS)', rootPath: '/srv/portfolio' };
    const macNode = { ...node, id: 'mac-node', name: 'MacBook' };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node, macNode];
        if (name === 'list_workspaces') return [mac, vps];
        if (name === 'list_logical_workspaces') return [{
            id: 'logical-portfolio', name: 'Portfolio Site',
            repository: 'affank1020/portfolio-site', kind: 'git', checkouts: [mac, vps],
        }];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: true, branch: 'main', head: sha,
            originRepository: 'affank1020/portfolio-site', dirty: false };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    expect(await screen.findByText('1 workspace')).toBeInTheDocument();
    expect(within(browser).getByRole('button', { name: 'Browse Portfolio Site' })).toBeInTheDocument();
    expect(within(browser).getByText('2 checkouts across 2 Nodes')).toBeInTheDocument();
    // Two Node lanes are visible without expanding a nested list.
    expect(within(browser).getByRole('region', { name: 'Checkouts on MacBook' })).toBeInTheDocument();
    expect(within(browser).getByRole('region', { name: 'Checkouts on Linux VPS' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Checkout details' })).not.toBeInTheDocument();
    openWorkspaceCheckout(browser, 'Portfolio Site', '/mac/portfolio');
    expect(location.hash).toBe('#/workspaces?group=logical-portfolio');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    expect(within(browser).getAllByText('affank1020/portfolio-site').length).toBeGreaterThan(0);
    expect(within(inspector).queryByRole('group', { name: 'Choose Node checkout' })).not.toBeInTheDocument();
    fireEvent.click(within(browser).getByRole('button', { name: /Checkout on Linux VPS/ }));
    expect(location.hash).toBe('#/workspaces?group=logical-portfolio');
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('workspace_git_status', { checkoutId: 'vps' }));
    expect(callTool).not.toHaveBeenCalledWith('workspace_git_status', { checkoutId: 'logical-portfolio' });
    fireEvent.change(screen.getByLabelText('Node'), { target: { value: 'mac-node' } });
    expect(within(browser).getByText('1 checkout across 1 Node')).toBeInTheDocument();
});

test('Node filter selects the matching physical checkout instead of the logical first checkout', async () => {
    const mac = { ...repo, id: 'mac-checkout', nodeId: 'mac-node', name: 'Portfolio Site',
        rootPath: '/mac/portfolio' };
    const linux = { ...repo, id: 'linux-checkout', nodeId: node.id,
        name: 'Portfolio Site (VPS)', rootPath: '/srv/portfolio' };
    const macNode = { ...node, id: 'mac-node', name: 'MacBook' };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [macNode, node];
        if (name === 'list_workspaces') return [mac, linux];
        if (name === 'list_logical_workspaces') return [{
            id: 'logical-portfolio', name: 'Portfolio Site',
            repository: 'example/portfolio', kind: 'git', checkouts: [mac, linux],
        }];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return {
            available: true, branch: 'main', head: sha,
            originRepository: 'example/portfolio', dirty: false,
        };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    expect(await screen.findByText('1 workspace')).toBeInTheDocument();
    fireEvent.click(within(browser).getByRole('button', { name: 'Browse Portfolio Site' }));
    expect(location.hash).toContain('group=logical-portfolio');
    // A Node filter narrows the visible checkout list without silently
    // inspecting a checkout from a different Node.
    fireEvent.change(screen.getByLabelText('Node'), { target: { value: node.id } });
    expect(within(browser).getByText('1 checkout across 1 Node')).toBeInTheDocument();
    expect(within(browser).queryByRole('button', { name: /Checkout on MacBook/ })).not.toBeInTheDocument();
    fireEvent.click(within(browser).getByRole('button', { name: /Checkout on Linux VPS/ }));
    expect(location.hash).toBe('#/workspaces?group=logical-portfolio');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    expect(within(browser).getByRole('button', { name: 'Checkout on Linux VPS at /srv/portfolio' })).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('workspace_git_status', {
        checkoutId: linux.id,
    }));
    fireEvent.change(screen.getByLabelText('Node'), { target: { value: macNode.id } });
    fireEvent.click(within(browser).getByRole('button', { name: /Checkout on MacBook/ }));
    expect(location.hash).toBe('#/workspaces?group=logical-portfolio');
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('workspace_git_status', {
        checkoutId: mac.id,
    }));
});

test('repository-first navigation stays compact, searchable, and filterable', async () => {
    const macNode = { ...node, id: 'mac-node', name: 'MacBook' };
    const checkouts = [
        { ...repo, id: 'main', nodeId: 'mac-node', rootPath: '/mac/atlas' },
        { ...repo, id: 'feature', nodeId: 'mac-node', name: 'Feature UI', rootPath: '/mac/atlas-feature' },
    ];
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node, macNode];
        if (name === 'list_workspaces') return [manager, ...checkouts];
        if (name === 'list_logical_workspaces') return [
            { id: 'atlas-group', name: 'Atlas', repository: 'example/atlas', kind: 'git', checkouts },
            { id: 'local-group', name: 'Development root', repository: null, kind: 'local', checkouts: [manager] },
        ];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: true, branch: 'main', head: sha,
            originRepository: 'example/atlas', dirty: false };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    expect(await screen.findByText('2 workspaces')).toBeInTheDocument();
    const searchControl = screen.getByRole('searchbox', { name: 'Search workspaces' });
    const toolbar = searchControl.closest('.catalogue-toolbar');
    expect(toolbar).not.toBeNull();
    expect(browser.contains(toolbar)).toBe(false);
    expect(within(toolbar as HTMLElement).getByLabelText('Node')).toBeInTheDocument();
    expect(within(toolbar as HTMLElement).getByLabelText('Type')).toBeInTheDocument();
    expect(screen.queryByText('Mock preview · write operations are disabled.')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Checkout details' })).not.toBeInTheDocument();
    expect(within(browser).getByText('Checkouts')).toBeInTheDocument();
    expect(within(browser).queryByText(/\d+ online/)).not.toBeInTheDocument();
    expect(within(browser).getAllByRole('button', { name: /^Browse (Atlas|Development root)$/ })).toHaveLength(2);
    expect(within(browser).getByRole('region', { name: 'Checkouts on MacBook' })).toBeInTheDocument();
    expect(within(browser).getAllByRole('button', { name: /^Checkout on / })).toHaveLength(2);
    // Browsing different logical Workspaces does not inspect Git automatically.
    fireEvent.click(within(browser).getByRole('button', { name: 'Browse Development root' }));
    expect(location.hash).toContain('group=local-group');
    expect(within(browser).getByRole('region', { name: 'Checkouts on Linux VPS' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Checkout details' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search workspaces'), { target: { value: 'Feature UI' } });
    expect(screen.getByText('1 workspace')).toBeInTheDocument();
    expect(within(browser).getByText('Feature UI')).toBeInTheDocument();
    expect(within(browser).getAllByRole('button', { name: /^Checkout on / })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search workspaces'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'local' } });
    expect(screen.getByText('1 workspace')).toBeInTheDocument();
    expect(within(browser).getByRole('button', { name: 'Browse Development root' })).toBeInTheDocument();
    expect(within(browser).queryByRole('button', { name: 'Browse Atlas' })).not.toBeInTheDocument();
    openWorkspaceCheckout(browser, 'Development root');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    expect(inspector).toBeInTheDocument();
    // The selected checkout expands in place, without adding a third column.
    expect(inspector.parentElement).toHaveClass('wm-explorer-checkout-entry');
    expect(within(browser).getByRole('button', { name: /Checkout on Linux VPS at \/srv\/atlas\/workspaces/ })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(browser).getByRole('button', { name: /Checkout on Linux VPS at \/srv\/atlas\/workspaces/ }));
    expect(screen.queryByRole('region', { name: 'Checkout details' })).not.toBeInTheDocument();
});

test('multiple worktrees on one Node expand checkout details without hiding siblings', async () => {
    const checkouts = [
        { ...repo, rootPath: '/srv/atlas/atlas' },
        { ...repo, id: 'feature-a', name: 'API cleanup', rootPath: '/srv/atlas/api-cleanup' },
        { ...repo, id: 'feature-b', name: 'Node setup', rootPath: '/srv/atlas/node-setup' },
        { ...repo, id: 'feature-c', name: 'UI polish', rootPath: '/srv/atlas/ui-polish' },
    ];
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return checkouts;
        if (name === 'list_logical_workspaces') return [{
            id: 'atlas-logical', name: 'Atlas', repository: 'affank1020/atlas',
            kind: 'git', checkouts,
        }];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: true, branch: 'main', head: sha,
            originRepository: 'affank1020/atlas', dirty: false };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    expect(await screen.findByText('1 workspace')).toBeInTheDocument();
    expect(within(browser).getByText('4 checkouts across 1 Node')).toBeInTheDocument();
    expect(within(browser).getByRole('region', { name: 'Checkouts on Linux VPS' })).toBeInTheDocument();
    expect(within(browser).getAllByRole('button', { name: /^Checkout on / })).toHaveLength(4);
    expect(within(browser).getByText('API cleanup')).toBeInTheDocument();
    expect(within(browser).getByText('Node setup')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Checkout details' })).not.toBeInTheDocument();
    openWorkspaceCheckout(browser, 'Atlas');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    expect(within(browser).getAllByRole('button', { name: /^Checkout on / })).toHaveLength(4);
    fireEvent.click(within(browser).getByRole('button', { name: /Checkout on Linux VPS at \/srv\/atlas\/node-setup/ }));
    expect(location.hash).toBe('#/workspaces?group=atlas-logical');
    expect(within(browser).getByRole('button', { name: 'Checkout on Linux VPS at /srv/atlas/node-setup' })).toHaveAttribute('aria-expanded', 'true');
});

test('duplicate checkout names on the same Node remain distinguishable by full path', async () => {
    const checkouts = [
        { ...repo, id: 'clone-a', rootPath: '/srv/atlas/workspaces/atlas-a' },
        { ...repo, id: 'clone-b', rootPath: '/srv/atlas/workspaces/atlas-b' },
        { ...repo, id: 'feature-a', name: 'Feature A', rootPath: '/srv/atlas/workspaces/feature-a' },
        { ...repo, id: 'feature-b', name: 'Feature B', rootPath: '/srv/atlas/workspaces/feature-b' },
    ];
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return checkouts;
        if (name === 'list_logical_workspaces') return [{
            id: 'atlas-logical', name: 'Atlas', repository: 'affank1020/atlas',
            kind: 'git', checkouts,
        }];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: true, branch: 'main', head: sha,
            originRepository: 'affank1020/atlas', dirty: false };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    await screen.findByText('1 workspace');
    openWorkspaceCheckout(browser, 'Atlas');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    const checkoutButtons = within(browser).getAllByRole('button', { name: /^Checkout on / });
    expect(checkoutButtons).toHaveLength(4);
    expect(checkoutButtons.map(button => button.getAttribute('aria-label'))).toContain(
        'Checkout on Linux VPS at /srv/atlas/workspaces/atlas-a');
    expect(checkoutButtons.map(button => button.getAttribute('aria-label'))).toContain(
        'Checkout on Linux VPS at /srv/atlas/workspaces/atlas-b');
    fireEvent.click(within(browser).getByRole('button', { name: /Checkout on Linux VPS at \/srv\/atlas\/workspaces\/atlas-b/ }));
    expect(location.hash).toBe('#/workspaces?group=atlas-logical');
    expect(within(browser).getByRole('button', { name: 'Checkout on Linux VPS at /srv/atlas/workspaces/atlas-b' })).toHaveAttribute('aria-expanded', 'true');
});

test('duplicate names in a small checkout group show both directory paths before selection', async () => {
    const checkouts = [
        { ...repo, id: 'clone-a', rootPath: '/srv/atlas/workspaces/atlas-a' },
        { ...repo, id: 'clone-b', rootPath: '/srv/atlas/workspaces/atlas-b' },
    ];
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return checkouts;
        if (name === 'list_logical_workspaces') return [{
            id: 'atlas-logical', name: 'Atlas', repository: 'affank1020/atlas',
            kind: 'git', checkouts,
        }];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: true, branch: 'main', head: sha,
            originRepository: 'affank1020/atlas', dirty: false };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    await screen.findByText('1 workspace');
    openWorkspaceCheckout(browser, 'Atlas');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    expect(within(browser).getByRole('button', { name: /Checkout on Linux VPS at \/srv\/atlas\/workspaces\/atlas-a/ })).toBeInTheDocument();
    const second = within(browser).getByRole('button', { name: /Checkout on Linux VPS at \/srv\/atlas\/workspaces\/atlas-b/ });
    expect(second).toBeInTheDocument();
    fireEvent.click(second);
    expect(location.hash).toBe('#/workspaces?group=atlas-logical');
    expect(within(browser).getByRole('button', { name: 'Checkout on Linux VPS at /srv/atlas/workspaces/atlas-b' })).toHaveAttribute('aria-expanded', 'true');
});

test('Workspace explorer stays focused on checkouts and activity, without Project associations', async () => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [repo];
        if (name === 'list_logical_workspaces') return [{
            id: 'logical-atlas', name: 'Atlas', repository: 'example/atlas',
            kind: 'git', projectIds: ['project-a'], checkouts: [repo],
        }];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: true, branch: 'main',
            head: sha, originRepository: 'example/atlas', dirty: false };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    await within(browser).findByRole('button', { name: 'Browse Atlas' });
    expect(within(browser).getByRole('region', { name: 'Checkouts on Linux VPS' })).toBeInTheDocument();
    expect(within(browser).getByRole('region', { name: 'Workspace activity' })).toBeInTheDocument();
    expect(within(browser).queryByRole('region', { name: 'Workspace Projects' })).not.toBeInTheDocument();
    expect(within(browser).queryByRole('button', { name: /Detach/ })).not.toBeInTheDocument();
    expect(within(browser).queryByRole('combobox', { name: 'Project to associate' })).not.toBeInTheDocument();
    expect(callTool).not.toHaveBeenCalledWith('list_projects', expect.anything());
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'list_projects')).toBe(false);
});

test('repository recognition uses Node Git inspection and never sends caller-chosen identity', async () => {
    const mac = { ...repo, id: 'mac', nodeId: 'mac-node', rootPath: '/mac/portfolio' };
    const macNode = { ...node, id: 'mac-node', name: 'MacBook' };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [macNode];
        if (name === 'list_workspaces') return [mac];
        if (name === 'list_logical_workspaces') return [{
            id: 'local', name: 'Portfolio Site', repository: null, kind: 'local', checkouts: [mac],
        }];
        if (name === 'workspace_git_status') return {
            available: true, originRepository: 'affank1020/portfolio-site',
        };
        if (name === 'list_github_repositories') return { repositories: [] };
        return {};
    });
    render(<Workspaces />);
    await screen.findByText('1 workspace');
    expect(screen.queryByRole('button', { name: 'Recognise repositories' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect(screen.getByText(/Unlike Refresh, this updates Workspace associations/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recognise repositories' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('attach_checkout_repository', {
        checkoutId: 'mac',
    }));
    expect(await screen.findByText(/Recognised 1 verified checkout/)).toBeInTheDocument();
});

test('provisioning requires a registered development root and uses brokered server tools', async () => {
    vi.mocked(callTool).mockImplementation(async (name) => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [manager, repo];
        if (name === 'list_github_repositories') return { repositories: [{ repository: 'example/atlas', private: true, defaultBranch: 'main', archived: false }] };
        if (name === 'workspace_git_clone_repository') return { workspace: { ...repo, id: 'new-repo' }, branch: 'main', head: sha };
        return { available: false, worktrees: [] };
    });
    render(<Workspaces />);
    await screen.findByText('2 workspaces');
    fireEvent.click(screen.getByRole('button', { name: '+ Add repository' }));
    const region = screen.getByRole('region', { name: 'Provision repository' });
    const submit = within(region).getByRole('button', { name: 'Clone' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(region).getByLabelText('Registered development directory'), { target: { value: 'root' } });
    fireEvent.change(within(region).getByLabelText('Authorised GitHub repository'), { target: { value: 'example/atlas' } });
    expect(within(region).getByLabelText('Directory name')).toHaveValue('atlas');
    fireEvent.click(submit);
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('workspace_git_clone_repository', {
        checkoutId: 'root', repository: 'example/atlas', directoryName: 'atlas',
    }));
});

test('provenance-protected retirement uses explicit checkout IDs and expected commit, never a caller-provided path', async () => {
    const feature = { ...repo, id: 'feature', name: 'Feature', rootPath: '/srv/atlas/workspaces/atlas-feature' };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [manager, repo, feature];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: true, branch: 'main', head: sha, dirty: false, originRepository: 'example/atlas' };
        if (name === 'workspace_git_retirement_preflight') return { eligible: true, estimatedReclaimedBytes: 1048576, mergedPullRequest: { number: 42, url: 'https://github.com/affank1020/atlas/pull/42' } };
        if (name === 'workspace_git_remove_worktree') return { removed: true, estimatedReclaimedBytes: 1048576 };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [
            { rootPath: repo.rootPath, branch: 'main', head: sha },
            { rootPath: feature.rootPath, branch: 'atlas/feature', head: sha },
        ] };
        return {};
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<Workspaces />);
    await screen.findByText('3 workspaces');
    openWorkspaceCheckout(screen.getByRole('region', { name: 'Workspace browser' }), 'Atlas');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    await within(inspector).findByText('main');
    fireEvent.click(within(inspector).getByText('Git actions'));
    fireEvent.click(await within(inspector).findByRole('button', { name: 'Check eligibility' }));
    fireEvent.click(await within(inspector).findByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('workspace_git_remove_worktree', {
        checkoutId: 'repo', targetCheckoutId: 'feature', expectedHead: sha,
    }));
    expect(callTool).toHaveBeenCalledWith('workspace_git_retirement_preflight', {
        checkoutId: 'repo', targetCheckoutId: 'feature', expectedHead: sha,
    });
    for (const [name, input] of vi.mocked(callTool).mock.calls) {
        if (!['workspace_git_retirement_preflight', 'workspace_git_remove_worktree'].includes(name)) continue;
        expect(input).not.toHaveProperty('workspaceId');
        expect(input).not.toHaveProperty('targetWorkspaceId');
        expect(input).not.toHaveProperty('targetPath');
    }
    expect(vi.mocked(confirm)).toHaveBeenCalledWith(expect.stringContaining('Retire Feature?'));
    expect(await screen.findByText(/estimated reclaimed/)).toBeInTheDocument();
    vi.unstubAllGlobals();
});

test('initial loading shows Workspace rail skeletons and a deep-link inspector placeholder', async () => {
    const workspaces = deferred<(typeof repo)[]>();
    location.hash = '/workspaces?workspace=repo';
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return workspaces.promise;
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: false };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    // The skeleton deliberately lives below an aria-hidden placeholder.
    const inspector = browser.querySelector('.wm-inspector-skeleton');
    expect(browser).toHaveAttribute('aria-busy', 'true');
    expect(browser.querySelectorAll('.wm-explorer-nav-skeleton')).toHaveLength(5);
    expect(inspector).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading Nodes and Workspaces');

    workspaces.resolve([manager, repo]);
    expect(await within(browser).findByRole('button', { name: 'Browse Atlas' })).toBeInTheDocument();
    await waitFor(() => expect(browser.querySelectorAll('.wm-explorer-nav-skeleton')).toHaveLength(0));
    expect(browser).toHaveAttribute('aria-busy', 'false');
});

test('a slow GitHub catalogue does not delay Workspace browsing', async () => {
    const catalogue = deferred<{ repositories: { repository: string; private: boolean; defaultBranch: string; archived: boolean }[] }>();
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [manager, repo];
        if (name === 'list_github_repositories') return catalogue.promise;
        return {};
    });
    render(<Workspaces />);
    expect(await screen.findByText('2 workspaces')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ Add repository' }));
    const region = screen.getByRole('region', { name: 'Provision repository' });
    expect(within(region).getByRole('option', { name: 'Loading repositories…' })).toBeInTheDocument();
    catalogue.resolve({ repositories: [{ repository: 'example/atlas', private: true, defaultBranch: 'main', archived: false }] });
    expect(await within(region).findByRole('option', { name: 'example/atlas · Private' })).toBeInTheDocument();
});

test('Git inspection has skeletons and refresh keeps existing checkout details visible', async () => {
    const firstGit = deferred<{ available: boolean; branch: string; head: string; dirty: boolean; originRepository: string }>();
    const firstTrees = deferred<{ worktrees: { rootPath: string; head: string; branch: string }[] }>();
    const refreshGit = deferred<{ available: boolean; branch: string; head: string; dirty: boolean; originRepository: string }>();
    const refreshTrees = deferred<{ worktrees: { rootPath: string; head: string; branch: string }[] }>();
    let inspections = 0;
    let treeInspections = 0;
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [manager, repo];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return ++inspections === 1 ? firstGit.promise : refreshGit.promise;
        if (name === 'workspace_git_list_worktrees') return ++treeInspections === 1 ? firstTrees.promise : refreshTrees.promise;
        return {};
    });
    render(<Workspaces />);
    await screen.findByText('2 workspaces');
    openWorkspaceCheckout(screen.getByRole('region', { name: 'Workspace browser' }), 'Atlas');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    // Only the two visible summary rows count; collapsed Git details also
    // contain their own skeletons, intentionally hidden in the disclosure.
    expect(inspector.querySelectorAll(':scope > .wm-git .wm-skeleton-git')).toHaveLength(2);
    expect(within(inspector).getByText('Branch')).toBeInTheDocument();
    expect(within(inspector).getByText('Working tree')).toBeInTheDocument();
    const gitDetails = within(inspector).getByText('Git details');
    const gitActions = within(inspector).getByText('Git actions');
    expect(inspector).toHaveAttribute('aria-busy', 'true');

    firstGit.resolve({ available: true, branch: 'atlas/feature', head: sha, dirty: false, originRepository: 'example/atlas' });
    firstTrees.resolve({ worktrees: [{ rootPath: repo.rootPath, head: sha, branch: 'atlas/feature' }] });
    expect((await within(inspector).findAllByText('atlas/feature')).length).toBeGreaterThan(0);
    await waitFor(() => expect(inspector.querySelector('.wm-git .wm-skeleton-git')).not.toBeInTheDocument());
    expect(within(inspector).getByText('Git details')).toBe(gitDetails);
    expect(within(inspector).getByText('Git actions')).toBe(gitActions);
    expect(inspector.querySelectorAll(':scope > .wm-git > div')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(inspections).toBe(2));
    expect(within(inspector).getAllByText('atlas/feature').length).toBeGreaterThan(0);
    expect(inspector.querySelector('.wm-git .wm-skeleton-git')).not.toBeInTheDocument();
    expect(screen.getByText('2 workspaces')).toBeInTheDocument();
    expect(screen.queryByText('Loading Nodes and Workspaces…')).not.toBeInTheDocument();

    refreshGit.resolve({ available: true, branch: 'atlas/feature', head: sha, dirty: false, originRepository: 'example/atlas' });
    refreshTrees.resolve({ worktrees: [{ rootPath: repo.rootPath, head: sha, branch: 'atlas/feature' }] });
    await waitFor(() => expect(inspector).toHaveAttribute('aria-busy', 'false'));
});

test('logical Workspace navigation offers group-wide and selected-checkout Activity scopes', async () => {
    const logicalWorkspaceId = '11111111-1111-4111-8111-111111111111';
    const source = { ...repo, id: 'first-checkout' };
    const sibling = { ...repo, id: 'second-checkout', rootPath: '/srv/atlas/workspaces/atlas-feature' };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [manager, source, sibling];
        if (name === 'list_logical_workspaces') return [{ id: logicalWorkspaceId,
            name: 'Atlas repository', repository: 'example/atlas', kind: 'git',
            projectIds: [], checkouts: [source, sibling] }];
        if (name === 'workspace_git_status') return { available: true, branch: 'main', head: sha,
            dirty: false, originRepository: 'example/atlas' };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        if (name === 'list_github_repositories') return { repositories: [] };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    await within(browser).findByRole('button', { name: 'Browse Atlas repository' });
    openWorkspaceCheckout(browser, 'Atlas repository');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    expect(await within(browser).findByRole('link', { name: 'All Workspace activity' }))
        .toHaveAttribute('href', '#/monitoring?tab=activity&logicalWorkspaceId=' + logicalWorkspaceId);
    expect(within(inspector).getByRole('link', { name: 'Checkout activity' }))
        .toHaveAttribute('href', '#/monitoring?tab=activity&checkoutId=first-checkout');
});

test('Workspace explorer loads one on-demand preview and switches between logical and checkout scopes', async () => {
    const groupId = '11111111-1111-4111-8111-111111111111';
    const first = { ...repo, id: 'first-checkout' };
    const second = { ...repo, id: 'second-checkout', rootPath: '/srv/atlas/workspaces/atlas-feature' };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [manager, first, second];
        if (name === 'list_logical_workspaces') return [{
            id: groupId, name: 'Atlas repository', repository: 'example/atlas',
            kind: 'git', projectIds: [], checkouts: [first, second],
        }];
        if (name === 'workspace_git_status') return { available: true, branch: 'main', head: sha };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'query_monitoring_activity') return { items: [], total: 0, offset: 0, limit: 5 };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    await within(browser).findByRole('button', { name: 'Browse Atlas repository' });
    openWorkspaceCheckout(browser, 'Atlas repository');
    const preview = within(browser).getByRole('region', { name: 'Workspace activity preview' });
    expect(within(preview).getByRole('button', { name: 'Show recent activity' })).toHaveAttribute('aria-expanded', 'false');
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'query_monitoring_activity')).toBe(false);

    fireEvent.click(within(preview).getByRole('button', { name: 'Show recent activity' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('query_monitoring_activity', {
        logicalWorkspaceId: groupId, offset: 0, limit: 5, groupOperations: true, safeDetails: true,
    }, expect.any(AbortSignal)));
    expect(within(preview).getByRole('link', { name: 'View all activity →' })).toHaveAttribute('href',
        '#/monitoring?tab=activity&logicalWorkspaceId=' + groupId);
    fireEvent.change(within(preview).getByRole('combobox', { name: 'Activity preview scope' }),
        { target: { value: 'checkout' } });
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('query_monitoring_activity', {
        checkoutId: first.id, offset: 0, limit: 5, groupOperations: true, safeDetails: true,
    }, expect.any(AbortSignal)));
    const firstSignal = vi.mocked(callTool).mock.calls.find(([name, input]) =>
        name === 'query_monitoring_activity' && input?.checkoutId === first.id)?.[2];
    fireEvent.click(within(browser).getByRole('button', { name: /Checkout on Linux VPS at \/srv\/atlas\/workspaces\/atlas-feature/ }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('query_monitoring_activity', {
        checkoutId: second.id, offset: 0, limit: 5, groupOperations: true, safeDetails: true,
    }, expect.any(AbortSignal)));
    expect(firstSignal?.aborted).toBe(true);
    fireEvent.click(within(preview).getByRole('button', { name: 'Hide recent activity' }));
    expect(within(preview).queryByRole('link', { name: 'View all activity →' })).not.toBeInTheDocument();
});

test('legacy Workspace browser exposes a selected checkout Activity preview without logical IDs', async () => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [manager, repo];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: false };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        if (name === 'query_monitoring_activity') return { items: [], total: 0, offset: 0, limit: 5 };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    await within(browser).findByRole('button', { name: 'Browse Atlas' });
    openWorkspaceCheckout(browser, 'Atlas');
    const preview = screen.getByRole('region', { name: 'Workspace activity preview' });
    fireEvent.click(within(preview).getByRole('button', { name: 'Show recent activity' }));
    expect(within(preview).queryByRole('combobox', { name: 'Activity preview scope' })).not.toBeInTheDocument();
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('query_monitoring_activity', {
        checkoutId: repo.id, offset: 0, limit: 5, groupOperations: true, safeDetails: true,
    }, expect.any(AbortSignal)));
});

test('Workspace activity survives checkout close but resets across Workspace navigation', async () => {
    const groupA = '11111111-1111-4111-8111-111111111111';
    const groupB = '22222222-2222-4222-8222-222222222222';
    const checkoutA = { ...repo, id: 'checkout-a' };
    const checkoutB = { ...repo, id: 'checkout-b', name: 'Benchmark',
        rootPath: '/srv/atlas/workspaces/benchmark' };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [checkoutA, checkoutB];
        if (name === 'list_logical_workspaces') return [
            { id: groupA, name: 'Atlas repository', repository: 'example/atlas',
                kind: 'git', projectIds: [], checkouts: [checkoutA] },
            { id: groupB, name: 'Benchmark repository', repository: 'example/benchmark',
                kind: 'git', projectIds: [], checkouts: [checkoutB] },
        ];
        if (name === 'workspace_git_status') return { available: true, branch: 'main', head: sha };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'query_monitoring_activity') return { items: [], total: 0, offset: 0, limit: 5 };
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    const preview = () => screen.getByRole('region', { name: 'Workspace activity preview' });
    const activityCalls = () => vi.mocked(callTool).mock.calls.filter(([name]) => name === 'query_monitoring_activity');
    const assertCollapsed = () => {
        expect(within(preview()).getByRole('button', { name: 'Show recent activity' }))
            .toHaveAttribute('aria-expanded', 'false');
        expect(within(preview()).queryByRole('combobox', { name: 'Activity preview scope' }))
            .not.toBeInTheDocument();
        expect(within(preview()).queryByRole('link', { name: 'View all activity →' }))
            .not.toBeInTheDocument();
    };

    await within(browser).findByRole('button', { name: 'Browse Atlas repository' });
    openWorkspaceCheckout(browser, 'Atlas repository');
    fireEvent.click(within(preview()).getByRole('button', { name: 'Show recent activity' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('query_monitoring_activity', {
        logicalWorkspaceId: groupA, offset: 0, limit: 5, groupOperations: true, safeDetails: true,
    }, expect.any(AbortSignal)));
    fireEvent.change(within(preview()).getByRole('combobox', { name: 'Activity preview scope' }),
        { target: { value: 'checkout' } });
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('query_monitoring_activity', {
        checkoutId: checkoutA.id, offset: 0, limit: 5, groupOperations: true, safeDetails: true,
    }, expect.any(AbortSignal)));
    expect(activityCalls()).toHaveLength(2);

    // A (expanded in checkout mode) → B (never expanded) → A. Neither
    // transition may automatically fetch or revive A's previous expansion.
    openWorkspaceCheckout(browser, 'Benchmark repository');
    assertCollapsed();
    expect(activityCalls()).toHaveLength(2);
    openWorkspaceCheckout(browser, 'Atlas repository');
    assertCollapsed();
    expect(activityCalls()).toHaveLength(2);

    // Reopening A is explicit and starts in its default logical scope.
    fireEvent.click(within(preview()).getByRole('button', { name: 'Show recent activity' }));
    await waitFor(() => expect(activityCalls()).toHaveLength(3));
    expect(within(preview()).getByRole('combobox', { name: 'Activity preview scope' }))
        .toHaveValue('logical');
    expect(activityCalls()[2]?.[1]).toMatchObject({ logicalWorkspaceId: groupA });

    // Collapsing checkout details keeps the Workspace-wide activity panel intact.
    fireEvent.click(within(browser).getByRole('button', { name: /Checkout on Linux VPS at \/srv\/atlas\/workspaces\/atlas/ }));
    expect(screen.queryByRole('region', { name: 'Checkout details' })).not.toBeInTheDocument();
    expect(within(preview()).getByRole('button', { name: 'Hide recent activity' })).toHaveAttribute('aria-expanded', 'true');
    expect(activityCalls()).toHaveLength(3);

    // Hash-driven navigation changes Workspace identity and clears activity state.
    location.hash = '/workspaces?workspace=' + checkoutB.id;
    fireEvent(window, new Event('hashchange'));
    await waitFor(() => expect(within(browser).getByRole('button', { name: 'Checkout on Linux VPS at /srv/atlas/workspaces/benchmark' }))
        .toHaveAttribute('aria-expanded', 'true'));
    assertCollapsed();
    location.hash = '/workspaces?workspace=' + checkoutA.id;
    fireEvent(window, new Event('hashchange'));
    await waitFor(() => expect(within(browser).getByRole('button', { name: 'Checkout on Linux VPS at /srv/atlas/workspaces/atlas' }))
        .toHaveAttribute('aria-expanded', 'true'));
    assertCollapsed();
    expect(activityCalls()).toHaveLength(3);

    // B only fetches when explicitly expanded.
    openWorkspaceCheckout(browser, 'Benchmark repository');
    fireEvent.click(within(preview()).getByRole('button', { name: 'Show recent activity' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('query_monitoring_activity', {
        logicalWorkspaceId: groupB, offset: 0, limit: 5, groupOperations: true, safeDetails: true,
    }, expect.any(AbortSignal)));
    expect(activityCalls()).toHaveLength(4);
});

test('Git actions use compact inspector placeholders until Git inspection resolves', async () => {
    const status = deferred<{
        available: boolean; branch: string; head: string; dirty: boolean; originRepository: string;
    }>();
    const original = vi.mocked(callTool).getMockImplementation();
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        if (name === 'workspace_git_status') return await status.promise as never;
        return original!(name, input) as never;
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    await within(browser).findByRole('button', { name: 'Browse Atlas' });
    openWorkspaceCheckout(browser, 'Atlas');
    const inspector = screen.getByRole('region', { name: 'Checkout details' });
    fireEvent.click(within(inspector).getByText('Git actions'));
    expect(await within(inspector).findByRole('status', { name: 'Loading Git actions' })).toHaveAttribute('aria-busy', 'true');
    expect(within(inspector).queryByRole('button', { name: 'Create worktree' })).not.toBeInTheDocument();
    status.resolve({ available: true, branch: 'atlas/feature', head: sha,
        dirty: false, originRepository: 'example/atlas' });
    expect(await within(inspector).findByRole('button', { name: 'Create worktree' })).toBeInTheDocument();
    expect(within(inspector).queryByRole('status', { name: 'Loading Git actions' })).not.toBeInTheDocument();
});
