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
    expect(await within(screen.getByRole('complementary', { name: 'Workspace details' }))
        .findByText(/affank1020\/portfolio-site/)).toBeInTheDocument();
    fireEvent.click(within(browser).getByRole('button', { name: /Checkout on MacBook/ }));
    expect(location.hash).toContain('workspace=mac');
    fireEvent.click(within(browser).getByRole('button', { name: /Checkout on Linux VPS/ }));
    expect(location.hash).toContain('workspace=vps');
    fireEvent.change(within(browser).getByLabelText('Node'), { target: { value: 'mac-node' } });
    expect(within(browser).getByText('1 checkout across 1 Node')).toBeInTheDocument();
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
        workspaceId: 'mac',
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
        workspaceId: 'root', repository: 'example/atlas', directoryName: 'atlas',
    }));
});

test('provenance-protected retirement uses Workspace IDs and expected commit, never a caller-provided path', async () => {
    const feature = { ...repo, id: 'feature', name: 'Feature', rootPath: '/srv/atlas/workspaces/atlas-feature' };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [node];
        if (name === 'list_workspaces') return [manager, repo, feature];
        if (name === 'list_github_repositories') return { repositories: [] };
        if (name === 'workspace_git_status') return { available: true, branch: 'main', head: sha, dirty: false, originRepository: 'example/atlas' };
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
    fireEvent.click(await within(inspector).findByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('workspace_git_remove_worktree', {
        workspaceId: 'repo', targetWorkspaceId: 'feature', expectedHead: sha,
    }));
    expect(vi.mocked(confirm)).toHaveBeenCalledWith(expect.stringContaining('DELETEs the local checkout folder'));
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
