import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FootballValidation } from './FootballValidation';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn() }));
const sourceSha256 = 'abcde12345'.padEnd(64, 'f');
const passed = {
    id: 'val_demo', layer: 'python', status: 'pass',
    startedAt: '2026-10-12T15:00:00Z', completedAt: '2026-10-12T15:00:01Z',
    durationMs: 1000, sourceSha256, checks: [{ name: 'python_unittest', status: 'pass', detail: '109 tests executed' }],
    summary: 'All python checks passed', output: 'Ran 109 tests in 0.1s\nOK',
};
beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'football_validation_status') return {
            results: [passed], pythonAvailable: true, editorMenuApproved: false, sourceSha256,
        } as never;
        if (name === 'football_validate_python') return passed as never;
        throw new Error('Unexpected tool ' + name);
    });
});
afterEach(() => { cleanup(); });

test('validation shows real saved receipts and refuses unapproved Unity gate action', async () => {
    render(<FootballValidation />);
    expect(await screen.findByText(/Python regressions/)).toBeInTheDocument();
    expect(await screen.findByText(/python_unittest — pass: 109 tests executed/)).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Run Unity gates' })).toBeDisabled();
    expect(screen.getByText(/Mac owner approves/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Python suite · PASS/));
    expect(screen.getByText(/python_unittest — pass: 109 tests executed/)).toBeVisible();
    expect(callTool).not.toHaveBeenCalledWith('football_validate_editor_gates');
});

test('Run Python tests invokes dedicated fixed action and refreshes evidence', async () => {
    render(<FootballValidation />);
    await screen.findByText(/Python regressions/);
    fireEvent.click(screen.getByRole('button', { name: 'Run Python tests' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_validate_python'));
    expect(await screen.findByText(/Latest run: python · PASS/)).toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.filter(([name]) => name === 'football_validation_status').length).toBeGreaterThanOrEqual(2);
});

test('shared physics action requires explicit confirmation and local approval', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'football_validation_status') return {
            results: [], pythonAvailable: true, editorMenuApproved: true, sourceSha256,
        } as never;
        if (name === 'football_validate_physics_smoke') return {
            ...passed, layer: 'physics', status: 'pass',
        } as never;
        throw new Error('Unexpected tool ' + name);
    });
    render(<FootballValidation />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run shared physics smoke' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run shared physics smoke' }));
    expect(confirm).toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalledWith('football_validate_physics_smoke');
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Run shared physics smoke' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_validate_physics_smoke'));
});

test('Unity gates trigger only when locally approved', async () => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'football_validation_status') return {
            results: [], pythonAvailable: true, editorMenuApproved: true, sourceSha256,
        } as never;
        if (name === 'football_validate_editor_gates') return {
            ...passed, layer: 'editor', status: 'pass', checks: [{ name: 'stage3', status: 'pass' }],
            summary: 'All editor checks passed',
        } as never;
        throw new Error('Unexpected tool ' + name);
    });
    render(<FootballValidation />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run Unity gates' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run Unity gates' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_validate_editor_gates'));
});
