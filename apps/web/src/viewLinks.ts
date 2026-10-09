import { API_BASE } from './api';
import type { View } from './types';

/** Stable IDs keep legacy Views launchable even when no standalone slug was set. */
export function standaloneViewUrl(view: Pick<View, 'projectId' | 'id' | 'slug'>): string {
    return `${API_BASE}/projects/${view.projectId}/views/${view.slug || view.id}`;
}

export function editViewHash(view: Pick<View, 'projectId' | 'id'>): string {
    return `#/projects/${view.projectId}/views/${view.id}`;
}
