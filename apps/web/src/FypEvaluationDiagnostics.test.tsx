import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { callTool } from './api';
import { FypEvaluationDiagnostics, type EvaluationDiagnostics } from './FypEvaluationDiagnostics';
vi.mock('./api', () => ({ callTool: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.mocked(callTool).mockReset());
const summary: EvaluationDiagnostics = { state: 'complete', episodes: [
    { session_id: 's', episode: 1, outcome: 'Goal scored', elapsed_seconds: 1, player_distance_metres: .1,
        absolute_turn_degrees: 400, final_ball_distance_metres: 5, touch_attempts: 2, touch_results: { applied: 1, cooldown: 1 } },
    { session_id: 's', episode: 2, outcome: 'Timeout', elapsed_seconds: 12, player_distance_metres: .5,
        absolute_turn_degrees: 3000, final_ball_distance_metres: 6, touch_attempts: 5, touch_results: { applied: 1, out_of_reach: 4 } },
] };
function detail(index = 0) { return { diagnostics: summary, observation_channels: [{ name: 'ball_relative_position', start: 0, size: 3 }],
    trace: { states: [{ elapsed_seconds: 0, player_position: {x:0,z:8}, ball_position: {x:0,z:8.6}, yaw_degrees: 0,
        desired_facing_active: false, can_touch: true, cooldown_seconds: 0 }],
        actions: [{elapsed_seconds: 0, values:[0,0,1,0,0,1,0,1]}], touches: [{elapsed_seconds: .1, result: 'applied', power: 1, impulse:{x:0,y:0,z:4}}],
        counts: {states:1, actions:1, touches:1, observations:2}, display_limit:400, observation_index:index,
        observation: {elapsed_seconds:index*.1, values:[index,0,.2]} } }; }
test('older evaluation has an explicit empty state without requesting nonexistent traces', () => {
    render(<FypEvaluationDiagnostics evaluationId="old" />);
    expect(screen.getByText('No diagnostic trace was recorded for this evaluation.')).toBeInTheDocument();
    expect(callTool).not.toHaveBeenCalled();
});
test('starts on failures and switches episode and observation without losing the inspector', async () => {
    vi.mocked(callTool).mockImplementation(async (_name,input) => detail(Number(input?.offset ?? 0)) as never);
    render(<FypEvaluationDiagnostics evaluationId="evaluation" policyId="football-v1" diagnostics={summary} />);
    expect(await screen.findByRole('slider', {name:'Episode timeline'})).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('football_fyp_evaluation_diagnostics', expect.objectContaining({replayEpisode:1,offset:0}), expect.any(AbortSignal));
    fireEvent.click(screen.getByRole('button', {name:'Episode 1'}));
    await waitFor(()=>expect(callTool).toHaveBeenLastCalledWith('football_fyp_evaluation_diagnostics',expect.objectContaining({replayEpisode:0,offset:0}),expect.any(AbortSignal)));
    await screen.findByRole('slider', {name:'Episode timeline'});
    fireEvent.click(screen.getByText('Policy observations'));
    fireEvent.change(screen.getByRole('spinbutton', {name:'Observation sample'}), {target:{value:'1'}});
    await screen.findByText('1.000, 0.000, 0.200');
    expect(screen.getByRole('spinbutton', {name:'Observation sample'})).toBeVisible();
    expect(screen.getByText('4.00 N·s', {exact:false})).toBeInTheDocument();
});
test('shows transport failures and offers retry', async () => {
    vi.mocked(callTool).mockRejectedValueOnce(new Error('Trace hash does not match')).mockResolvedValue(detail() as never);
    render(<FypEvaluationDiagnostics evaluationId="evaluation" diagnostics={summary} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Trace hash does not match');
    fireEvent.click(screen.getByRole('button',{name:'Retry diagnostics'}));
    expect(await screen.findByRole('slider',{name:'Episode timeline'})).toBeInTheDocument();
});
