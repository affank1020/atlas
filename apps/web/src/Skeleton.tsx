import './Skeleton.css';

/** Only use for the first unresolved load; keep cached content visible during refetches. */
export function SkeletonLine({ width = 'normal' }: { width?: 'normal' | 'short' | 'long' }) {
    return <span className={`atlas-skeleton atlas-skeleton-line ${width === 'normal' ? '' : width}`} aria-hidden="true" />;
}
export function SkeletonRows({ count = 3, variant = 'default', label = 'Loading content' }: { count?: number; variant?: 'default' | 'activity' | 'sidebar'; label?: string }) {
    return <div className={`atlas-skeleton-rows atlas-skeleton-${variant}`} role="status" aria-label={label} aria-busy="true">
        {Array.from({ length: count }, (_, index) => <div className="atlas-skeleton-row" key={index} aria-hidden="true">
            <span className="atlas-skeleton atlas-skeleton-icon" />
            <span className="atlas-skeleton-lines"><SkeletonLine width="long" /><SkeletonLine width="short" /></span>
        </div>)}
    </div>;
}
export function SkeletonCards({ count = 3, label = 'Loading cards', decorative = false }: { count?: number; label?: string; decorative?: boolean }) {
    return <div className="atlas-skeleton-grid" role={decorative ? undefined : 'status'}
        aria-label={decorative ? undefined : label} aria-busy={decorative ? undefined : true}
        aria-hidden={decorative ? true : undefined}>
        {Array.from({ length: count }, (_, index) => <div className="atlas-skeleton-card" key={index} aria-hidden="true">
            <span className="atlas-skeleton atlas-skeleton-icon" />
            <span className="atlas-skeleton-lines"><SkeletonLine width="short" /><SkeletonLine width="long" /><SkeletonLine /></span>
        </div>)}
    </div>;
}
export function SkeletonApplicationWindow() {
    return <div className="atlas-skeleton-app-window" role="status" aria-label="Loading application interface" aria-busy="true">
        <SkeletonLine width="short" /><SkeletonCards count={3} decorative />
    </div>;
}
