import { useEffect, useRef } from 'react';
import { useApplicationRead } from './atlasApi';

type GithubThread = {
    rootCommentId?: number; mappingState: 'verified' | 'unmapped';
    resolutionState: 'resolved_on_github' | 'open_on_github' | 'unknown';
    threadId?: string; isOutdated?: boolean;
    viewerCanResolveWithReadToken?: boolean;
};
type GithubResolution = { lineageKey: string; thread: GithubThread };
type ThreadState = {
    repository: string; prNumber: number; readOnly: true; resolutionSupported: false;
    totalGitHubThreads: number; ownedRootCount: number; mappedOwnedRoots: number;
    mappingComplete: boolean; ownedThreads: GithubThread[]; resolutions: GithubResolution[];
};

const safeInteger = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const safeRootId = (n: unknown): n is number => safeInteger(n) && n > 0;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
function validStatus(input: unknown, repository: string, prNumber: number): input is ThreadState {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const value = input as Partial<ThreadState>;
    return value.repository === repository && value.prNumber === prNumber &&
        value.readOnly === true && value.resolutionSupported === false &&
        safeInteger(value.totalGitHubThreads) && safeInteger(value.ownedRootCount) &&
        safeInteger(value.mappedOwnedRoots) && value.mappedOwnedRoots <= value.ownedRootCount &&
        typeof value.mappingComplete === 'boolean' &&
        Array.isArray(value.ownedThreads) && value.ownedThreads.length === value.ownedRootCount &&
        value.ownedThreads.every(t => t && (t.mappingState === 'verified' || t.mappingState === 'unmapped') &&
            (t.resolutionState === 'resolved_on_github' || t.resolutionState === 'open_on_github' || t.resolutionState === 'unknown') &&
            safeRootId(t.rootCommentId) &&
            (t.mappingState !== 'verified' || typeof t.threadId === 'string')) &&
        Array.isArray(value.resolutions) && value.resolutions.every(r =>
            r && typeof r.lineageKey === 'string' && keyPattern.test(r.lineageKey) &&
            r.thread && (r.thread.mappingState === 'verified' || r.thread.mappingState === 'unmapped'));
}
const remoteLabel = (state: GithubThread['resolutionState']) =>
    state === 'resolved_on_github' ? 'Resolved on GitHub'
        : state === 'open_on_github' ? 'Open on GitHub' : 'Unverified / unknown';

/** Only mounted by an explicit user action. Does not resolve or publish anything. */
export function CodeReviewThreads({ repository, prNumber, refreshVersion }: {
    repository: string; prNumber: number; refreshVersion: number;
}) {
    const previous = useRef(refreshVersion);
    const query = useApplicationRead<ThreadState>('code_reviews_review_thread_state',
        { repository, prNumber }, true);
    useEffect(() => {
        if (previous.current !== refreshVersion) {
            previous.current = refreshVersion;
            void query.refetch();
        }
    }, [refreshVersion, query.refetch]);
    const valid = validStatus(query.data, repository, prNumber);
    const state = valid ? query.data : null;
    const resolved = state?.ownedThreads.filter(t => t.resolutionState === 'resolved_on_github').length ?? 0;
    const open = state?.ownedThreads.filter(t => t.resolutionState === 'open_on_github').length ?? 0;
    const unknown = state ? state.ownedRootCount - resolved - open : 0;
    return <section className="code-reviews-remote" aria-label="GitHub conversation status">
        <h4>GitHub conversations</h4>
        <p className="code-reviews-subtitle">Read-only, on-demand verification. GitHub conversation state is separate
            from reviewer-assessed code fixes. Only Atlas Bot-owned roots are matched; unrelated GitHub
            review threads are not counted as managed discussions.</p>
        {(query.isLoading || query.isFetching && !query.data) && <p role="status">Checking GitHub review threads…</p>}
        {query.error && <p role="alert" className="notice error">
            GitHub conversation state is unavailable: {query.error.message}. No thread is assumed resolved.
        </p>}
        {query.data && !valid && !query.error && <p role="alert" className="notice error">
            GitHub returned unsupported or inconsistent thread state. No conversation status can be verified.
        </p>}
        {state && !query.error && <>
            <p>{state.ownedRootCount} Atlas-owned root{state.ownedRootCount === 1 ? '' : 's'}:
                {' '}{open} open · {resolved} resolved on GitHub · {unknown} unknown.
                {' '}{state.totalGitHubThreads} total GitHub review threads (including unmanaged discussions).</p>
            {!state.mappingComplete && <p role="status">Some Atlas-owned roots could not be matched
                to a GitHub GraphQL conversation. Their state remains unknown.</p>}
            {state.ownedRootCount === 0 && <p>No Atlas-owned inline conversations found.
                This does not mean the PR has no discussions or no unresolved findings.</p>}
            {state.ownedThreads.length > 0 && <div className="code-reviews-thread-list">
                {state.ownedThreads.map((thread, index) =>
                    <article className="code-reviews-thread" key={thread.rootCommentId ?? index}>
                        <strong>Inline thread {index + 1}</strong>
                        <span>{remoteLabel(thread.resolutionState)}
                            {thread.isOutdated ? ' · Outdated anchor' : ''}
                            {thread.mappingState === 'unmapped' ? ' · ID unmapped' : ''}</span>
                        {safeRootId(thread.rootCommentId) && <a
                            href={`https://github.com/${repository}/pull/${prNumber}#discussion_r${thread.rootCommentId}`}
                            target="_blank" rel="noopener noreferrer">Open discussion ↗</a>}
                    </article>)}
            </div>}
            {state.resolutions.length > 0 && <div className="code-reviews-remote-resolutions">
                <h5>Reviewer-assessed fixes versus GitHub conversations</h5>
                {state.resolutions.map((event, index) => <p key={event.lineageKey + index}>
                    <code>{event.lineageKey}</code>: reviewer asserted a fix;
                    {' '}{event.thread.resolutionState === 'resolved_on_github' ? 'conversation resolved on GitHub'
                        : event.thread.resolutionState === 'open_on_github' ? 'conversation still open on GitHub'
                        : 'conversation state unknown'}.
                </p>)}
            </div>}
            <p className="code-reviews-subtitle">These are observations at the time of the last request,
                not a live subscription or authority to resolve conversations.</p>
        </>}
    </section>;
}
