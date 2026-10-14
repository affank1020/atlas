import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { callTool } from './api';
import { FootballGeneralistExperience } from './FootballGeneralistExperience';

vi.mock('./api', () => ({ callTool: vi.fn() }));
const contract = {
    available: true,
    contract: { contract_id: 'football-generalist-v2', behavior: 'FootballGeneralistV2',
        observations: { size: 54, fields: [] }, actions: { continuous: 5, channels: [{ index: 0, name: 'throttle' }] } },
    scenarios: { sceneVersion: 's2', physicsVersion: 'p2', scenarios: [{ id: 's0-contact-easy-v1', name: 'Easy contact', stage: 0, objective: 'Touch ball' }] },
    curriculum: { stages: [{ id: 'S0', name: 'Contact', implemented: true }], held_out_seeds: [515] },
    fingerprints: { contract_sha256: 'a', scenario_sha256: 'b' },
};
beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callTool).mockImplementation(async (name) => {
        if (name === 'football_generalist_manifest') return contract as never;
        if (name === 'football_generalist_runs') return [{ id: 'external-s0', family: 'generalist', state: 'unknown', scenario: 's0-contact-easy-v1' }] as never;
        if (name === 'football_generalist_policies') return [] as never;
        if (name === 'football_generalist_activity') return [] as never;
        if (name === 'football_list_policies') return [{ id: 'legacy-policy', drill: 'shooting_v1' }] as never;
        if (name === 'football_list_jobs') return [{ id: 'legacy-run', drill: 'shooting_v1', state: 'completed' }] as never;
        return [] as never;
    });
});
afterEach(cleanup);

test('Generalist application defaults to new contract, not legacy driver', async () => {
    render(<FootballGeneralistExperience />);
    expect(await screen.findByText('external-s0')).toBeInTheDocument();
    expect(screen.getByText('football-generalist-v2')).toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.map(([name]) => name)).toEqual([
        'football_generalist_manifest', 'football_generalist_runs',
        'football_generalist_policies', 'football_generalist_activity',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Train' }));
    expect(screen.getByRole('button', { name: 'Launch generalist training' })).toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'football_list_drills')).toBe(false);
});

test('Historical specialist data is fetched only when opening read-only archive', async () => {
    render(<FootballGeneralistExperience />);
    await screen.findByText('external-s0');
    fireEvent.click(screen.getByRole('button', { name: 'Legacy archive' }));
    expect(await screen.findByText('legacy-policy')).toBeInTheDocument();
    expect(screen.getByText('legacy-run')).toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.map(([name]) => name)).toContain('football_list_jobs');
    expect(screen.queryByRole('button', { name: /Launch specialist/ })).toBeNull();
});
