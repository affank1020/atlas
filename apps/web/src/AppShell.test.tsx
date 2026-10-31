import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { afterEach, vi, test, expect } from 'vitest';
import { AppShell, ProjectNav } from './AppShell';
import { callTool } from './api';
import { Provider } from 'react-redux';
import { store } from './store';
vi.mock('./api', () => ({ IS_MOCK_MODE: false, API_BASE: 'http://localhost:3000', callTool: vi.fn(), onToolMutation: vi.fn(() => () => {}) }));
test('shell exposes focused navigation and keeps experimental tools out of the header', async () => {
    vi.mocked(callTool).mockResolvedValue([{ id: 'real-project', name: 'Research' }]);
    render(<Provider store={store}><AppShell page="project" projectId="real-project" contentClass=""><h1>Research overview</h1></AppShell></Provider>);
    expect(await screen.findByRole('link', { name: /Research/ })).toHaveAttribute('href', '#/projects/real-project');
    expect(screen.queryByRole('link', { name: /Ask Atlas/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Infrastructure/ })).not.toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Atlas navigation' });
    const header = screen.getByRole('banner');
    const brand = within(header).getByRole('link', { name: 'atlas' });
    expect(brand).toHaveAttribute('href', '#/');
    expect(brand.querySelector('.brand-symbol')).not.toBeInTheDocument();
    expect(brand.querySelector('.brand-period')).toHaveTextContent('.');
    expect(brand.querySelector('.brand-period')).toHaveAttribute('aria-hidden', 'true');
    expect(within(header).getByRole('button', { name: 'Search Atlas' })).toBeInTheDocument();
    expect(within(header).queryByRole('link', { name: 'Activity' })).not.toBeInTheDocument();
    expect(within(header).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '#/settings');
    expect(within(sidebar).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(within(sidebar).queryByRole('link', { name: 'Activity' })).not.toBeInTheDocument();
    expect(within(sidebar).getByRole('link', { name: 'Nodes' })).toHaveAttribute('href', '#/nodes');
    expect(within(sidebar).getByRole('link', { name: 'Monitoring' })).toHaveAttribute('href', '#/monitoring');
    expect(within(sidebar).getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '#/projects');
    expect(within(sidebar).getByRole('link', { name: 'Applications' })).toHaveAttribute('href', '#/applications');
    expect(within(sidebar).getByRole('link', { name: 'Workspaces' })).toHaveAttribute('href', '#/workspaces');
    expect(screen.queryByRole('link', { name: /Sessions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Portfolio' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ask Portfolio' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Agents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Automations' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search Atlas' }));
    expect(screen.getByRole('dialog', { name: 'Search Atlas' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search or describe an action' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Search Atlas' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Search Atlas' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog', { name: 'Search Atlas' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('dialog', { name: 'Search Atlas' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
});
test('only the content pane scrolls and page navigation resets its scroll position', () => {
    vi.mocked(callTool).mockResolvedValue([]);
    window.history.replaceState(null, '', '#/projects');
    const { container } = render(<Provider store={store}><AppShell page="projects" contentClass=""><h1>Projects</h1></AppShell></Provider>);
    const frame = container.querySelector<HTMLDivElement>('.content-frame');
    expect(frame).not.toBeNull();
    expect(frame).toContainElement(screen.getByRole('main'));
    expect(container.querySelector('.topbar')).not.toBeNull();
    expect(container.querySelector('.sidebar')).not.toBeNull();

    if (!frame) return;
    frame.scrollTop = 350;
    window.history.replaceState(null, '', '#/nodes');
    fireEvent(window, new Event('hashchange'));
    expect(frame.scrollTop).toBe(0);
});

test('switching Workspaces and checkouts preserves content scroll without breaking page navigation', () => {
    vi.mocked(callTool).mockResolvedValue([]);
    window.history.replaceState(null, '', '#/workspaces');
    const { container } = render(<Provider store={store}><AppShell page="workspaces" contentClass=""><h1>Workspaces</h1></AppShell></Provider>);
    const frame = container.querySelector<HTMLDivElement>('.content-frame');
    expect(frame).not.toBeNull();
    if (!frame) return;

    frame.scrollTop = 430;
    for (const hash of ['#/workspaces?group=atlas', '#/workspaces?workspace=checkout-a',
        '#/workspaces?group=portfolio', '#/workspaces?workspace=checkout-b', '#/workspaces']) {
        window.history.replaceState(null, '', hash);
        fireEvent(window, new Event('hashchange'));
        expect(frame.scrollTop).toBe(430);
    }
    window.history.replaceState(null, '', '#/monitoring');
    fireEvent(window, new Event('hashchange'));
    expect(frame.scrollTop).toBe(0);
});
test('page transitions remount content only for a different navigation target', () => {
    vi.mocked(callTool).mockResolvedValue([]);
    const shell = (routeKey: string, label: string) =>
        <Provider store={store}><AppShell page="monitoring" routeKey={routeKey} contentClass="">
            <h1>{label}</h1>
        </AppShell></Provider>;
    const view = render(shell('monitoring:overview', 'Monitoring'));
    const main = screen.getByRole('main');
    view.rerender(shell('monitoring:overview', 'Updated monitoring'));
    expect(screen.getByRole('main')).toBe(main);
    expect(screen.getByRole('heading', { name: 'Updated monitoring' })).toBeInTheDocument();

    // Monitoring filters and Workspaces selections reuse their page key.
    view.rerender(shell('monitoring:activity', 'Activity'));
    const activity = screen.getByRole('main');
    expect(activity).not.toBe(main);
    view.rerender(shell('monitoring:activity', 'Filtered activity'));
    expect(screen.getByRole('main')).toBe(activity);

    view.rerender(shell('monitoring:logs', 'Logs'));
    expect(screen.getByRole('main')).not.toBe(activity);
    expect(screen.getByRole('heading', { name: 'Logs' })).toBeInTheDocument();
});

test('project sections retain an overview deep link and indicate the selected section', () => {
    render(<ProjectNav projectId="p" section="views" />);
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '#/projects/p');
    expect(screen.getByRole('link', { name: 'Views' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute('href', '#/projects/p/workspaces');
});

afterEach(() => { cleanup(); window.history.replaceState(null, '', '#/'); });
