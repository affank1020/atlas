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

test('Workspaces browse independent directories across Nodes and follow deep links', async () => {
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    expect(await within(browser).findByText('Atlas')).toBeInTheDocument();
    expect(within(browser).getAllByText(/checkout/).length).toBeGreaterThan(0);
    fireEvent.click(within(browser).getByRole('button', { name: /Atlas/ }));
    expect(location.hash).toContain('workspace=repo');
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
    expect(await within(inspector).findByText('atlas/feature')).toBeInTheDocument();
    expect(within(inspector).getByText('example/atlas')).toBeInTheDocument();
    expect(within(inspector).getByRole('button', { name: 'Push feature branch to GitHub' })).toBeEnabled();
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('workspace_git_status', {
        checkoutId: repo.id,
    }));
    expect(callTool).toHaveBeenCalledWith('workspace_git_list_worktrees', {
        checkoutId: repo.id,
    });
    // The human-facing ?workspace= deep link stays stable, but the API always
    // selects the physical checkout, never a logical Workspace ID.
    expect(vi.mocked(callTool).mock.calls.filter(([name]) => ['workspace_git_status',
        'workspace_git_list_worktrees'].includes(name)).every(([, input]) =>
        !(input as any)?.workspaceId && !!(input as any)?.checkoutId)).toBe(true);
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
    fireEvent.click(await within(browser).findByRole('button', { name: /Atlas/ }));
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
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
    fireEvent.click(await within(browser).findByRole('button', { name: /Atlas/ }));
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
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
    expect(await within(browser).findByText('1 Workspace')).toBeInTheDocument();
    expect(within(browser).getAllByText('Portfolio Site')).toHaveLength(1);
    expect(within(browser).getByText('2 checkouts across 2 Nodes')).toBeInTheDocument();
    fireEvent.click(within(browser).getByRole('button', { name: 'Portfolio Site' }));
    expect(location.hash).toContain('workspace=logical-portfolio');
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
    expect(await within(inspector).findAllByText(/affank1020\/portfolio-site/)).not.toHaveLength(0);
    expect(within(inspector).getByRole('group', { name: 'Choose Node checkout' })).toBeInTheDocument();
    fireEvent.click(within(browser).getByRole('button', { name: /Checkout on MacBook/ }));
    expect(location.hash).toContain('workspace=mac');
    fireEvent.click(within(browser).getByRole('button', { name: /Checkout on Linux VPS/ }));
    expect(location.hash).toContain('workspace=vps');
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('workspace_git_status', { checkoutId: 'vps' }));
    expect(callTool).not.toHaveBeenCalledWith('workspace_git_status', { checkoutId: 'logical-portfolio' });
    fireEvent.change(within(browser).getByLabelText('Node'), { target: { value: 'mac-node' } });
    expect(within(browser).getByText('1 checkout across 1 Node')).toBeInTheDocument();
});

test('multiple worktrees on one Node have distinct labels and a compact checkout selector', async () => {
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
    expect(await within(browser).findByText('1 Workspace')).toBeInTheDocument();
    expect(within(browser).getByText('4 checkouts across 1 Node')).toBeInTheDocument();
    expect(browser.querySelectorAll('.wm-node-heading')).toHaveLength(1);
    expect(within(browser).getByText('4 checkouts')).toBeInTheDocument();
    expect(within(browser).getByText('API cleanup')).toBeInTheDocument();
    expect(within(browser).getByText('Node setup')).toBeInTheDocument();

    fireEvent.click(within(browser).getByRole('button', { name: 'Atlas' }));
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
    const selector = within(inspector).getByRole('combobox', { name: 'Choose checkout' });
    expect(within(selector).getAllByRole('option')).toHaveLength(4);
    fireEvent.change(selector, { target: { value: 'feature-b' } });
    expect(location.hash).toContain('workspace=feature-b');
    expect(within(inspector).getByText('Node setup')).toBeInTheDocument();
    expect(within(inspector).getByText('/srv/atlas/node-setup')).toBeInTheDocument();
});

