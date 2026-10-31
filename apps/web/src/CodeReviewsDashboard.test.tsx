import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CodeReviewsDashboard } from './CodeReviewsDashboard';
import { useApplicationRead } from './atlasApi';

vi.mock('./atlasApi', () => ({ useApplicationRead: vi.fn() }));
const refetch = vi.fn();
const run = (id: string, repository: string, prNumber: number, at: string,
    verdict: string, counts?: Record<string, number>) => ({
    id, data: { repository, prNumber, headSha: 'a'.repeat(40), reviewedAt: at,
        reviewer: 'Demo', verdict,
        ...(counts === undefined ? {} : { counts }),
        coverage: { source: 'atlas_structured_submission' } },
});
const rows = [
    run('run-3', 'affank1020/atlas', 59, '2026-10-30T12:00:00Z', 'non_blocking', { sev4: 2 }),
    run('run-2', 'Affank1020/Atlas', 42, '2026-10-29T12:00:00Z', 'concerns_to_verify', { sev3: 1 }),
    run('run-1', 'affank1020/atlas', 42, '2026-10-28T12:00:00Z', 'changes_requested', { sev2: 1 }),
];
let calls: string[];
beforeEach(() => {
    calls = [];
    vi.resetAllMocks();
    vi.mocked(useApplicationRead).mockImplementation((name: string) => {
        calls.push(name);
        if (name === 'code_reviews_overview') return {
            data: { reviewRuns: 3, findingObservations: 4 }, isLoading: false, isFetching: false, refetch,
        } as never;
        if (name === 'code_reviews_list_runs') return {
            data: { total: 3, offset: 0, limit: 100, items: rows },
            isLoading: false, isFetching: false, refetch,
        } as never;
        if (name === 'code_reviews_list_findings') return {
            data: { total: 2, items: [{ id: 'finding-1',
                data: { title: 'Avoid layout shifts', severity: 'sev4', state: 'new',
                    description: 'Render a stable placeholder while loading.' } }] },
            isLoading: false, isFetching: false, refetch,
        } as never;
        if (name === 'code_reviews_pr_timeline') return {
            data: { recordedRounds: 2, hasMore: false, offset: 0, rounds: [
                { runId: 'run-2', headSha: 'a'.repeat(40), reviewedAt: '2026-10-29T12:00:00Z',
                    verdict: 'concerns_to_verify', findingCoverage: 'structured',
                    totalFindingObservations: 1, findingsTruncated: false, findings: [] },
                { runId: 'run-1', headSha: 'a'.repeat(40), reviewedAt: '2026-10-28T12:00:00Z',
                    verdict: 'changes_requested', findingCoverage: 'structured',
                    totalFindingObservations: 1, findingsTruncated: false, findings: [] },
            ] }, isLoading: false, isFetching: false, refetch,
        } as never;
        if (name === 'code_reviews_pr_summary') return {
            data: { recordedRounds: 2, latestReviewHead: 'outdated',
                currentHead: { state: 'open', sha: 'b'.repeat(40) } },
            isLoading: false, isFetching: false, refetch,
        } as never;
        throw Error('Unexpected tool ' + name);
    });
});
afterEach(cleanup);

