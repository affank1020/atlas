import { Skeleton } from './Skeletons';
import './code-reviews-dashboard.css';
import './CodeReviewsDashboardLoading.css';

/** Retained compact PR table-row skeleton for list-style consumers. */
export function CodeReviewsListLoading({ decorative = false }: { decorative?: boolean }) {
    return <div role={decorative ? undefined : 'status'}
        aria-label={decorative ? undefined : 'Loading Code Reviews pull requests'}
        aria-busy={decorative ? undefined : true} aria-hidden={decorative || undefined}>
        <div className="cr-table-head" aria-hidden="true">
            <span>PR</span><span>Rounds</span><span>Findings</span>
            <span>Latest result</span><span>Reviewed</span><span />
        </div>
        {Array.from({ length: 5 }, (_, index) =>
            <article className="cr-pr" aria-hidden="true" key={index}>
                <div className="cr-pr-main">
                    <div className="cr-pr-identity">
                        <Skeleton width={index % 2 ? '74%' : '87%'} height={14} />
                        <div className="cr-severity-summary"><Skeleton width={49} height={17} />
                            {index % 2 === 0 && <Skeleton width={45} height={17} />}</div>
                    </div>
                    <div className="cr-number"><Skeleton width={25} height={19} /></div>
                    <div className="cr-number"><Skeleton width={29} height={19} />
                        <Skeleton width={52} height={11} /></div>
                    <span className="cr-verdict"><Skeleton width={105} height={13} /></span>
                    <span className="cr-date"><Skeleton width={78} height={12} /></span>
                    <span className="cr-expand cr-loading-expand"><Skeleton width={25} height={25} /></span>
                </div>
            </article>)}
    </div>;
}

/** Shared open-PR cards for both the bundle fallback and initial data loading. */
export function CodeReviewsOpenCardsLoading({ decorative = false }: { decorative?: boolean }) {
    return <div className="cr-open-section" role={decorative ? undefined : 'status'}
        aria-label={decorative ? undefined : 'Loading Code Reviews pull requests'}
        aria-busy={decorative ? undefined : true} aria-hidden={decorative || undefined}>
        <div className="cr-section-title"><h2>Open PRs</h2></div>
        <div className="cr-open-grid" aria-hidden="true">
            {Array.from({ length: 3 }, (_, i) => <article className="cr-open-card" key={i}>
                <div className="cr-card-top"><Skeleton width="70%" height={14} />
                    <Skeleton width={85} height={13} /></div>
                <div className="cr-card-stats">
                    {Array.from({ length: 3 }, (_, j) =>
                        <div key={j}><Skeleton width={32} height={22} />
                            <Skeleton width={48} height={11} /></div>)}
                </div>
                <div className="cr-severity-summary"><Skeleton width={50} height={16} /></div>
                <div className="cr-card-bottom"><Skeleton width={75} height={12} />
                    <Skeleton width={55} height={30} /></div>
            </article>)}
        </div>
    </div>;
}

/** No app bundle import: this component is available while Code Reviews JS loads. */
export function CodeReviewsApplicationLoading() {
    return <section className="code-reviews cr-dashboard" role="status"
        aria-label="Loading Code Reviews" aria-busy="true">
        <header className="cr-header" aria-hidden="true"><h1>Code Reviews</h1>
            <Skeleton width={76} height={34} /></header>
        <div className="cr-metrics" aria-hidden="true">
            {['Review rounds', 'Findings recorded', 'Findings / review', 'PRs reviewed'].map(label =>
                <article key={label}><span>{label}</span><strong><Skeleton width={67} height={29} /></strong></article>)}
        </div>
        <div className="cr-overview-tools" aria-hidden="true">
            <Skeleton width={190} height={34} />
            <Skeleton width={138} height={34} />
        </div>
        <CodeReviewsOpenCardsLoading decorative />
    </section>;
}

export function CodeReviewsDetailLoading({ variant }: { variant: 'findings' | 'rounds' | 'github' }) {
    return <div role="status" aria-label={'Loading ' + (variant === 'github' ? 'GitHub status' : variant === 'rounds' ? 'review rounds' : 'review findings')}
        aria-busy="true">
        {variant === 'github' ? <div className="cr-status-grid" aria-hidden="true">
            {Array.from({ length: 3 }, (_, index) =>
                <div key={index}><Skeleton width="70%" height={12} /><Skeleton width="45%" height={16} /></div>)}
        </div> : variant === 'rounds' ?
            Array.from({ length: 3 }, (_, index) =>
                <div className="cr-round" key={index} aria-hidden="true">
                    <div className="cr-loading-round"><Skeleton width="63%" height={14} /><Skeleton width={75} height={12} /></div>
                </div>) :
            Array.from({ length: 3 }, (_, index) =>
                <article className="cr-finding" key={index} aria-hidden="true">
                    <div className="cr-finding-head"><Skeleton width={45} height={17} />
                        <Skeleton width="55%" height={14} /></div>
                    <Skeleton width="82%" height={11} />
                </article>)}
    </div>;
}
