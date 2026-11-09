import { Provider } from 'react-redux';
import { createAtlasStore } from './store';
import type { ReactElement, ReactNode } from 'react';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApplicationsDirectory } from './ApplicationsDirectory';
import { callTool } from './api';
import { readRecentWork } from './recentWork';

vi.mock('./api', () => ({ IS_MOCK_MODE: false, callTool: vi.fn(), onToolMutation: () => () => {} }));
const apps = [
    { type: 'portfolio', slug: 'portfolio', name: 'Portfolio', description: 'Publish content', projectId: 'project-one' },
    { type: 'football-training', slug: 'football-training', name: 'Football Training', description: 'Run evaluations', projectId: 'project-two' },
    { type: 'notes', slug: 'notes', name: 'Notes', description: 'Personal notes', projectId: null },
];
const projects = [
    { id: 'project-one', name: 'Launchpad' },
    { id: 'project-two', name: 'University' },
];
const projectViews = {
    'project-one': [
        { id: 'view-one', projectId: 'project-one', slug: 'career-dashboard', name: 'Career Dashboard', description: 'Applications overview' },
        { id: 'view-archived', projectId: 'project-one', name: 'Old Dashboard', archivedAt: '2026-01-01T00:00:00Z' },
    ],
    'project-two': [
        { id: 'view-two', projectId: 'project-two', name: 'Markov Notes', description: 'Coursework summary' },
    ],
};
const render = (element: ReactElement) => {
    const { store } = createAtlasStore();
    return rtlRender(element, { wrapper: ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider> });
};

beforeEach(() => {
    vi.resetAllMocks();
    sessionStorage.clear();
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        if (name === 'list_all_applications') return apps as never;
        if (name === 'list_projects') return projects as never;
        if (name === 'list_views') return (projectViews[input.projectId as keyof typeof projectViews] ?? []) as never;
        throw new Error('Unexpected tool ' + name);
    });
});
afterEach(cleanup);

test('lists applications from all projects with launch links and a single registry read', async () => {
    render(<ApplicationsDirectory />);
    const portfolio = await screen.findByRole('link', { name: 'Launch Portfolio' });
    const football = screen.getByRole('link', { name: 'Launch Football Training' });
    expect(portfolio).toHaveAttribute('href', '#/projects/project-one/applications/portfolio');
    expect(football).toHaveAttribute('href', '#/projects/project-two/applications/football-training');
    expect(portfolio).not.toHaveAttribute('target');
    expect(portfolio).not.toHaveAttribute('rel');
    expect(football).not.toHaveAttribute('target');
    expect(callTool).toHaveBeenCalledWith('list_all_applications', {}, expect.any(AbortSignal));
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'list_applications')).toBe(false);
    expect(vi.mocked(callTool).mock.calls.filter(([name]) => name === 'list_all_applications')).toHaveLength(1);
    expect(screen.queryByRole('combobox', { name: /project/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Research')).not.toBeInTheDocument();
});

test('search narrows the directory without changing registrations', async () => {
    render(<ApplicationsDirectory />);
    await screen.findByRole('link', { name: 'Launch Portfolio' });
    const search = screen.getByRole('searchbox', { name: 'Search applications' });
    expect(search.closest('.browse-toolbar')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'FOOTBALL' } });
    expect(search).toHaveValue('FOOTBALL');
    expect(screen.queryByRole('link', { name: 'Launch Portfolio' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Launch Football Training' })).toBeInTheDocument();
    expect(screen.getByText('1 application')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'publish' } });
    expect(screen.getByRole('link', { name: 'Launch Portfolio' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Launch Football Training' })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });
    expect(search).toHaveValue('');
    expect(screen.getByText('3 applications')).toBeInTheDocument();
});

test('standalone applications use project-independent URLs and remember launch history', async () => {
    render(<ApplicationsDirectory />);
    const notes = await screen.findByRole('link', { name: 'Launch Notes' });
    expect(notes).toHaveAttribute('href', '#/applications/notes');
    expect(notes).not.toHaveAttribute('target');
    fireEvent.click(notes);
    expect(readRecentWork()[0]).toMatchObject({ href: '#/applications/notes', projectId: null, kind: 'Application' });
});

test('an unavailable catalogue is an error, not an empty app list', async () => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_projects') return [] as never;
        throw new Error('Catalogue unavailable');
    });
    render(<ApplicationsDirectory />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn\'t load applications');
    expect(screen.queryByText('No applications are registered yet.')).not.toBeInTheDocument();
});

