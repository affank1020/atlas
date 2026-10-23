import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    expect(screen.getByText(/GitHub review history is separate until it is explicitly imported/)).toBeInTheDocument();
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

const runId = 'a4d0a616-361e-4bb2-b9ba-3a870085d107';
const anotherRunId = '26dfa81b-53e3-46e0-9e6d-e433a804abc0';
const makeRun = (id: string, n: number) => ({ id, data: {
    repository: 'affank1020/atlas', prNumber: n, headSha: 'a'.repeat(40),
    reviewer: 'Code Reviewer', reviewedAt: '2026-10-23T10:30:00.000Z',
    verdict: 'non_blocking', counts: { sev3: 1 },
    coverage: { source: 'atlas_structured_submission',
        githubPublication: { state: 'published', githubReviewId: '12345' } },
} });

test('Expanding a review loads only its findings and preserves its verified source and publication context', () => {
    vi.mocked(useApplicationRead).mockImplementation((name: string, input: Record<string, unknown> = {}) => {
        if (name === 'code_reviews_overview') return { data: {
            projectId: 'project', reviewRuns: 2, findingObservations: 2 }, isLoading:false,isFetching:false,refetch } as never;
        if (name === 'code_reviews_list_runs') return { data: { total:2,items:[
            makeRun(runId,94), makeRun(anotherRunId,95),
        ]}, isLoading:false,isFetching:false,refetch } as never;
        if (name === 'code_reviews_list_findings') {
            const n = input.reviewRunId === runId ? '94' : '95';
            return { data: { total: 1, items: [{ id:'finding-1', data: {
                reviewRunId: input.reviewRunId, severity:'sev3', title:`Finding ${n}`,
                description:'A concrete finding', findingKey:'1', state:'new',
                filePath:'apps/server/src/apps/code-reviews.ts', line: 20,
            }}]}, isLoading:false,isFetching:false,refetch } as never;
        }
        throw Error('unexpected tool ' + name);
    });
    render(<CodeReviews />);
    expect(screen.getAllByText(/SEV3: 1/)).toHaveLength(2);
    expect(screen.queryByText(/Finding 94/)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name:'View findings' })[0]!);
    expect(screen.getByText(/Finding 94/)).toBeInTheDocument();
    expect(screen.getByText('Submitted to Atlas')).toBeInTheDocument();
    expect(screen.getByRole('link', {name:/View review/}))
        .toHaveAttribute('href','https://github.com/affank1020/atlas/pull/94#pullrequestreview-12345');
    expect(vi.mocked(useApplicationRead)).toHaveBeenCalledWith('code_reviews_list_findings',
        {reviewRunId:runId,limit:50,offset:0},true);
    fireEvent.click(screen.getByRole('button', {name:'Hide findings'}));
    expect(screen.queryByText(/Finding 94/)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', {name:'View findings'})[1]!);
    expect(screen.getByText(/Finding 95/)).toBeInTheDocument();
    expect(screen.queryByText(/Finding 94/)).not.toBeInTheDocument();
});

test('Historical missing or unverified observations never imply a clean PR', () => {
    vi.mocked(useApplicationRead).mockImplementation((name: string) => {
        if (name === 'code_reviews_overview') return {data:{reviewRuns:1,findingObservations:0},
            isLoading:false,isFetching:false,refetch} as never;
        if (name === 'code_reviews_list_runs') return {data:{total:1,items:[{
            ...makeRun(runId,94),data:{
                ...makeRun(runId,94).data,coverage:{source:'github_pull_request_review'}, counts:undefined,
            },
        }]},isLoading:false,isFetching:false,refetch} as never;
        return {data:{total:0,items:[]},isLoading:false,isFetching:false,refetch} as never;
    });
    render(<CodeReviews />);
    fireEvent.click(screen.getByRole('button',{name:'View findings'}));
    expect(screen.getByText('Imported from GitHub')).toBeInTheDocument();
    expect(screen.getByText(/does not establish that the PR has no issues/)).toBeInTheDocument();
    expect(screen.queryByRole('link',{name:/View review/})).not.toBeInTheDocument();
});

test('Malformed finding records are omitted and errors are surfaced without hiding the review', () => {
    let hasError=false;
    vi.mocked(useApplicationRead).mockImplementation((name: string) => {
        if(name === 'code_reviews_overview') return {data:{reviewRuns:1,findingObservations:2},
            isLoading:false,isFetching:false,refetch} as never;
        if(name === 'code_reviews_list_runs') return {data:{total:1,items:[makeRun(runId,94)]},
            isLoading:false,isFetching:false,refetch} as never;
        if(hasError) return {error:{message:'Access denied'},isLoading:false,isFetching:false,refetch} as never;
        return {data:{total:2,items:[
            {id:'bad',data:{severity:'malicious',title:'Bad',description:'Untrusted',state:'new'}},
            {id:'valid',data:{severity:'sev4',title:'Use safe values',description:'Details',state:'unverified'}},
        ]},isLoading:false,isFetching:false,refetch} as never;
    });
    const rendered=render(<CodeReviews/>);
    fireEvent.click(screen.getByRole('button',{name:'View findings'}));
    expect(screen.getByText(/Use safe values/)).toBeInTheDocument();
    expect(screen.getByText('Unverified historical finding')).toBeInTheDocument();
    expect(screen.queryByText('Bad')).not.toBeInTheDocument();
    expect(screen.getByText(/Some finding records have invalid/)).toBeInTheDocument();
    rendered.unmount();
    hasError=true;
    render(<CodeReviews/>);
    fireEvent.click(screen.getByRole('button',{name:'View findings'}));
    expect(screen.getByRole('alert')).toHaveTextContent('Access denied');
});
