import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
afterEach(cleanup);
import { useState } from 'react';
import { GeneralistDrillCatalog } from './GeneralistDrillCatalog';
import type { GeneralistManifest } from './FootballGeneralistDashboard';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn() }));
const manifest = {
    available: true, source: 'test',
    contract: { contract_id: 'football-generalist-v2', behavior: 'FootballGeneralistV2',
        observations: { size: 54, fields: [] }, actions: { continuous: 5, channels: [] } },
    scenarios: { sceneVersion: 'arena-v3', physicsVersion: 'physics-v3', ballControlMode: 'assisted', scenarios: [
        { id: 's0-contact', name: 'First contact', stage: 0, objective: 'Touch a nearby ball.', objectiveType: 'physical_contact', targetRepresentation: 'ball', physicalDifficulty: 0, decisionComplexity: 0, weight: 0.7, episodeSeconds: 12, spawnDistanceMin: 2, spawnDistanceMax: 3 },
        { id: 's1-turn', name: 'Small turns', stage: 1, objective: 'Redirect the ball.', objectiveType: 'controlled_dribble', targetRepresentation: 'zone', physicalDifficulty: 0.22, decisionComplexity: 1, weight: 0.2, episodeSeconds: 35, spawnDistanceMin: 2, spawnDistanceMax: 3.2, minimumMeaningfulTouches: 2, targetForwardMetres: 4, moderateTurnMinDegrees: 15, moderateTurnMaxDegrees: 35, successReward: 1 },
    ] },
    drill_guide: { schemaVersion: 1, drills: {
        's0-contact': { summary: 'First physics touch', focus: 'Approach and contact', purpose: 'Build a foundation' },
        's1-turn': { summary: 'Small directional dribbling turns', focus: 'Redirect control', purpose: 'Learn recovery' },
    } },
    curriculum: { stages: [] }, fingerprints: { contract_sha256: '1', scenario_sha256: '2', curriculum_sha256: '3' },
    provenance: 'test',
} as GeneralistManifest;

function Catalog({ train = vi.fn() }: { train?: (id: string) => void }) {
    const [selected, setSelected] = useState('');
    return <GeneralistDrillCatalog manifest={manifest} selected={selected} onSelect={setSelected} onTrain={train}/>;
}

test('selecting a drill reveals its full real scenario metadata and learning objective', () => {
    const train = vi.fn();
    render(<Catalog train={train}/>);
    fireEvent.click(screen.getByRole('button', { name: /Small turns/ }));
    expect(screen.getByRole('heading', { name: 'Small turns' })).toBeInTheDocument();
    expect(screen.getAllByText('Small directional dribbling turns').length).toBeGreaterThan(0);
    expect(screen.getByText(/Learning focus:/)).toBeInTheDocument();
    expect(screen.getByText('15–35°')).toBeInTheDocument();
    expect(screen.getByText('Meaningful touches')).toBeInTheDocument();
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
    expect(screen.getByText('Success reward')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Train with this scenario/ }));
    expect(train).toHaveBeenCalledWith('s1-turn');
});

test('legacy archive is separate and reads historical registry instead of inferring generalist compatibility', async () => {
    vi.mocked(callTool).mockResolvedValue([{ id: 'shooting_v1', behavior: 'ShootingDrill', scene: 'Shooting.unity',
        observation_size: 12, continuous_actions: 3, primary_metric: 'goal_success_rate', configs: { smoke: 'shoot.yaml' } }] as never);
    render(<Catalog/>);
    fireEvent.click(screen.getByRole('button', { name: 'Legacy archive' }));
    expect(await screen.findByRole('button', { name: /shooting v1/ })).toBeInTheDocument();
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_list_drills'));
    expect(screen.getAllByText('ShootingDrill').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Train with this scenario/ })).not.toBeInTheDocument();
});
