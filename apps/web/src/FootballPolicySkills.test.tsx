import { render, screen, fireEvent } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { FootballPolicySkills } from './FootballPolicySkills';
import { skillForScenario, scenarioPurpose, SHOWCASE_DRILL } from './football-skill-model';

test('skill taxonomy separates contact, dribbling and interception without roadmap coupling', () => {
    expect(skillForScenario({ id: 's0-contact-easy-v1', objectiveType: 'physical_contact' })).toBe('contact');
    expect(skillForScenario({ id: 's1-dribble-directional-reversal-v1', objectiveType: 'controlled_dribble' })).toBe('dribbling');
    expect(skillForScenario({ id: 's1-dribble-moving-interception-v1', objectiveType: 'controlled_dribble' })).toBe('receiving');
    expect(scenarioPurpose(SHOWCASE_DRILL)).toBe('showcase');
    expect(scenarioPurpose('s1-dribble-3m-v1')).toBe('benchmark-candidate');
});

test('skill profile reports measured episodes separately from certification and missing skills', () => {
    const onEvaluate = vi.fn();
    render(<FootballPolicySkills assessment={{
        policy_id: 'generalist-musiala-v1', canonical_policy_id: 'generalist-atlas-generalist-dd06a0e97750',
        model_sha256: 'abc', suite_id: 'dribbling-assessment-v1',
        benchmarks: [{ id: 'close_control', label: 'Close control · 3m', scenario: 's1-dribble-3m-v1',
            skill: 'dribbling', total: 100, successes: 98, rate: 0.98,
            ticketCount: 3, seeds: [515, 616, 717], tickets: ['a','b','c'], status: 'provisional' }],
    }} onEvaluate={onEvaluate}/>);
    expect(screen.getByText(/98\/100 episodes/)).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: /Close control/ })).toHaveAttribute('aria-valuenow', '98');
    expect(screen.getAllByText('Not assessed').length).toBeGreaterThan(0);
    expect(screen.getByText(/not certified holdouts/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Evaluate this skill →' })[0]);
    expect(onEvaluate).toHaveBeenCalledWith('s1-dribble-3m-v1');
});
