import type { ReactNode } from 'react';

export type ShellIconName = 'home' | 'projects' | 'applications' | 'views' | 'data' | 'infrastructure' | 'nodes' | 'monitoring' | 'activity' | 'settings' | 'search' | 'sparkles' | 'user';
export function ShellIcon({ name }: { name: ShellIconName }) {
    const drawings: Record<ShellIconName, ReactNode> = {
        home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M9 21v-8h6v8" /></>,
        projects: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></>,
        applications: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
        views: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></>,
        data: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3" /></>,
        infrastructure: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="8.5" y="14" width="7" height="7" rx="1.5" /><path d="M6.5 10v2h12v-2M12 12v2" /></>,
        nodes: <><rect x="9" y="2.5" width="6" height="6" rx="1.5" /><rect x="2.5" y="16" width="6" height="6" rx="1.5" /><rect x="15.5" y="16" width="6" height="6" rx="1.5" /><path d="M12 8.5v4M5.5 16v-3.5h13V16" /></>,
        monitoring: <><path d="M3 12h4l2.5-5 4 10 2.5-5H21" /></>,
        activity: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
        settings: <><path d="M9.8 2.8h4.4l.6 2.2a7.6 7.6 0 0 1 1.8 1l2.2-.6L21 9.2l-1.6 1.6a8 8 0 0 1 0 2.4l1.6 1.6-2.2 3.8-2.2-.6a7.6 7.6 0 0 1-1.8 1l-.6 2.2H9.8L9.2 19a7.6 7.6 0 0 1-1.8-1l-2.2.6L3 14.8l1.6-1.6a8 8 0 0 1 0-2.4L3 9.2l2.2-3.8 2.2.6a7.6 7.6 0 0 1 1.8-1z" /><circle cx="12" cy="12" r="3" /></>,
        search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
        sparkles: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z" /></>,
        user: <><circle cx="12" cy="8" r="3.5" /><path d="M5.5 20c.3-4 2.7-6 6.5-6s6.2 2 6.5 6" /></>,
    };
    return <svg className="shell-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{drawings[name]}</svg>;
}

