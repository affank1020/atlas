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
const render = (element: ReactElement) => {
    const { store } = createAtlasStore();
    return rtlRender(element, { wrapper: ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider> });
};

beforeEach(() => {
    vi.resetAllMocks();
    sessionStorage.clear();
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_all_applications') return apps as never;
        throw new Error('Unexpected tool ' + name);
    });
});
afterEach(cleanup);

test('lists applications from all projects with launch links, without fetching per-project lists', async () => {
    render(<ApplicationsDirectory />);
    const portfolio = await screen.findByRole('link', { name: 'Launch Portfolio' });
    const football = screen.getByRole('link', { name: 'Launch Football Training' });
    expect(portfolio).toHaveAttribute('href', '#/projects/project-one/applications/portfolio');
    expect(football).toHaveAttribute('href', '#/projects/project-two/applications/football-training');
    expect(portfolio).not.toHaveAttribute('target');
    expect(portfolio).not.toHaveAttribute('rel');
    expect(football).not.toHaveAttribute('target');
    expect(callTool).toHaveBeenCalledWith('list_all_applications', {}, expect.any(AbortSignal));
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'list_applications' || name === 'list_projects')).toBe(false);
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
        throw new Error('Catalogue unavailable');
    });
    render(<ApplicationsDirectory />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn\'t load applications');
    expect(screen.queryByText('No applications are registered yet.')).not.toBeInTheDocument();
});


test('shows inert application cards during initial request, then reveals actual links', async () => {
    let resolve!: (value: typeof apps) => void;
    vi.mocked(callTool).mockImplementation(name => {
        if (name === 'list_all_applications') return new Promise<typeof apps>(r => { resolve = r; }) as never;
        throw new Error('Unexpected tool ' + name);
    });
    render(<ApplicationsDirectory />);
    const loading = screen.getByRole('status', { name: 'Loading applications' });
    expect(loading.querySelectorAll('.atlas-skeleton-card')).toHaveLength(6);
    expect(screen.queryByRole('link', { name: 'Launch Portfolio' })).not.toBeInTheDocument();
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
