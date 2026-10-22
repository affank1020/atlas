import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CodeReviews } from './CodeReviews';
import { useApplicationRead } from './atlasApi';

vi.mock('./atlasApi', () => ({ useApplicationRead: vi.fn() }));
const refetch = vi.fn();

beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(useApplicationRead).mockImplementation((name: string) => {
        if (name === 'code_reviews_overview') return {
            data: { projectId: 'project', reviewRuns: 0, findingObservations: 0 },
            isLoading: false, isFetching: false, refetch,
        } as never;
        return { data: { items: [], total: 0, limit: 30, offset: 0 },
            isLoading: false, isFetching: false, refetch } as never;
    });
});
afterEach(cleanup);

test('Shows an honest empty state while retaining the existing GitHub review workflow', () => {
    render(<CodeReviews />);
    expect(screen.getByRole('heading', { name: 'Code Reviews' })).toBeInTheDocument();
    expect(screen.getByText('No reviews recorded yet')).toBeInTheDocument();
    expect(screen.getByText(/Existing independent reviews are still available on GitHub/)).toBeInTheDocument();
    expect(screen.getByText('0 total runs')).toBeInTheDocument();
});

test('Links only well-formed repository and PR identities', () => {
    const original = vi.mocked(useApplicationRead).getMockImplementation()!;
    vi.mocked(useApplicationRead).mockImplementation(((name: string, input: unknown) => {
        if (name === 'code_reviews_overview') return original(name as never, input as never);
        return { data: { total: 2, limit: 30, offset: 0, items: [
            { id: 'valid', data: { repository: 'affank1020/atlas', prNumber: 77,
                reviewedAt: '2026-10-22T11:00:00.000Z', headSha: 'a'.repeat(40), reviewer: 'Code Reviewer', verdict: 'no_findings' } },
            { id: 'invalid', data: { repository: 'https://evil.example/path', prNumber: 2,
                reviewedAt: '2026-10-22T11:00:00.000Z', headSha: 'b'.repeat(40), verdict: 'changes_requested' } },
        ] }, isLoading: false, isFetching: false, refetch } as never;
    }) as never);
    render(<CodeReviews />);
    expect(screen.getByRole('link', { name: /affank1020\/atlas #77/ })).toHaveAttribute('href', 'https://github.com/affank1020/atlas/pull/77');
    expect(screen.getByRole('link', { name: /affank1020\/atlas #77/ })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/Some saved review records/)).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
});

test('Surfaces read failures instead of claiming an empty review history', () => {
    vi.mocked(useApplicationRead).mockReturnValue({
        error: { message: 'Database unavailable' }, isLoading: false, isFetching: false, refetch,
    } as never);
    render(<CodeReviews />);
    expect(screen.getByRole('alert')).toHaveTextContent('Database unavailable');
    expect(screen.queryByText('No reviews recorded yet')).not.toBeInTheDocument();
});
