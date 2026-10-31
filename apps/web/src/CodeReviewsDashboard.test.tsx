import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CodeReviewsDashboard } from './CodeReviewsDashboard';
import { useApplicationRead } from './atlasApi';

vi.mock('./atlasApi', () => ({ useApplicationRead: vi.fn() }));
const refetch = vi.fn();
const group = (number: number, status: 'open' | 'closed' | 'unavailable',
    rounds: number, findings: number, verdict: string) => ({
    key: 'example/atlas-demo#' + number, repository: 'example/atlas-demo', prNumber: number,
    latest: { id: 'run-' + number, repository: 'example/atlas-demo', prNumber: number,
        headSha: 'a'.repeat(40), reviewedAt: '2026-10-30T12:00:00Z', verdict },
    rounds, findings, countsComplete: true, roundsComplete: true,
    severities: { sev1: 0, sev2: number === 42 ? 1 : 0,
        sev3: number === 42 ? 1 : 0, sev4: number === 59 ? 1 : 0 },
    status, reviewFreshness: status === 'unavailable' ? 'unknown' : 'current',
});
const groups = [
    group(59, 'open', 1, 1, 'non_blocking'),
    group(42, 'closed', 2, 2, 'concerns_to_verify'),
    group(54, 'unavailable', 1, 0, 'no_findings'),
];
let calls: string[];
beforeEach(() => {
    calls = [];
    vi.resetAllMocks();
    vi.mocked(useApplicationRead).mockImplementation((name: string) => {
        calls.push(name);
        if (name === 'code_reviews_overview') return {
            data: { reviewRuns: 4, findingObservations: 3 },
            isLoading: false, isFetching: false, refetch,
        } as never;
        if (name === 'code_reviews_dashboard') return {
            data: { totalRuns: 4, scannedRuns: 4, windowComplete: true, truncatedPrs: false,
                runOffset: 0, hasMore: false, groups },
            isLoading: false, isFetching: false, refetch,
        } as never;
        if (name === 'code_reviews_list_findings') return {
            data: { total: 1, items: [{ id: 'finding-1',
                data: { title: 'Avoid layout shifts', severity: 'sev4', state: 'new',
                    description: 'Reserve space while loading.' } }] },
            isLoading: false, isFetching: false, refetch,
        } as never;
        if (name === 'code_reviews_pr_timeline') return {
            data: { recordedRounds: 1, hasMore: false, offset: 0, rounds: [
                { runId: 'run-59', headSha: 'a'.repeat(40), reviewedAt: '2026-10-30T12:00:00Z',
                    verdict: 'non_blocking', findingCoverage: 'structured',
                    totalFindingObservations: 1, findingsTruncated: false, findings: [] },
            ] }, isLoading: false, isFetching: false, refetch,
        } as never;
        if (name === 'code_reviews_pr_summary') return {
            data: { recordedRounds: 1, latestReviewHead: 'current',
                currentHead: { state: 'open', sha: 'a'.repeat(40) } },
            isLoading: false, isFetching: false, refetch,
        } as never;
        throw Error('Unexpected Code Reviews request ' + name);
    });
});
afterEach(cleanup);

test('open reviewed PRs are cards above compact closed PRs; unknown status is separate', () => {
    render(<CodeReviewsDashboard />);
    expect(screen.getByRole('heading', { name: 'Open PRs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Closed PRs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Status unavailable' })).toBeInTheDocument();
    expect(screen.getByText('Review rounds').parentElement).toHaveTextContent('4');
    expect(screen.getByText('Findings recorded').parentElement).toHaveTextContent('3');
    expect(screen.getByText('Findings / review').parentElement).toHaveTextContent('0.75');
    expect(screen.getByText('PRs reviewed').parentElement).toHaveTextContent('3');
    const openSection = screen.getByRole('region', { name: 'Open pull requests' });
    const closedSection = screen.getByRole('region', { name: 'Closed pull requests' });
    const unknownSection = screen.getByRole('region', { name: 'Unverified pull requests' });
    expect(openSection).toHaveTextContent('#59');
    expect(openSection).not.toHaveTextContent('#42');
    expect(closedSection).toHaveTextContent('#42');
    expect(closedSection).not.toHaveTextContent('#54');
    expect(unknownSection).toHaveTextContent('#54');
    expect(screen.getAllByRole('button', { name: /^Details for / })).toHaveLength(3);
    expect(calls).not.toContain('code_reviews_pr_summary');
    expect(calls).not.toContain('code_reviews_pr_timeline');
});

test('expand PR cards to inspect findings, review history and GitHub state only on demand', () => {
    render(<CodeReviewsDashboard />);
    fireEvent.click(screen.getByRole('button', { name: 'Details for example/atlas-demo #59' }));
    expect(screen.getByText('Avoid layout shifts')).toBeInTheDocument();
    expect(calls).toContain('code_reviews_list_findings');
    expect(calls).not.toContain('code_reviews_pr_summary');
    fireEvent.click(screen.getByRole('tab', { name: 'Review rounds' }));
    expect(calls).toContain('code_reviews_pr_timeline');
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub' }));
    expect(calls).toContain('code_reviews_pr_summary');
    expect(calls).not.toContain('code_reviews_review_thread_state');
});

test('search and review filters operate over both lifecycle sections', () => {
    render(<CodeReviewsDashboard />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter pull requests' }),
        { target: { value: 'revisited' } });
    expect(screen.getAllByRole('button', { name: /^Details for / })).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Closed pull requests' })).toHaveTextContent('#42');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find pull request' }),
        { target: { value: '#59' } });
    expect(screen.getByText('No open reviewed PRs match.')).toBeInTheDocument();
    expect(screen.getByText('No closed reviewed PRs match.')).toBeInTheDocument();
});

