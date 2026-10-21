import { useEffect, useState, type ReactNode } from 'react';
import { ShellIcon } from './ShellIcon';
import { GlobalSearch } from './GlobalSearch';
import { IS_MOCK_MODE } from './api';

/** One Atlas identity and set of global actions for the main shell and standalone applications. */
export function AtlasTopBar({ page, context, menuOpen, onToggleMenu }: {
    page: string;
    context?: ReactNode;
    menuOpen?: boolean;
    onToggleMenu?: () => void;
}) {
    const [searchOpen, setSearchOpen] = useState(false);
    useEffect(() => {
        const shortcut = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                setSearchOpen(value => !value);
            }
        };
        window.addEventListener('keydown', shortcut);
        return () => window.removeEventListener('keydown', shortcut);
    }, []);

    return <>
        <header className="topbar">
            <a className="brand" href="#/">
                <b>atlas<span className="brand-period" aria-hidden="true">.</span></b>
            </a>
            {context && <div className="atlas-header-context">{context}</div>}
            <div className="header-actions">
                {IS_MOCK_MODE && <span className="badge muted" title="Illustrative local fixtures; server writes are disabled">Mock data</span>}
                <button className="header-icon-link" type="button" onClick={() => setSearchOpen(true)} aria-label="Search Atlas" title="Search Atlas (⌘K)"><ShellIcon name="search" /></button>
                <a className="header-icon-link" href="#/activity" aria-label="Activity" title="Activity" aria-current={page === 'activity' ? 'page' : undefined}><ShellIcon name="activity" /></a>
                <a className="header-icon-link" href="#/settings" aria-label="Settings" title="Settings" aria-current={['settings', 'developer', 'fabric', 'ask-atlas'].includes(page) ? 'page' : undefined}><ShellIcon name="settings" /></a>
                {onToggleMenu && <button className="nav-toggle ghost" aria-expanded={!!menuOpen} aria-controls="global-navigation" onClick={onToggleMenu}>{menuOpen ? 'Close menu' : 'Menu'}</button>}
            </div>
        </header>
        {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}
    </>;
}
