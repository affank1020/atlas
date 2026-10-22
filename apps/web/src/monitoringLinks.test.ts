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
    it('round-trips a bounded log selection and rejects invalid source/lines', () => {
        expect(parseMonitoringHash(monitoringHash('logs', { nodeId: 'node-1', source: 'stdout', lines: '37' })))
            .toEqual({ tab: 'logs', filters: { nodeId: 'node-1', source: 'stdout', lines: '37' } });
        expect(parseMonitoringHash('#/monitoring?tab=logs&source=secrets&lines=999&nodeId=n'))
            .toEqual({ tab: 'logs', filters: { nodeId: 'n' } });
    });
    it('preserves the approved fixed journal source in a bookmark', () => {
        expect(parseMonitoringHash('#/monitoring?tab=logs&nodeId=linux-node&source=journal&lines=25'))
            .toEqual({ tab: 'logs', filters: { nodeId: 'linux-node', source: 'journal', lines: '25' } });
    });
    it('round-trips Atlas Server diagnostics without permitting an arbitrary log target', () => {
        expect(parseMonitoringHash(monitoringHash('logs', { target: 'server', lines: '12' })))
            .toEqual({ tab: 'logs', filters: { target: 'server', lines: '12' } });
        expect(parseMonitoringHash('#/monitoring?tab=logs&target=container-root'))
            .toEqual({ tab: 'logs', filters: {} });
    });
    it('only enables Activity live mode for explicit live=1 and keeps URL state shareable', () => {
        expect(parseMonitoringHash(monitoringHash('activity', { projectId: 'scope', live: '1' })))
            .toEqual({ tab: 'activity', filters: { projectId: 'scope', live: '1' } });
        expect(parseMonitoringHash('#/monitoring?tab=activity&live=true').filters).toEqual({});
        expect(parseMonitoringHash('#/monitoring?tab=logs&live=1&nodeId=n'))
            .toEqual({ tab: 'logs', filters: { nodeId: 'n' } });
        expect(parseMonitoringHash('#/monitoring?tab=overview&live=1').filters).toEqual({});
    });
    it('does not enable live mode on historical pages', () => {
        expect(parseMonitoringHash('#/monitoring?tab=activity&offset=30&live=1').filters)
            .toEqual({ offset: '30' });
        expect(parseMonitoringHash('#/monitoring?tab=activity&offset=0&live=1').filters)
            .toEqual({ offset: '0', live: '1' });
    });
    it('defaults unknown tabs to Overview', () => {
        expect(parseMonitoringHash('#/monitoring?tab=other')).toEqual({ tab: 'overview', filters: {} });
    });
});