test('failed lifecycle checks remain unavailable and are not counted as closed', () => {
    vi.mocked(useApplicationRead).mockImplementation((name: string) =>
        name === 'code_reviews_overview'
            ? { data: { reviewRuns: 1, findingObservations: 0 }, refetch } as never
            : { data: { totalRuns: 1, scannedRuns: 1, windowComplete: true,
                truncatedPrs: false, runOffset: 0, hasMore: false, groups: [groups[2]] }, refetch } as never);
    render(<CodeReviewsDashboard />);
    expect(screen.getByText('No open reviewed PRs.')).toBeInTheDocument();
    expect(screen.getByText('No closed reviewed PRs.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Unverified pull requests' })).toHaveTextContent('#54');
});

test('large histories remain visible with explicit recent-window and minimum-count indicators', () => {
    vi.mocked(useApplicationRead).mockImplementation((name: string) =>
        name === 'code_reviews_overview'
            ? { data: { reviewRuns: 2001, findingObservations: 2001 }, refetch } as never
            : { data: { totalRuns: 2001, scannedRuns: 500, windowComplete: false,
                truncatedPrs: false, runOffset: 0, hasMore: true, groups: [{
                    ...groups[0], rounds: 500, roundsComplete: false, findings: 500, countsComplete: false,
                }] }, refetch } as never);
    render(<CodeReviewsDashboard />);
    expect(screen.getByText('PRs shown').parentElement).toHaveTextContent('1');
    expect(screen.getByText(/Rounds 1–500 of 2001/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Older reviews' })).toBeEnabled();
    const open = screen.getByRole('region', { name: 'Open pull requests' });
    expect(open).toHaveTextContent('500+');
    expect(open).toHaveTextContent('#59');
});

test('older reviewed PRs remain accessible via dashboard pagination and can be expanded', () => {
    const oldOpen = group(501, 'open', 1, 1, 'changes_requested');
    const oldClosed = group(502, 'closed', 1, 0, 'no_findings');
    const offsets: number[] = [];
    vi.mocked(useApplicationRead).mockImplementation((name: string, input: Record<string, unknown> = {}) => {
        if (name === 'code_reviews_overview') return {
            data: { reviewRuns: 502, findingObservations: 2 }, isLoading: false, isFetching: false, refetch,
        } as never;
        if (name === 'code_reviews_dashboard') {
            const offset = Number(input.runOffset ?? 0);
            offsets.push(offset);
            return { data: {
                totalRuns: 502, scannedRuns: offset ? 2 : 500,
                windowComplete: false, runOffset: offset, hasMore: offset === 0, truncatedPrs: false,
                groups: offset ? [oldOpen, oldClosed] : [groups[0]],
            }, isLoading: false, isFetching: false, refetch } as never;
        }
        if (name === 'code_reviews_list_findings') return {
            data: { total: 0, items: [] }, isLoading: false, isFetching: false, refetch,
        } as never;
        throw new Error('Unexpected tool ' + name);
    });
    render(<CodeReviewsDashboard />);
    expect(screen.getByRole('region', { name: 'Open pull requests' })).not.toHaveTextContent('#501');
    fireEvent.click(screen.getByRole('button', { name: 'Older reviews' }));
    expect(offsets).toContain(500);
    expect(screen.getByRole('region', { name: 'Open pull requests' })).toHaveTextContent('#501');
    expect(screen.getByRole('region', { name: 'Closed pull requests' })).toHaveTextContent('#502');
    expect(screen.getByText('Result in window')).toBeInTheDocument();
    expect(screen.getByText(/Rounds 501–502 of 502/)).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Find pull request' })).toHaveAttribute('placeholder', 'Find in window…');
    fireEvent.click(screen.getByRole('button', { name: 'Details for example/atlas-demo #501' }));
    expect(screen.getByRole('tab', { name: 'Findings in window' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Newer reviews' }));
    expect(screen.getByRole('region', { name: 'Open pull requests' })).toHaveTextContent('#59');
    expect(screen.getByRole('region', { name: 'Open pull requests' })).not.toHaveTextContent('#501');
});

test('Code Reviews initial loads render KPI and open-PR card skeletons', () => {
    vi.mocked(useApplicationRead).mockImplementation(() => ({
        data: undefined, isLoading: true, isFetching: true, error: null, refetch,
    } as never));
    const view = render(<CodeReviewsDashboard />);
    expect(screen.getByRole('status', { name: 'Loading Code Reviews pull requests' }))
        .toHaveAttribute('aria-busy', 'true');
    expect(view.container.querySelectorAll('.cr-metrics .atlas-load-skeleton')).toHaveLength(4);
    expect(view.container.querySelectorAll('.cr-open-card')).toHaveLength(3);
    expect(screen.queryByText('Loading reviewed PRs…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Details for / })).not.toBeInTheDocument();
});

test('refresh preserves cached PR cards without overlaying initial skeletons', () => {
    const original = vi.mocked(useApplicationRead).getMockImplementation()!;
    vi.mocked(useApplicationRead).mockImplementation((name, args) => {
        const result = original(name, args);
        return { ...result, isLoading: false, isFetching: true } as never;
    });
    render(<CodeReviewsDashboard />);
    expect(screen.queryByRole('status', { name: 'Loading Code Reviews pull requests' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Details for / })).toHaveLength(3);
});

test('refresh rechecks both saved aggregates and GitHub lifecycle without publishing', () => {
    render(<CodeReviewsDashboard />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(calls).not.toContain('code_reviews_pr_summary');
});
