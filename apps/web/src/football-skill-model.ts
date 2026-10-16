import type { GeneralistScenario } from './FootballGeneralistDashboard';

export const SKILL_GROUPS = [
    { id: 'contact', label: 'Movement & First Contact', description: 'Reach and establish physical possession' },
    { id: 'dribbling', label: 'Dribbling & Ball Control', description: 'Maintain control and change direction' },
    { id: 'receiving', label: 'Interception & Receiving', description: 'Capture and control moving balls' },
    { id: 'shooting', label: 'Kicking & Shooting', description: 'Kick with deliberate power and accuracy' },
    { id: 'passing', label: 'Passing & Distribution', description: 'Deliver and receive controlled passes' },
    { id: 'defending', label: 'Defending', description: 'Win possession and prevent scoring' },
    { id: 'teamplay', label: 'Teamplay & Matches', description: 'Coordinate and compete with other agents' },
] as const;
export type SkillGroup = typeof SKILL_GROUPS[number]['id'];
export type DrillPurpose = 'training' | 'benchmark-candidate' | 'showcase';
export const SHOWCASE_DRILL = 'dribbling_showcase_v1';

export function skillForScenario(scenario: Pick<GeneralistScenario, 'id' | 'objectiveType'>): SkillGroup {
    if (/shoot|kick/i.test(scenario.id)) return 'shooting';
    if (/pass/i.test(scenario.id)) return 'passing';
    if (/defend|block/i.test(scenario.id)) return 'defending';
    if (/team|match|2v/i.test(scenario.id)) return 'teamplay';
    if (/moving|intercept|receiv/i.test(scenario.id)) return 'receiving';
    if (scenario.objectiveType === 'physical_contact' || scenario.id.startsWith('s0-')) return 'contact';
    return 'dribbling';
}
export const ASSESSMENT_SUITE = {
    id: 'dribbling-assessment-v1',
    label: 'Dribbling Assessment v1',
    version: 1,
    note: 'Frozen benchmarks require new reserved seeds and measured episode outcomes; historical data is provisional.',
    recommendedEpisodes: 100,
    benchmarks: [
        { id: 'close_control', label: 'Close control · 3m', scenario: 's1-dribble-3m-v1', skill: 'dribbling' },
        { id: 'directional', label: 'Sharp directional control', scenario: 's1-dribble-directional-challenge-v1', skill: 'dribbling' },
        { id: 'near_reversal', label: 'Near-reversal control', scenario: 's1-dribble-directional-reversal-v1', skill: 'dribbling' },
        { id: 'moving_ball', label: 'Moving-ball interception & control', scenario: 's1-dribble-moving-interception-v1', skill: 'receiving' },
    ],
} as const;
export type AssessmentMetric = {
    id: string; label: string; scenario: string; skill: string;
    total: number; successes: number; rate: number | null;
    ticketCount: number; seeds: number[];
    status: 'provisional' | 'not_assessed'; tickets: string[];
};
export type PolicyAssessment = {
    policy_id: string; canonical_policy_id: string; model_sha256: string | null;
    suite_id: string; benchmarks: AssessmentMetric[];
};
export const isActive = (status?: string) => ['running', 'launching', 'queued', 'starting', 'packaging', 'interrupt_requested'].includes(status ?? '');
export const nameOfPolicy = (p: { id: string; display_name?: string | null }) => p.display_name || p.id;
export const groupLabel = (id: SkillGroup) => SKILL_GROUPS.find(g => g.id === id)?.label || id;
export const scenarioPurpose = (id: string): DrillPurpose =>
    id === SHOWCASE_DRILL ? 'showcase' :
    ASSESSMENT_SUITE.benchmarks.some(b => b.scenario === id) ? 'benchmark-candidate' : 'training';
