import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Provider } from 'react-redux';
import { createAtlasStore } from './store';
import { callTool } from './api';
import { WorkspaceHome, WorkspaceLibrary, InfrastructureNav } from './Workspace';
import { readRecentWork, rememberWork, clearRecentWork } from './recentWork';
vi.mock('./api', () => ({ API_BASE: 'http://localhost:3000', callTool: vi.fn(), onToolMutation: vi.fn(() => () => {}) }));
const projects = [{ id: 'p', name: 'Research' }, { id: 'q', name: 'Writing' }];
beforeEach(() => { sessionStorage.clear(); vi.mocked(callTool).mockReset(); vi.mocked(callTool).mockImplementation(async (name, input) => {
    if (name === 'list_projects') return projects;
    if (name === 'list_views') return [{ id: 'v', projectId: input?.projectId, name: 'Reading list', slug: 'reading' }];
    if (name === 'list_stores') return [{ id: 's', projectId: input?.projectId, name: 'Notes' }];
    if (name === 'get_atlas_status') return { version: '2.0', storage: 'Postgres' };
    return [];
}); });
test('library only loads the selected collection and reuses it when revisited', async () => {
    const { store } = createAtlasStore();
    render(<Provider store={store}><WorkspaceLibrary kind="views" /></Provider>);
    expect(await screen.findByRole('link', { name: /Reading list/ })).toHaveAttribute('href', 'http://localhost:3000/projects/p/views/reading');
    expect(callTool).not.toHaveBeenCalledWith('list_stores', expect.anything(), expect.anything());
    fireEvent.click(screen.getByRole('link', { name: /Reading list/ }));
    expect(readRecentWork()[0]).toMatchObject({ name: 'Reading list', kind: 'View' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'q' } });
    await waitFor(() => expect(screen.getByRole('link', { name: /Reading list/ })).toHaveAttribute('href', 'http://localhost:3000/projects/q/views/reading'));
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p' } });
    await waitFor(() => expect(screen.getByRole('link', { name: /Reading list/ })).toHaveAttribute('href', 'http://localhost:3000/projects/p/views/reading'));
    expect(vi.mocked(callTool).mock.calls.filter(([name]) => name === 'list_views')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'missing' } });
    expect(screen.getByText('No matches. Try another search.')).toBeInTheDocument();
});
test('Home shows genuine recent work and clears it without losing projects', async () => {
    rememberWork({ href: '#/projects/p', name: 'Research', projectId: 'p', kind: 'Project' });
    const { store } = createAtlasStore();
    render(<Provider store={store}><WorkspaceHome /></Provider>);
    expect(await screen.findByText('Project', { selector: '.recent-item small' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeDisabled());
    clearRecentWork();
    await screen.findByText('Open a project or View and find it here next time.');
    expect(screen.getByRole('link', { name: /Research/ })).toHaveAttribute('href', '#/projects/p');
});
test('recent work tolerates invalid storage and remains bounded and deduplicated', () => {
    sessionStorage.setItem('atlas.recent-work.v1', '{}'); expect(readRecentWork()).toEqual([]);
    for (let i = 0; i < 12; i++) rememberWork({ href: `#/projects/${i}`, name: String(i), projectId: String(i), kind: 'Project' });
    expect(readRecentWork()).toHaveLength(8);
    rememberWork(readRecentWork()[3]); expect(readRecentWork()).toHaveLength(8);
});
test('infrastructure retains existing operational deep links', () => {
    render(<InfrastructureNav page="nodes" />);
    expect(screen.getByRole('link', { name: 'Nodes' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Developer' })).toHaveAttribute('href', '#/fabric');
    expect(screen.getByRole('link', { name: 'Activity' })).toHaveAttribute('href', '#/activity');
});

afterEach(() => cleanup());
