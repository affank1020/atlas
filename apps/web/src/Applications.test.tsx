import { Provider } from 'react-redux';
import { createAtlasStore } from './store';
import type { ReactElement, ReactNode } from 'react';
import { cleanup, render as rtlRender, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectApplications, ApplicationWindow } from './Applications';
import { callTool } from './api';
import { readRecentWork } from './recentWork';

vi.mock('./api', () => ({ IS_MOCK_MODE: false, callTool: vi.fn(), onToolMutation: () => () => {} }));
vi.mock('./Portfolio', () => ({ Portfolio: () => <div>Portfolio publishing UI</div> }));
const manifest = {
    type: 'portfolio', slug: 'portfolio', name: 'Portfolio',
    description: 'Manage portfolio content', projectId: 'project-portfolio',
};

beforeEach(() => { vi.resetAllMocks(); sessionStorage.clear(); });
afterEach(cleanup);

test('Applications are launchable in a new tab from the owning Project', async () => {
    vi.mocked(callTool).mockResolvedValue([manifest]);
    render(<ProjectApplications projectId="project-portfolio" />);
    const link = await screen.findByRole('link', { name: /Launch Portfolio/ });
    expect(link).toHaveAttribute('href', '#/projects/project-portfolio/applications/portfolio');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(callTool).toHaveBeenCalledWith('list_applications', { projectId: 'project-portfolio' }, expect.any(AbortSignal));
});

test('A launched Application renders a dedicated page without the project View host', async () => {
    vi.mocked(callTool).mockImplementation(async name => (name === 'list_projects' ? [] : manifest) as never);
    render(<ApplicationWindow projectId="project-portfolio" slug="portfolio" />);
    expect(await screen.findByText('Portfolio publishing UI')).toBeInTheDocument();
    expect(readRecentWork()[0]).toMatchObject({ name: 'Portfolio', kind: 'Application', href: '#/projects/project-portfolio/applications/portfolio' });
    expect(screen.getByRole('link', { name: /Project Applications/ })).toHaveAttribute('href', '#/projects/project-portfolio/applications');
    expect(callTool).toHaveBeenCalledWith('get_application', { projectId: 'project-portfolio', slug: 'portfolio' }, expect.any(AbortSignal));
});

test('Unknown Application registrations fail visibly instead of rendering Portfolio', async () => {
    vi.mocked(callTool).mockRejectedValue(new Error('Application not found'));
    render(<ApplicationWindow projectId="other-project" slug="portfolio" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Application not found');
    expect(screen.queryByText('Portfolio publishing UI')).not.toBeInTheDocument();
});

test('switching Project clears a previously loaded Application when the next lookup fails', async () => {
    vi.mocked(callTool).mockImplementation(async (_name, args) => {
        if (args?.projectId === 'project-portfolio') return manifest as never;
        throw new Error('Application not found');
    });
    const window = render(<ApplicationWindow projectId="project-portfolio" slug="portfolio" />);
    expect(await screen.findByText('Portfolio publishing UI')).toBeInTheDocument();
    window.rerender(<ApplicationWindow projectId="other-project" slug="portfolio" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Application not found');
    expect(screen.queryByText('Portfolio publishing UI')).not.toBeInTheDocument();
});

test('Standalone Application opens with a global back link and no Project scope', async () => {
    const standalone = { ...manifest, projectId: null };
    vi.mocked(callTool).mockImplementation(async name => (name === 'list_projects' ? [] : standalone) as never);
    render(<ApplicationWindow slug="portfolio" />);
    expect(await screen.findByText('Portfolio publishing UI')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All Applications/ })).toHaveAttribute('href', '#/applications');
    expect(callTool).toHaveBeenCalledWith('get_application', { slug: 'portfolio' }, expect.any(AbortSignal));
    expect(readRecentWork()[0]).toMatchObject({ href: '#/applications/portfolio', projectId: null });
});

const render = (element: ReactElement) => { const { store } = createAtlasStore(); return rtlRender(element, { wrapper: ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider> }); };
