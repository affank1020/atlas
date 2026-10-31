import { Skeleton } from './Skeletons';
import './Portfolio.css';
import './PortfolioLoading.css';

/** Portfolio owns the geometry used by both its lazy-bundle and data-loading states. */
export function PortfolioWorkspaceLoading({ decorative = false }: { decorative?: boolean }) {
    return <div className="portfolio-workspace" role={decorative ? undefined : 'status'}
        aria-label={decorative ? undefined : 'Loading Portfolio workspace'}
        aria-busy={decorative ? undefined : true} aria-hidden={decorative || undefined}>
        <aside className="portfolio-sidebar">
            <div className="portfolio-types">
                {Array.from({ length: 6 }, (_, index) =>
                    <div className="portfolio-loading-type" key={index}>
                        <Skeleton width={index % 2 ? '58%' : '72%'} height={12} />
                        <Skeleton width={17} height={10} />
                    </div>)}
            </div>
            <div className="portfolio-list-head">
                <div><Skeleton width={100} height={15} /><Skeleton width={56} height={10} /></div>
                <Skeleton width={52} height={31} />
            </div>
            <div className="portfolio-search"><Skeleton width="74%" height={12} /></div>
            <div className="portfolio-entry-list">
                {Array.from({ length: 5 }, (_, index) => <div className="portfolio-entry" key={index}>
                    <Skeleton width={38} height={38} />
                    <span className="portfolio-entry-copy">
                        <Skeleton width={index % 2 ? '69%' : '88%'} height={12} />
                        <Skeleton width="52%" height={10} />
                    </span>
                    <Skeleton width={7} height={7} round />
                </div>)}
            </div>
        </aside>
        <section className="portfolio-editor">
            <div className="portfolio-editor-top">
                <div className="portfolio-editor-heading">
                    <Skeleton width={75} height={11} />
                    <Skeleton width={225} height={28} />
                    <Skeleton width={150} height={11} />
                </div>
                <Skeleton width={62} height={19} />
            </div>
            <div className="portfolio-editor-content">
                <section className="portfolio-section">
                    <div className="portfolio-section-intro"><Skeleton width={85} height={18} /></div>
                    <div className="portfolio-form">
                        {Array.from({ length: 4 }, (_, index) =>
                            <div className={'portfolio-loading-field' + (index === 3 ? ' portfolio-wide-field' : '')} key={index}>
                                <Skeleton width={index % 2 ? 82 : 112} height={11} />
                                <Skeleton width="100%" height={index === 3 ? 110 : 40} />
                            </div>)}
                    </div>
                </section>
                {Array.from({ length: 2 }, (_, index) =>
                    <div className="portfolio-loading-fold" key={index}>
                        <Skeleton width={index ? 110 : 140} height={15} />
                        <Skeleton width={19} height={15} />
                    </div>)}
            </div>
        </section>
    </div>;
}

/** The media view uses a full-width asset grid, not the content editor/sidebar. */
export function PortfolioMediaLoading({ decorative = false }: { decorative?: boolean }) {
    return <section className="portfolio-media" role={decorative ? undefined : 'status'}
        aria-label={decorative ? undefined : 'Loading Portfolio media library'}
        aria-busy={decorative ? undefined : true} aria-hidden={decorative || undefined}>
        <header className="portfolio-media-header">
            <div><p className="eyebrow"><Skeleton width={95} height={11} /></p>
                <h2>Media library</h2><Skeleton width={275} height={13} /></div>
            <Skeleton width={135} height={36} />
        </header>
        <div className="portfolio-media-toolbar">
            <div className="portfolio-media-search portfolio-media-search-loading"><Skeleton width="70%" height={13} /></div>
            <div className="portfolio-media-archived-loading"><Skeleton width={105} height={15} /></div>
            <span className="portfolio-media-count"><Skeleton width={52} height={13} /></span>
        </div>
        <div className="portfolio-media-grid">
            {Array.from({ length: 6 }, (_, index) =>
                <article key={index}>
                    <div className="portfolio-media-preview"><Skeleton width="100%" height="100%" /></div>
                    <div className="portfolio-media-card-content">
                        <Skeleton width={index % 2 ? '73%' : '89%'} height={14} />
                        <Skeleton width="41%" height={11} />
                        <div className="portfolio-media-card-actions">
                            <Skeleton width={92} height={13} /><Skeleton width={58} height={13} />
                        </div>
                        <div className="portfolio-media-details"><Skeleton width={82} height={12} /></div>
                    </div>
                </article>)}
        </div>
    </section>;
}

export function PortfolioApplicationLoading() {
    // The host renders this before the lazy Portfolio bundle has loaded.
    // Read the same hash parameter that Portfolio uses to choose its first view.
    const mediaSelected = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tab') === 'media';
    return <div className="portfolio-app" role="status" aria-label="Loading Portfolio" aria-busy="true">
        <header className="portfolio-head" aria-hidden="true">
            <div className="portfolio-head-copy"><h1>Portfolio</h1>
                <Skeleton width={235} height={12} /></div>
            <div className="portfolio-summary" aria-label="Portfolio overview">
                {['Live entries', 'In progress', 'Assets'].map(label =>
                    <span key={label}><b><Skeleton width={37} height={23} /></b><small>{label}</small></span>)}
            </div>
        </header>
        <nav className="portfolio-tabs" aria-hidden="true">
            <div className="portfolio-tab-group"><span className={'portfolio-loading-tab' + (!mediaSelected ? ' active' : '')}>Content</span>
                <span className={'portfolio-loading-tab' + (mediaSelected ? ' active' : '')}>Media library</span></div>
            <Skeleton width={93} height={15} />
        </nav>
        {mediaSelected ? <PortfolioMediaLoading decorative /> : <PortfolioWorkspaceLoading decorative />}
    </div>;
}
