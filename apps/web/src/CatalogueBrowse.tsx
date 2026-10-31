import { useId, type ReactNode } from 'react';
import './catalogue.css';
import { Skeleton } from './Skeletons';

/** Token-based, case-insensitive catalogue search shared by Projects and Applications. */
export function filterCatalogue<T>(items: readonly T[], query: string, searchText: (item: T) => string): T[] {
    const terms = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [...items];
    return items.filter(item => {
        const text = searchText(item).normalize('NFKC').toLocaleLowerCase();
        return terms.every(term => text.includes(term));
    });
}

/** Shared catalogue chrome. Page-specific cards and actions belong to callers. */
export function CatalogueHeading({ title, actions }: { title: string; actions?: ReactNode }) {
    return <header className="page-head">
        <div><h1>{title}</h1></div>
        {actions && <div className="actions">{actions}</div>}
    </header>;
}

export function CatalogueToolbar({
    label, placeholder, query, onQueryChange, count, itemName, children,
}: {
    label: string;
    placeholder: string;
    query: string;
    onQueryChange: (query: string) => void;
    count: number | null;
    itemName: string;
    children?: ReactNode;
}) {
    const searchId = useId();
    return <div className="browse-toolbar catalogue-toolbar">
        <label htmlFor={searchId}>{label}
            <input id={searchId} type="search" placeholder={placeholder} value={query}
                onChange={event => onQueryChange(event.currentTarget.value)} />
        </label>
        {children}
        <span aria-live="polite">{count === null ? <Skeleton width={80} height={12} /> : `${count} ${itemName}${count === 1 ? '' : 's'}`}</span>
    </div>;
}
