import { useEffect, useState } from 'react';

export type RecentWork = { href: string; name: string; projectId: string; kind: 'Project' | 'View' | 'Application'; viewSlug?: string };
const key = 'atlas.recent-work.v1';
const event = 'atlas:recent-work';
export function readRecentWork(): RecentWork[] {
    try {
        const value: unknown = JSON.parse(sessionStorage.getItem(key) || '[]');
        return Array.isArray(value) ? value.filter((item): item is RecentWork => item && typeof item.name === 'string' && typeof item.projectId === 'string' && typeof item.href === 'string' && item.href.startsWith('#/projects/') && ['Project', 'View', 'Application'].includes(item.kind)).slice(0, 8) : [];
    } catch { return []; }
}
export function rememberWork(item: RecentWork) {
    try { sessionStorage.setItem(key, JSON.stringify([item, ...readRecentWork().filter(old => old.href !== item.href)].slice(0, 8))); window.dispatchEvent(new Event(event)); } catch { /* Browsing still works when storage is disabled. */ }
}
export function clearRecentWork() {
    try { sessionStorage.removeItem(key); window.dispatchEvent(new Event(event)); } catch { /* Optional browser preference. */ }
}
export function useRecentWork() {
    const [items, setItems] = useState(readRecentWork);
    useEffect(() => { const update = () => setItems(readRecentWork()); window.addEventListener(event, update); return () => window.removeEventListener(event, update); }, []);
    return items;
}