test('duplicate checkout names on the same Node have unique full-path selector options', async () => {
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
    await within(browser).findByText('1 Workspace');
    fireEvent.click(within(browser).getByRole('button', { name: 'Atlas' }));
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
    const selector = within(inspector).getByRole('combobox', { name: 'Choose checkout' });
    expect(within(selector).getByRole('option', {
        name: 'Atlas · Linux VPS · /srv/atlas/workspaces/atlas-a',
    })).toHaveValue('clone-a');
    expect(within(selector).getByRole('option', {
        name: 'Atlas · Linux VPS · /srv/atlas/workspaces/atlas-b',
    })).toHaveValue('clone-b');
    const optionNames = within(selector).getAllByRole('option').map(option => option.textContent);
    expect(new Set(optionNames).size).toBe(optionNames.length);
    fireEvent.change(selector, { target: { value: 'clone-b' } });
    expect(location.hash).toContain('workspace=clone-b');
    expect(within(inspector).getAllByText('/srv/atlas/workspaces/atlas-b').length).toBeGreaterThan(0);
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
    await within(browser).findByText('1 Workspace');
    fireEvent.click(within(browser).getByRole('button', { name: 'Atlas' }));
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
    const group = within(inspector).getByRole('group', { name: 'Choose Node checkout' });
    expect(within(group).getByRole('button', { name: /\/srv\/atlas\/workspaces\/atlas-a/ })).toBeInTheDocument();
    const second = within(group).getByRole('button', { name: /\/srv\/atlas\/workspaces\/atlas-b/ });
    expect(second).toBeInTheDocument();
    fireEvent.click(second);
    expect(location.hash).toContain('workspace=clone-b');
    expect(within(inspector).getAllByText('/srv/atlas/workspaces/atlas-b').length).toBeGreaterThan(0);
});

