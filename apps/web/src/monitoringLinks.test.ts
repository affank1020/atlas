import { describe, expect, it } from 'vitest';
import { monitoringHash, parseMonitoringHash } from './monitoringLinks';

describe('Monitoring deep links', () => {
    it('round-trips project, node, checkout, store and search scope', () => {
        const filters = { projectId: 'p', workspaceId: 'w', checkoutId: 'c', nodeId: 'n', storeId: 's', search: 'failed git' };
        expect(parseMonitoringHash(monitoringHash('activity', filters))).toEqual({ tab: 'activity', filters });
    });
    it('opens old Activity bookmarks within Monitoring', () => {
        expect(parseMonitoringHash('#/activity').tab).toBe('activity');
        expect(parseMonitoringHash('#/activity?projectId=old').filters.projectId).toBe('old');
    });
    it('preserves Logs selection across refreshes', () => {
        expect(parseMonitoringHash('#/monitoring?tab=logs&nodeId=node-1')).toEqual({ tab: 'logs', filters: { nodeId: 'node-1' } });
    });
    it('defaults unknown tabs to Overview', () => {
        expect(parseMonitoringHash('#/monitoring?tab=other')).toEqual({ tab: 'overview', filters: {} });
    });
});
