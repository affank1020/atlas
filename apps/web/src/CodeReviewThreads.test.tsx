import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CodeReviewThreads } from './CodeReviewThreads';
import { useApplicationRead } from './atlasApi';

vi.mock('./atlasApi', () => ({ useApplicationRead: vi.fn() }));
const repository = 'affank1020/atlas', prNumber = 137;
const refresh = vi.fn();
const valid = {
    repository, prNumber, readOnly: true, resolutionSupported: false,
    totalGitHubThreads: 4, ownedRootCount: 3, mappedOwnedRoots: 2,
    mappingComplete: false,
    ownedThreads: [
        { rootCommentId: 72, mappingState: 'verified', threadId: 'PRRT_123456789',
            resolutionState: 'open_on_github', isOutdated: false },
        { rootCommentId: 73, mappingState: 'verified', threadId: 'PRRT_987654321',
            resolutionState: 'resolved_on_github', isOutdated: true },
        { rootCommentId: 74, mappingState: 'unmapped', resolutionState: 'unknown' },
    ],
    resolutions: [{ lineageKey: 'root-a', thread: {
        rootCommentId: 72, mappingState: 'verified', threadId: 'PRRT_123456789',
        resolutionState: 'open_on_github',
    } }],
};
beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useApplicationRead).mockReturnValue({ data: valid,
        isLoading: false, isFetching: false, refetch: refresh } as never);
});
afterEach(cleanup);

test('Displays verified remote conversation states without treating reviewer-assessed fixes as resolved', () => {
    render(<CodeReviewThreads repository={repository} prNumber={prNumber} refreshVersion={0} />);
    expect(vi.mocked(useApplicationRead)).toHaveBeenCalledWith('code_reviews_review_thread_state',
        { repository, prNumber }, true);
    expect(screen.getByText(/3 Atlas-owned roots:/)).toHaveTextContent(
        '1 open · 1 resolved on GitHub · 1 unknown');
    expect(screen.getByText(/Some Atlas-owned roots could not be matched/)).toBeInTheDocument();
    expect(screen.getByText(/conversation still open on GitHub/)).toBeInTheDocument();
    expect(screen.getByText(/Outdated anchor/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Open discussion/ })).toHaveLength(3);
    expect(screen.getAllByRole('link', { name: /Open discussion/ })[0])
        .toHaveAttribute('href', 'https://github.com/affank1020/atlas/pull/137#discussion_r72');
    expect(screen.getAllByRole('link', { name: /Open discussion/ })[0])
        .toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test('Empty inventory is not confused with a clean or discussion-free PR', () => {
    vi.mocked(useApplicationRead).mockReturnValue({
        data: {...valid, totalGitHubThreads: 2, ownedRootCount: 0, mappedOwnedRoots: 0,
            mappingComplete: true, ownedThreads: [], resolutions: []},
        isLoading: false, isFetching: false, refetch: refresh,
    } as never);
    render(<CodeReviewThreads repository={repository} prNumber={prNumber} refreshVersion={0} />);
    expect(screen.getByText(/No Atlas-owned inline conversations found/)).toBeInTheDocument();
    expect(screen.getByText(/does not mean the PR has no discussions/)).toBeInTheDocument();
});

test('Rejects mismatched and malformed remote results instead of showing false resolution counts', () => {
    for (const bad of [
        {...valid, repository: 'somebody-else/atlas'},
        {...valid, ownedRootCount: 1},
        {...valid, mappedOwnedRoots: 3},
        {...valid, mappingComplete: true},
        {...valid, ownedThreads: [{rootCommentId: -1, mappingState: 'verified',
            threadId: 'PRRT_123456789', resolutionState: 'resolved_on_github'}]},
        {...valid, readOnly: false},
    ]) {
        vi.mocked(useApplicationRead).mockReturnValue({
            data: bad, isLoading: false, isFetching: false, refetch: refresh,
        } as never);
        const result = render(<CodeReviewThreads repository={repository} prNumber={prNumber} refreshVersion={0} />);
        expect(screen.getByRole('alert')).toHaveTextContent('unsupported or inconsistent thread state');
        expect(screen.queryByText(/3 Atlas-owned roots:/)).not.toBeInTheDocument();
        result.unmount();
    }
});

test('Remote errors remain visible without implying missing threads are resolved', () => {
    vi.mocked(useApplicationRead).mockReturnValue({ error: {message: 'GraphQL App permission unavailable'},
        isLoading: false, isFetching: false, refetch: refresh } as never);
    render(<CodeReviewThreads repository={repository} prNumber={prNumber} refreshVersion={0} />);
    expect(screen.getByRole('alert')).toHaveTextContent('No thread is assumed resolved');
});
