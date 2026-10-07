import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspacePanel } from './WorkspacePanel';
const api = vi.hoisted(() => ({ callTool: vi.fn() }));
vi.mock('./api', () => api);
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const workspace = { id: 'workspace', nodeId: 'host-node', name: 'AI Football', rootPath: '/Projects/Football', kind: 'unity', adapter: 'unity' };
it('shows Git and Unity health and loads a read-only preview', async () => {
    api.callTool.mockImplementation(async (name: string) => {
        if (name === 'get_node') return { id: 'host-node', name: 'Development Mac', status: 'online', capabilities: ['workspace.files', 'workspace.git', 'unity'] };
        if (name === 'list_project_workspaces') return [workspace];
        if (name === 'workspace_list_dev_tasks') return [];
        if (name === 'workspace_git_status') return { available: true, branch: 'main', dirty: true, changes: [{ path: 'Agent.cs', status: ' M' }] };
        if (name === 'unity_list_commands') return { available: false, state: 'pipeline_not_configured', message: 'Pipeline is missing.', commands: [{ name: 'editor_play', approved: true, description: 'Starts Play Mode', inputSchema: {} }, { name: 'console', approved: false, description: 'Reads console', inputSchema: {} }] };
        if (name === 'workspace_list_files') return { entries: [{ path: 'Agent.cs', type: 'file' }], truncated: false };
        if (name === 'workspace_read_file') return { path: 'Agent.cs', text: 'class Agent {}' };
    });
    render(<WorkspacePanel projectId="project" />);
    expect(await screen.findByText('AI Football')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Development Mac' })).toHaveAttribute('href', '#/nodes');
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(await screen.findByText('main · Uncommitted changes')).toBeInTheDocument();
    expect(screen.getByText('Pipeline is missing.')).toBeInTheDocument();
    const commandList = screen.getByText('Unity commands (2)').closest('details');
    expect(commandList).not.toHaveAttribute('open');
    expect(screen.getByText('editor_play · Approved')).not.toBeVisible();
    fireEvent.click(screen.getByText('Unity commands (2)'));
    expect(commandList).toHaveAttribute('open');
    expect(screen.getByText('editor_play · Approved')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Agent.cs' }));
    expect(await screen.findByText('class Agent {}')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(api.callTool.mock.calls.filter(x => x[0] === 'list_project_workspaces')).toHaveLength(2));
});
it('binds using the existing tools and reports allow-list errors', async () => {
    api.callTool.mockImplementation(async (name: string) => { if (name === 'list_project_workspaces') return []; throw new Error('Workspace is outside ATLAS_WORKSPACE_ROOTS.'); });
    render(<WorkspacePanel projectId="project" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bind workspace' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Repo' } });
    fireEvent.change(screen.getByLabelText('Local root'), { target: { value: '/Projects/Repo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bind workspace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ATLAS_WORKSPACE_ROOTS');
    expect(api.callTool).toHaveBeenCalledWith('create_workspace', { projectId: 'project', name: 'Repo', rootPath: '/Projects/Repo', kind: 'generic' });
});
it('does not access archived projects', () => {
    render(<WorkspacePanel projectId="project" archived />);
    expect(screen.getByText('This project is archived. Workspace access is disabled.')).toBeInTheDocument();
    expect(api.callTool).not.toHaveBeenCalled();
});

it('runs an owner-configured task and shows structured failure output', async () => {
    api.callTool.mockImplementation(async (name: string) => {
        if (name === 'list_project_workspaces') return [workspace];
        if (name === 'get_node') return { id: 'host-node', name: 'Development Mac', status: 'online', capabilities: ['workspace.dev'] };
        if (name === 'workspace_list_dev_tasks') return [{ task: 'test', command: 'npm test', timeoutMs: 120000 }];
        if (name === 'workspace_git_status') return { available: false };
        if (name === 'workspace_list_files') return { entries: [], truncated: false };
        if (name === 'unity_list_commands') return { available: false, state: 'no_adapter' };
        if (name === 'workspace_run_dev_task') return { task: 'test', success: false, exitCode: 1, timedOut: false, durationMs: 4200, stdout: '', stderr: '3 tests failed', stdoutTruncated: false, stderrTruncated: false };
    });
    render(<WorkspacePanel projectId="project" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run test' }));
    expect(await screen.findByText('test · Failed · 4.2s')).toBeInTheDocument();
    expect(screen.getByText('Errors')).toBeInTheDocument();
    expect(api.callTool).toHaveBeenCalledWith('workspace_run_dev_task', { projectId: 'project', workspaceId: 'workspace', task: 'test' });
});
