import { Skeleton } from './Skeletons';
import './football-generalist-experience.css';
import './FootballGeneralistLoading.css';

/** Loading state for the current FYP training experience. */
export function FootballGeneralistContentLoading({ decorative = false }: { decorative?: boolean }) {
    return <div className="fg-stack" role={decorative ? undefined : 'status'}
        aria-label={decorative ? undefined : 'Loading FYP training'}
        aria-busy={decorative ? undefined : true} aria-hidden={decorative || undefined}>
        <section className="fg-panel">
            <div className="fg-panel-title"><h2>FYP training</h2><Skeleton width={110} height={12} /></div>
            <Skeleton width="68%" height={13} />
            <div className="fg-form">
                <Skeleton width="100%" height={38} />
                <Skeleton width="100%" height={38} />
                <Skeleton width="100%" height={38} />
            </div>
        </section>
    </div>;
}

export function FootballGeneralistApplicationLoading() {
    return <main className="fg" role="status" aria-label="Loading FYP Football application" aria-busy="true">
        <header className="fg-heading" aria-hidden="true">
            <h1>FYP Football</h1>
        </header>
        <FootballGeneralistContentLoading decorative />
    </main>;
}
