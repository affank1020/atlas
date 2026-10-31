import type { CSSProperties } from 'react';
import './Skeletons.css';

/** Visual placeholders for Atlas-owned initial reads. Decorative elements never enter the tab order. */
export function Skeleton({ width = '100%', height = 12, round = false }: {
    width?: CSSProperties['width']; height?: CSSProperties['height']; round?: boolean;
}) {
    return <span className={round ? 'atlas-load-skeleton atlas-load-skeleton-round' : 'atlas-load-skeleton'}
        style={{ width, height }} aria-hidden="true" />;
}

export type SkeletonVariant = 'nav' | 'list' | 'cards' | 'applications' | 'activity' | 'metrics' | 'table' | 'view' | 'panel' | 'run';

export function SkeletonRows({ label, rows = 3, variant = 'list', className = '' }: {
    label: string; rows?: number; variant?: SkeletonVariant; className?: string;
}) {
    return <div className={`atlas-load-skeleton-group atlas-load-skeleton-${variant} ${className}`}
        role="status" aria-label={label} aria-busy="true">
        {Array.from({ length: rows }, (_, index) => {
            if (variant === 'nav') return <div className="atlas-load-skeleton-nav-item" key={index} aria-hidden="true">
                <Skeleton width={22} height={22} /><Skeleton width={index % 2 ? '56%' : '72%'} height={12} />
            </div>;
            if (variant === 'metrics') return <div className="atlas-load-skeleton-metric" key={index} aria-hidden="true">
                <Skeleton width="66%" height={11} /><Skeleton width="48%" height={27} /><Skeleton width="74%" height={10} />
            </div>;
            if (variant === 'cards' || variant === 'applications' || variant === 'view')
                return <div className="atlas-load-skeleton-card" key={index} aria-hidden="true">
                    {variant === 'view' ? <Skeleton height={124} /> : <Skeleton width={44} height={44} />}
                    <Skeleton width="67%" height={16} /><Skeleton width="93%" height={11} /><Skeleton width="76%" height={11} />
                </div>;
            if (variant === 'panel') return <div className="atlas-load-skeleton-panel" key={index} aria-hidden="true">
                <Skeleton width="34%" height={17} /><Skeleton width="90%" height={11} />
                <Skeleton width="72%" height={11} /><Skeleton width="100%" height={27} />
            </div>;
            return <div className="atlas-load-skeleton-row" key={index} aria-hidden="true">
                {(variant === 'activity' || variant === 'run') && <Skeleton width={28} height={28} />}
                <div className="atlas-load-skeleton-row-copy">
                    <Skeleton width={index % 2 ? '47%' : '64%'} height={13} />
                    <Skeleton width={index % 2 ? '70%' : '84%'} height={10} />
                </div>
                <Skeleton width={variant === 'table' ? '25%' : 68} height={11} />
            </div>;
        })}
    </div>;
}
