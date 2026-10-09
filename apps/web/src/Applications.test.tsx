import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectApplications, ApplicationWindow } from './Applications';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn() }));
vi.mock('./Portfolio', () => ({ Portfolio: () => <div>Portfolio publishing UI</div> }));
const manifest = {
    type: 'portfolio', slug: 'portfolio', name: 'Portfolio',
    description: 'Manage portfolio content', projectId: 'project-portfolio',
};

beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

test('Applications are launchable in a new tab from the owning Project', async () => {
    vi.mocked(callTool).mockResolvedValue([manifest]);
    render(<ProjectApplications projectId="project-portfolio" />);
    const link = await screen.findByRole('link', { name: /Launch Portfolio/ });
    expect(link).toHaveAttribute('href', '#/projects/project-portfolio/applications/portfolio');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(callTool).toHaveBeenCalledWith('list_applications', { projectId: 'project-portfolio' });
});

test('A launched Application renders a dedicated page without the project View host', async () => {
    vi.mocked(callTool).mockResolvedValue(manifest);
    render(<ApplicationWindow projectId="project-portfolio" slug="portfolio" />);
    expect(await screen.findByText('Portfolio publishing UI')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Project Applications/ })).toHaveAttribute('href', '#/projects/project-portfolio/applications');
    expect(callTool).toHaveBeenCalledWith('get_application', { projectId: 'project-portfolio', slug: 'portfolio' });
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