test('cold-load directory reserves four desktop cards, then replaces them with real applications', async () => {
    let resolve!: (items: typeof apps) => void;
    const pending = new Promise<typeof apps>(complete => { resolve = complete; });
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_all_applications') return pending as never;
        throw new Error('Unexpected tool ' + name);
    });
    const { container } = render(<ApplicationsDirectory />);
    expect(screen.getByRole('status', { name: 'Loading applications' })).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.applications-directory > .atlas-skeleton-grid .atlas-skeleton-card')).toHaveLength(4);
    expect(screen.queryByText('0 applications')).not.toBeInTheDocument();
    resolve(apps);
    expect(await screen.findByRole('link', { name: 'Launch Portfolio' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading applications' })).not.toBeInTheDocument();
});

test('retains existing application cards during an explicit refresh', async () => {
    let calls = 0;
    let completeRefresh!: (value: typeof apps) => void;
    vi.mocked(callTool).mockImplementation(name => {
        if (name !== 'list_all_applications') throw new Error('Unexpected tool ' + name);
        calls++;
        return (calls === 1 ? Promise.resolve(apps)
            : new Promise<typeof apps>(resolve => { completeRefresh = resolve; })) as never;
    });
    render(<ApplicationsDirectory />);
    expect(await screen.findByRole('link', { name: 'Launch Portfolio' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh applications' }));
    expect(screen.getByRole('link', { name: 'Launch Portfolio' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading applications' })).not.toBeInTheDocument();
    completeRefresh(apps);
    expect(await screen.findByRole('link', { name: 'Launch Football Training' })).toBeInTheDocument();
});

test('empty application catalogue is distinct from pending skeleton and error', async () => {
    vi.mocked(callTool).mockResolvedValue([] as never);
    render(<ApplicationsDirectory />);
    expect(await screen.findByText('No applications are registered yet.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading applications' })).not.toBeInTheDocument();
});

test('shows active Views from several projects in a distinct section and opens standalone URLs', async () => {
    render(<ApplicationsDirectory />);
    const section = await screen.findByRole('region', { name: 'Views' });
    const career = await screen.findByRole('link', { name: 'Open Career Dashboard from Launchpad in new tab' });
    const notes = screen.getByRole('link', { name: 'Open Markov Notes from University in new tab' });
    expect(section).toContainElement(career);
    expect(section).toContainElement(notes);
    expect(section).toHaveTextContent('Project Views');
    expect(section).toHaveTextContent('Launchpad');
    expect(section).toHaveTextContent('University');
    expect(screen.queryByText('Old Dashboard')).not.toBeInTheDocument();
    expect(career.getAttribute('href')).toMatch(/\\/projects\\/project-one\\/views\\/career-dashboard$/);
    expect(notes.getAttribute('href')).toMatch(/\\/projects\\/project-two\\/views\\/view-two$/);
    expect(career).toHaveAttribute('target', '_blank');
    expect(career).toHaveAttribute('rel', 'noopener noreferrer');
    expect(callTool).toHaveBeenCalledWith('list_views', { projectId: 'project-one' }, expect.any(AbortSignal));
    expect(callTool).toHaveBeenCalledWith('list_views', { projectId: 'project-two' }, expect.any(AbortSignal));
    fireEvent.click(career);
    expect(readRecentWork()[0]).toMatchObject({ href: '#/projects/project-one/views/view-one', projectId: 'project-one', kind: 'View' });
});

test('View search is separate from the existing Applications search', async () => {
    render(<ApplicationsDirectory />);
    await screen.findByRole('link', { name: 'Open Career Dashboard from Launchpad in new tab' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search views' }), { target: { value: 'university' } });
    expect(screen.getByRole('link', { name: 'Open Markov Notes from University in new tab' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Career Dashboard from Launchpad in new tab' })).not.toBeInTheDocument();
    expect(screen.getByText('1 view')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Launch Portfolio' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search views' }), { target: { value: 'missing' } });
    expect(screen.getByText('No Views match your search.')).toBeInTheDocument();
});

test('a Views fetch failure does not hide or mislabel the Applications catalogue', async () => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_all_applications') return apps as never;
        throw new Error('View lookup failed');
    });
    render(<ApplicationsDirectory />);
    expect(await screen.findByRole('link', { name: 'Launch Portfolio' })).toBeInTheDocument();
    expect(await screen.findByText("Couldn't load Views.")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load applications.")).not.toBeInTheDocument();
});

test('empty Views catalogue has its own empty state', async () => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_all_applications') return apps as never;
        if (name === 'list_projects') return [] as never;
        throw new Error('Unexpected tool ' + name);
    });
    render(<ApplicationsDirectory />);
    expect(await screen.findByText('No Views have been created yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Launch Notes' })).toBeInTheDocument();
});
