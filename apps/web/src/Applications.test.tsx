import { Provider } from 'react-redux';
import { createAtlasStore } from './store';
import type { ReactElement, ReactNode } from 'react';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
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

test('Project Applications navigate in the same tab and record recent work', async () => {
    vi.mocked(callTool).mockResolvedValue([manifest]);
    render(<ProjectApplications projectId="project-portfolio" />);
    const link = await screen.findByRole('link', { name: /Launch Portfolio/ });
    expect(link).toHaveAttribute('href', '#/projects/project-portfolio/applications/portfolio');
    expect(link).not.toHaveAttribute('target');
    expect(link).not.toHaveAttribute('rel');
    expect(screen.getByText(/Applications open within Atlas/)).toBeInTheDocument();
    fireEvent.click(link);
    expect(readRecentWork()[0]).toMatchObject({ name: 'Portfolio', kind: 'Application', href: '#/projects/project-portfolio/applications/portfolio' });
    expect(callTool).toHaveBeenCalledWith('list_applications', { projectId: 'project-portfolio' }, expect.any(AbortSignal));
});

test('A launched Application renders a dedicated page without the project View host', async () => {
    vi.mocked(callTool).mockImplementation(async name => (name === 'list_projects' ? [] : manifest) as never);
    render(<ApplicationWindow projectId="project-portfolio" slug="portfolio" />);
    expect(await screen.findByText('Portfolio publishing UI')).toBeInTheDocument();
    const topbar = screen.getByRole('banner');
    expect(topbar).toHaveClass('topbar');
    expect(topbar.querySelector('.brand-period')).toHaveTextContent('.');
    expect(topbar.querySelector('.brand-period')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('link', { name: /atlas/i })).toHaveAttribute('href', '#/');
    expect(screen.getByRole('button', { name: 'Search Atlas' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Activity' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '#/settings');
    expect(screen.getByRole('main')).toHaveClass('application-window-main');
    expect(readRecentWork()[0]).toMatchObject({ name: 'Portfolio', kind: 'Application', href: '#/projects/project-portfolio/applications/portfolio' });
    expect(screen.getByRole('link', { name: '← Applications' })).toHaveAttribute('href', '#/applications');
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
    const initialMain = screen.getByRole('main');
    window.rerender(<ApplicationWindow projectId="other-project" slug="portfolio" />);
    expect(screen.getByRole('main')).not.toBe(initialMain);
    expect(await screen.findByRole('alert')).toHaveTextContent('Application not found');
    expect(screen.queryByText('Portfolio publishing UI')).not.toBeInTheDocument();
});

test('Standalone Application opens with a global back link and no Project scope', async () => {
    const standalone = { ...manifest, projectId: null };
    vi.mocked(callTool).mockImplementation(async name => (name === 'list_projects' ? [] : standalone) as never);
    render(<ApplicationWindow slug="portfolio" />);
    expect(await screen.findByText('Portfolio publishing UI')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Applications' })).toHaveAttribute('href', '#/applications');
    expect(callTool).toHaveBeenCalledWith('get_application', { slug: 'portfolio' }, expect.any(AbortSignal));
    expect(readRecentWork()[0]).toMatchObject({ href: '#/applications/portfolio', projectId: null });
});

const render = (element: ReactElement) => { const { store } = createAtlasStore(); return rtlRender(element, { wrapper: ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider> }); };

test('known Application routes use owned placeholders while their Server manifest is unresolved', () => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'get_application') return await new Promise<never>(() => {});
        if (name === 'list_projects') return [] as never;
        throw new Error('Unexpected tool ' + name);
    });
    for (const [slug, label, marker] of [
        ['portfolio', 'Loading Portfolio', '.portfolio-workspace .portfolio-editor'],
        ['code-reviews', 'Loading Code Reviews', '.cr-metrics'],
        ['football-training', 'Loading Football Generalist application', '.fg-stats'],
    ]) {
        const view = render(<ApplicationWindow slug={slug} />);
        expect(screen.getByRole('status', { name: label })).toHaveAttribute('aria-busy', 'true');
        expect(view.container.querySelector(marker)).toBeInTheDocument();
        expect(view.container.querySelector('.atlas-skeleton-app-window')).not.toBeInTheDocument();
        view.unmount();
    }
});

test('an unrecognised Application does not impersonate a known Application during manifest lookup', () => {
    vi.mocked(callTool).mockImplementation(async name => name === 'get_application'
        ? await new Promise<never>(() => {})
        : [] as never);
    const view = render(<ApplicationWindow slug="unregistered-application" />);
    expect(screen.getByRole('status', { name: 'Loading application interface' })).toBeInTheDocument();
    expect(view.container.querySelector('.cr-dashboard, .portfolio-app, .fg')).not.toBeInTheDocument();
});


test('Portfolio media route reserves media grid before the Application manifest resolves', () => {
    const previousHash = window.location.hash;
    window.location.hash = '#/applications/portfolio?tab=media';
    vi.mocked(callTool).mockImplementation(async name =>
        name === 'get_application' ? await new Promise<never>(() => {}) : [] as never);
    try {
        const view = render(<ApplicationWindow slug="portfolio" />);
        expect(screen.getByRole('status', { name: 'Loading Portfolio' })).toBeInTheDocument();
        expect(view.container.querySelectorAll('.portfolio-media-grid article')).toHaveLength(6);
        expect(view.container.querySelector('.portfolio-workspace')).not.toBeInTheDocument();
        expect(view.container.querySelector('.portfolio-loading-tab.active')).toHaveTextContent('Media library');
    } finally {
        window.location.hash = previousHash;
    }
});
