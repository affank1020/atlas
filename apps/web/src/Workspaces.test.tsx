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
    expect(within(browser).getAllByText(/Independent/).length).toBeGreaterThan(0);
    fireEvent.click(within(browser).getByRole('button', { name: /Atlas/ }));
    expect(location.hash).toContain('workspace=repo');
    const inspector = screen.getByRole('complementary', { name: 'Workspace details' });
    expect(await within(inspector).findByText('atlas/feature')).toBeInTheDocument();
    expect(within(inspector).getByText('example/atlas')).toBeInTheDocument();
    expect(within(inspector).getByRole('button', { name: 'Push feature branch to GitHub' })).toBeEnabled();
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
