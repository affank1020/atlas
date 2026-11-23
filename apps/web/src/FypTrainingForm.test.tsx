import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { callTool } from './api';
import { FypTrainingForm } from './FypTrainingForm';
import type { FypRun } from './FypV1Evidence';

vi.mock('./api', () => ({ callTool: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const parent = { run_id: 'fyp-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', checkpoint_number: 13,
    seed: 615, environment: { environment_id: 'open-goal-close', name: 'Open Goal Close' } } as FypRun;
function setup() {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'football_fyp_environments') return [{ environment_id: 'retrieval', name: 'Retrieval', version: '1' }] as never;
        if (name === 'football_fyp_preflight') return { ready_to_train: true, editor_playing: false } as never;
        return { ticket: 'ticket', action: 'fyp_train', status: 'launching' } as never;
    });
    const accepted = vi.fn();
    render(<FypTrainingForm policyId="football-instruction-v3" parent={parent} disabled={false} onAccepted={accepted} />);
    return accepted;
}
test('resume submits source checkpoint and additional budget in original environment', async () => {
    const accepted = setup();
    const button = await screen.findByRole('button', { name: 'Resume training' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(accepted).toHaveBeenCalled());
    expect(callTool).toHaveBeenCalledWith('football_fyp_train', expect.objectContaining({
        checkpointMode: 'resume', parentRunId: parent.run_id, maxSteps: 250000,
        seed: 615, environmentId: 'open-goal-close',
    }));
});
test('transfer submits source checkpoint and chosen environment', async () => {
    const accepted = setup();
    fireEvent.change(screen.getByLabelText('Training mode'), { target: { value: 'transfer' } });
    await screen.findByRole('option', { name: 'Retrieval · v1' });
    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'retrieval' } });
    const button = screen.getByRole('button', { name: 'Transfer and train' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(accepted).toHaveBeenCalled());
    expect(callTool).toHaveBeenCalledWith('football_fyp_train', expect.objectContaining({
        checkpointMode: 'transfer', parentRunId: parent.run_id, environmentId: 'retrieval',
    }));
});
