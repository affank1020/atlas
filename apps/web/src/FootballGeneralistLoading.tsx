import { Skeleton } from './Skeletons';
import './football-generalist-experience.css';
import './FootballGeneralistLoading.css';

/** AI Football owns its loading layout, including its real activity/curriculum panels. */
export function FootballGeneralistContentLoading({ decorative = false }: { decorative?: boolean }) {
    return <div className="fg-stack" role={decorative ? undefined : 'status'}
        aria-label={decorative ? undefined : 'Loading Football Generalist'}
        aria-busy={decorative ? undefined : true} aria-hidden={decorative || undefined}>
        <section className="fg-panel fg-active-panel">
            <div className="fg-panel-title"><h2>Active activity</h2><Skeleton width={110} height={12} /></div>
            <Skeleton width="68%" height={13} />
        </section>
        <div className="fg-stats">
            {['Contract', 'Observations', 'Actions', 'Recorded runs', 'Registered policies'].map(label =>
                <div key={label}><small>{label}</small><Skeleton width="67%" height={18} /></div>)}
        </div>
        <section className="fg-panel">
            <div className="fg-panel-title"><h2>Curriculum</h2><Skeleton width={94} height={12} /></div>
            <div className="fg-curriculum">
                {Array.from({ length: 3 }, (_, index) =>
                    <div className="fg-curriculum-row" key={index}>
                        <Skeleton width={54} height={13} /><Skeleton width="70%" height={13} />
                        <Skeleton width={76} height={12} />
                    </div>)}
            </div>
        </section>
        <section className="fg-panel">
            <div className="fg-panel-title"><h2>Recent runs</h2><Skeleton width={66} height={12} /></div>
            {Array.from({ length: 3 }, (_, index) => <div className="fg-list-row" key={index}>
                <Skeleton width="80%" height={13} /><Skeleton width="65%" height={12} />
                <Skeleton width={68} height={12} />
            </div>)}
        </section>
        <section className="fg-panel">
            <div className="fg-panel-title"><h2>Evaluations</h2><Skeleton width={66} height={12} /></div>
            {Array.from({ length: 2 }, (_, index) => <div className="fg-list-row" key={index}>
                <Skeleton width="78%" height={13} /><Skeleton width="60%" height={12} />
                <Skeleton width={68} height={12} />
            </div>)}
        </section>
    </div>;
}

export function FootballGeneralistApplicationLoading() {
    return <main className="fg" role="status" aria-label="Loading Football Generalist application" aria-busy="true">
        <header className="fg-heading" aria-hidden="true">
            <div><h1>Generalist</h1><Skeleton width={275} height={12} /></div>
            <Skeleton width={82} height={36} />
        </header>
        <nav className="fg-nav" aria-hidden="true">
            {['Home', 'Drills', 'Train', 'Runs', 'Policies', 'Evaluate', 'Watch', 'Contract', 'Legacy archive'].map((name, index) =>
                <span className={'fg-loading-tab' + (index === 0 ? ' active' : '')} key={name}>{name}</span>)}
        </nav>
        <FootballGeneralistContentLoading decorative />
    </main>;
}
