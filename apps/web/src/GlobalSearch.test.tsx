import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GlobalSearch } from './GlobalSearch';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn() }));
beforeEach(() => vi.mocked(callTool).mockReset());
afterEach(cleanup);

test('command palette starts with readable actions and closes on Escape', () => {
    const onClose = vi.fn();
    render(<GlobalSearch onClose={onClose} />);
    expect(screen.getByRole('textbox', { name: 'Search or describe an action' })).toHaveFocus();
    expect(screen.getByRole('link', { name: /Browse projects/ })).toHaveAttribute('href', '#/projects');
    const dialog = screen.getByRole('dialog', { name: 'Search Atlas' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
});

test('natural language app requests show launchable results and keyboard navigation', async () => {
    vi.mocked(callTool).mockResolvedValue({
        query: 'Open the portfolio app',
        results: [{ kind: 'application', id: 'p/portfolio', title: 'Portfolio Editor', description: 'Edit website', context: 'Portfolio', href: '#/projects/p/applications/portfolio', score: 140 }],
        incomplete: [],
    });
    render(<GlobalSearch onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search or describe an action' }), { target: { value: 'Open the portfolio app' } });
    const link = await screen.findByRole('link', { name: /Portfolio Editor/ }, { timeout: 3000 });
    expect(link).toHaveAttribute('href', '#/projects/p/applications/portfolio');
    expect(link).toHaveAttribute('target', '_blank');
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('search_everything', { query: 'Open the portfolio app', limit: 45 }, expect.any(AbortSignal)));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Search Atlas' }), { key: 'ArrowDown' });
    expect(link).toHaveAttribute('aria-current', 'true');
});

test('Node activity results are clearly distinguished from raw server logs', async () => {
    vi.mocked(callTool).mockResolvedValue({
        query: 'check logs for my Mac node',
        results: [{ kind: 'node', id: 'n', title: 'Inspect MacBook activity', description: 'Recent Node operations (not process or system logs)', context: 'macOS', href: '#/nodes?node=n', score: 140 }],
        incomplete: ['Records'],
    });
    render(<GlobalSearch onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search or describe an action' }), { target: { value: 'check logs for my Mac node' } });
    const node = await screen.findByRole('link', { name: /Inspect MacBook activity/ }, { timeout: 3000 });
    expect(node).toHaveAttribute('href', '#/nodes?node=n');
    expect(screen.getByText(/Node log access is unavailable/)).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: 'Search Atlas' })).getByText(/Some sources could not be searched/)).toBeInTheDocument();
});

test('approved Node log action reads bounded stderr inside the command palette', async () => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'search_everything') return {
            query: 'show the last 100 error lines from my Mac node',
            results: [{
                kind: 'node', id: 'node-1', title: 'Read MacBook error logs',
                description: 'Latest 100 lines · stderr', context: 'MacBook / macOS',
                href: '#/nodes?node=node-1', score: 120,
                action: { type: 'read_node_logs', nodeId: 'node-1', source: 'stderr', lines: 100 },
            }], incomplete: [],
        };
        if (name === 'read_node_logs') return { source: 'stderr', available: true, truncated: false, lines: ['Connection closed', 'Retry scheduled'] };
        throw new Error('Unexpected tool');
    });
    render(<GlobalSearch onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search or describe an action' }), { target: { value: 'show the last 100 error lines from my Mac node' } });
    const button = await screen.findByRole('button', { name: /Read MacBook error logs/ }, { timeout: 3000 });
    expect(callTool).not.toHaveBeenCalledWith('read_node_logs', expect.anything());
    fireEvent.click(button);
    expect(await screen.findByText(/Connection closed/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Node logs' })).toBeInTheDocument();
    expect(screen.getByText(/Retry scheduled/)).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('read_node_logs', { nodeId: 'node-1', source: 'stderr', lines: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('region', { name: 'Node logs' })).not.toBeInTheDocument();
});