test('dashboard aggregates review productivity without confusing review rounds with PRs', () => {
    render(<CodeReviewsDashboard />);
    expect(screen.getByRole('heading', { name: 'Code Reviews' })).toBeInTheDocument();
    expect(screen.getByText('Review rounds').parentElement).toHaveTextContent('3');
    expect(screen.getByText('Findings recorded').parentElement).toHaveTextContent('4');
    expect(screen.getByText('Findings / review').parentElement).toHaveTextContent('1.33');
    expect(screen.getByText('PRs reviewed').parentElement).toHaveTextContent('2');
    expect(screen.queryByText(/^1st review$|^\d+ re-reviews?$/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('combobox', { name: 'Filter pull requests' })).toHaveLength(1);
    expect(screen.getByText('2.0 / round')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Details for / })).toHaveLength(2);
    expect(screen.queryByText(/PR review history and structured/)).not.toBeInTheDocument();
    expect(screen.queryByText('Development quality')).not.toBeInTheDocument();
    expect(calls).not.toContain('code_reviews_list_findings');
    expect(calls).not.toContain('code_reviews_pr_summary');
    expect(calls).not.toContain('code_reviews_pr_timeline');
});
test('review details and remote GitHub checks are lazy and only load when requested', () => {
    render(<CodeReviewsDashboard />);
    fireEvent.click(screen.getByRole('button', { name: 'Details for affank1020/atlas #59' }));
    expect(calls).toContain('code_reviews_list_findings');
    expect(calls).not.toContain('code_reviews_pr_timeline');
    expect(screen.getByText('Avoid layout shifts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Review rounds' }));
    expect(calls).toContain('code_reviews_pr_timeline');
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub' }));
    expect(calls).toContain('code_reviews_pr_summary');
    expect(calls).not.toContain('code_reviews_review_thread_state');
    expect(screen.getByText('outdated')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details for affank1020/atlas #59' }));
    expect(screen.queryByRole('tab', { name: 'GitHub' })).not.toBeInTheDocument();
});
test('filtering and searching operate on PRs, not individual review rounds', () => {
    render(<CodeReviewsDashboard />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter pull requests' }),
        { target: { value: 'revisited' } });
    expect(screen.getAllByRole('button', { name: /^Details for / })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /#42/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find pull request' }),
        { target: { value: '#59' } });
    expect(screen.getByText('No matching PRs.')).toBeInTheDocument();
});
test('missing per-round severity totals remain unknown rather than becoming zero', () => {
    vi.mocked(useApplicationRead).mockImplementation((name: string) => {
        if (name === 'code_reviews_overview') return {
            data: { reviewRuns: 2, findingObservations: 2 }, refetch,
        } as never;
        return { data: { total: 2, items: [
            rows[0], run('old', 'affank1020/atlas', 59, '2026-10-25T12:00:00Z', 'inconclusive'),
        ] }, refetch } as never;
    });
    render(<CodeReviewsDashboard />);
    expect(screen.getByText('2+')).toBeInTheDocument();
    expect(screen.getByText('Incomplete')).toBeInTheDocument();
    expect(screen.getByText('Findings / review').parentElement).toHaveTextContent('1.00');
});
test('older saved-run pages never claim to show a PR’s latest result or complete counts', () => {
    const firstHundred = Array.from({ length: 100 }, (_, i) =>
        run('recent-' + i, 'affank1020/atlas', 59, '2026-10-30T12:00:00Z',
            'no_findings', {}));
    const older = run('older-round', 'affank1020/atlas', 59,
        '2026-10-01T12:00:00Z', 'changes_requested', { sev3: 1 });
    vi.mocked(useApplicationRead).mockImplementation((name: string, input: Record<string, unknown> = {}) => {
        if (name === 'code_reviews_overview') return {
            data: { reviewRuns: 101, findingObservations: 1 }, isLoading: false, isFetching: false, refetch,
        } as never;
        if (name === 'code_reviews_list_runs') return {
            data: { total: 101, limit: 100, offset: input.offset,
                items: input.offset === 100 ? [older] : firstHundred },
            isLoading: false, isFetching: false, refetch,
        } as never;
        if (name === 'code_reviews_list_findings') return {
            data: { total: 0, items: [] }, isLoading: false, isFetching: false, refetch,
        } as never;
        throw Error('Unexpected tool ' + name);
    });
    render(<CodeReviewsDashboard />);
    expect(screen.getByText('Rounds (page)')).toBeInTheDocument();
    expect(screen.getByText('Latest result')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    expect(screen.getByText('Result on page')).toBeInTheDocument();
    expect(screen.queryByText('Latest result')).not.toBeInTheDocument();
    expect(screen.getByText('Rounds (page)')).toBeInTheDocument();
    expect(screen.getByText('Findings (page)')).toBeInTheDocument();
    expect(screen.getByText('PRs on page')).toBeInTheDocument();
    expect(screen.getByText(/verdicts may be older/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Repeated on page' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details for affank1020/atlas #59' }));
    expect(screen.getByRole('tab', { name: 'Findings on page' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find pull request' }),
        { target: { value: '#999999' } });
    expect(screen.getByText('No matching PRs on this page.')).toBeInTheDocument();
});

test('refreshes the dashboard without changing GitHub state', () => {
    render(<CodeReviewsDashboard />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(calls).not.toContain('code_reviews_pr_summary');
});