test('logical Workspace Project associations are shared, selectable and removable without checkout changes', async () => {
    const projectA = { id: 'project-a', name: 'Portfolio' };
    const projectB = { id: 'project-b', name: 'Deployment' };
    const checkouts = [
        { ...repo, id: 'mac', nodeId: 'mac-node', name: 'Portfolio Site', rootPath: '/mac/portfolio' },
        { ...repo, id: 'linux', name: 'Portfolio Site VPS', rootPath: '/srv/portfolio' },
    ];
    const macNode = { ...node, id: 'mac-node', name: 'MacBook' };
    let projectIds = [projectA.id];
    vi.mocked(callTool).mockImplementation(async (name, args: any) => {
        if (name === 'list_nodes') return [node,macNode];
        if (name === 'list_projects') return [projectA,projectB];
        if (name === 'list_workspaces') return checkouts;
        if (name === 'list_logical_workspaces') return [{
            id: 'logical-portfolio', name: 'Portfolio Site', repository: 'affank1020/portfolio-site',
            kind: 'git', projectIds: [...projectIds], checkouts,
        }];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: true, branch: 'main',
            head: sha, originRepository: 'affank1020/portfolio-site', dirty: false };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        if (name === 'link_logical_workspace_project') {
            projectIds = [...projectIds,args.projectId];
            return {};
        }
        if (name === 'unlink_logical_workspace_project') {
            projectIds = projectIds.filter(id => id !== args.projectId);
            return {};
        }
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    await within(browser).findByText('1 Workspace');
    fireEvent.click(within(browser).getByRole('button', { name: 'Portfolio Site' }));
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
    const section = within(inspector).getByRole('region', { name: 'Workspace Projects' });
    expect(within(section).getByText('Portfolio')).toBeInTheDocument();
    fireEvent.change(within(section).getByRole('combobox', { name: 'Project to associate' }), {
        target: { value: projectB.id },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Associate' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('link_logical_workspace_project', {
        logicalWorkspaceId: 'logical-portfolio', projectId: projectB.id,
    }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Workspace Projects' }))
        .getByRole('button', { name: 'Detach Deployment' })).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole('region', { name: 'Workspace Projects' }))
        .getByRole('button', { name: 'Detach Portfolio' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('unlink_logical_workspace_project', {
        logicalWorkspaceId: 'logical-portfolio', projectId: projectA.id,
    }));
    await waitFor(() => expect(within(section).queryByRole('button', { name: 'Detach Portfolio' })).not.toBeInTheDocument());
    // Project mutations do not alter checkout selection or the two registered paths.
    expect(checkouts.map(w => w.rootPath)).toEqual(['/mac/portfolio','/srv/portfolio']);
    expect(location.hash).toContain('workspace=logical-portfolio');
});

test('archived linked Projects remain named and detachable but are not link targets', async () => {
    const archived = { id: 'archived-project', name: 'Old Portfolio', archivedAt: '2026-10-20T12:00:00Z' };
    const active = { id: 'active-project', name: 'Current Portfolio' };
    let linked = [archived.id];
    vi.mocked(callTool).mockImplementation(async (name, args: any) => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_projects') return [archived, active];
        if (name === 'list_workspaces') return [repo];
        if (name === 'list_logical_workspaces') return [{
            id: 'logical-atlas', name: 'Atlas', repository: 'affank1020/atlas',
            kind: 'git', projectIds: [...linked], checkouts: [repo],
        }];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: true, branch: 'main',
            head: sha, originRepository: 'affank1020/atlas', dirty: false };
        if (name === 'workspace_git_list_worktrees') return { worktrees: [] };
        if (name === 'unlink_logical_workspace_project') {
            linked = linked.filter(id => id !== args.projectId);
            return {};
        }
        return {};
    });
    render(<Workspaces />);
    const browser = screen.getByRole('region', { name: 'Workspace browser' });
    await within(browser).findByText('1 Workspace');
    fireEvent.click(within(browser).getByRole('button', { name: 'Atlas' }));
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
    const section = within(inspector).getByRole('region', { name: 'Workspace Projects' });
    expect(await within(section).findByText('Old Portfolio (archived)')).toBeInTheDocument();
    const linkOptions = within(within(section).getByRole('combobox', { name: 'Project to associate' }))
        .getAllByRole('option').map(item => item.textContent);
    expect(linkOptions).toContain('Current Portfolio');
    expect(linkOptions).not.toContain('Old Portfolio');
    expect(callTool).toHaveBeenCalledWith('list_projects', { includeArchived: true });
    fireEvent.click(within(section).getByRole('button', { name: 'Detach Old Portfolio' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('unlink_logical_workspace_project', {
        logicalWorkspaceId: 'logical-atlas', projectId: archived.id,
    }));
    await waitFor(() => expect(within(section).queryByRole('button', { name: 'Detach Old Portfolio' }))
        .not.toBeInTheDocument());
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
    await screen.findByText('1 Workspace');
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
    await screen.findByText('2 Workspaces');
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
    await screen.findByText('3 Workspaces');
    fireEvent.click(screen.getByRole('button', { name: /Atlas/ }));
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
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

test('initial loading shows four Workspace skeleton rows and a deep-link inspector placeholder', async () => {
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
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
    expect(browser).toHaveAttribute('aria-busy', 'true');
    expect(browser.querySelectorAll('.wm-row-skeleton')).toHaveLength(4);
    expect(inspector.querySelector('.wm-inspector-skeleton')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading Nodes and Workspaces');

    workspaces.resolve([manager, repo]);
    expect(await within(browser).findByText('Atlas')).toBeInTheDocument();
    await waitFor(() => expect(browser.querySelectorAll('.wm-row-skeleton')).toHaveLength(0));
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
    expect(await screen.findByText('2 Workspaces')).toBeInTheDocument();
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
    await screen.findByText('2 Workspaces');
    fireEvent.click(screen.getByRole('button', { name: /Atlas/ }));
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
    expect(inspector.querySelector('.wm-git-skeleton')).toBeInTheDocument();
    expect(inspector.querySelector('.wm-trees-skeleton')).toBeInTheDocument();
    expect(inspector).toHaveAttribute('aria-busy', 'true');

    firstGit.resolve({ available: true, branch: 'atlas/feature', head: sha, dirty: false, originRepository: 'example/atlas' });
    firstTrees.resolve({ worktrees: [{ rootPath: repo.rootPath, head: sha, branch: 'atlas/feature' }] });
    expect((await within(inspector).findAllByText('atlas/feature')).length).toBeGreaterThan(0);
    await waitFor(() => expect(inspector.querySelector('.wm-git-skeleton')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(inspections).toBe(2));
    expect(within(inspector).getAllByText('atlas/feature').length).toBeGreaterThan(0);
    expect(inspector.querySelector('.wm-git-skeleton')).not.toBeInTheDocument();
    expect(screen.getByText('2 Workspaces')).toBeInTheDocument();
    expect(screen.queryByText('Loading Nodes and Workspaces…')).not.toBeInTheDocument();

    refreshGit.resolve({ available: true, branch: 'atlas/feature', head: sha, dirty: false, originRepository: 'example/atlas' });
    refreshTrees.resolve({ worktrees: [{ rootPath: repo.rootPath, head: sha, branch: 'atlas/feature' }] });
    await waitFor(() => expect(inspector).toHaveAttribute('aria-busy', 'false'));
});
