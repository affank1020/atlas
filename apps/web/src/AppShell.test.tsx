import { render, screen, fireEvent } from '@testing-library/react';
import { vi, test, expect } from 'vitest';
import { AppShell, ProjectNav } from './AppShell';
import { callTool } from './api';
vi.mock('./api', () => ({ API_BASE: 'http://localhost:3000', callTool: vi.fn() }));
test('shell lists real projects, exposes Ask globally, and omits unsupported primitives', async () => {
    vi.mocked(callTool).mockResolvedValue([{ id: 'real-project', name: 'Research' }]);
    render(<AppShell page="project" projectId="real-project" contentClass=""><h1>Research overview</h1></AppShell>);
    expect(await screen.findByRole('link', { name: /Research/ })).toHaveAttribute('href', '#/projects/real-project');
    expect(screen.getByRole('link', { name: /Ask Atlas/ })).toHaveAttribute('href', '#/ask-atlas');
    expect(screen.getByRole('link', { name: /Nodes/ })).toHaveAttribute('href', '#/nodes');
    expect(screen.queryByRole('link', { name: 'Agents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Automations' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
});
test('project sections retain an overview deep link and indicate the selected section', () => {
    render(<ProjectNav projectId="p" section="views" />);
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '#/projects/p');
    expect(screen.getByRole('link', { name: 'Views' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute('href', '#/projects/p/workspaces');
});
