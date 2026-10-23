import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { StoreActivityLink } from './StoreActivityLink';
import { parseMonitoringHash } from './monitoringLinks';

afterEach(cleanup);

test('Store links preserve both Project and Store scope, including encoded identifiers', () => {
    const projectId = 'project / older';
    const storeId = 'store & archived';
    render(<StoreActivityLink projectId={projectId} storeId={storeId} />);
    const link = screen.getByRole('link', { name: 'Store activity in Monitoring →' });
    expect(link).toHaveClass('ghost', 'store-activity-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '#/monitoring?tab=activity&projectId=project+%2F+older&storeId=store+%26+archived');
    expect(parseMonitoringHash(link.getAttribute('href')!)).toEqual({
        tab: 'activity', filters: { projectId, storeId },
    });
});

test('revision audit shortcut retains scoped monitoring navigation without changing audit state', () => {
    render(<StoreActivityLink projectId="project-a" storeId="store-b" label="Search this Store in Monitoring" />);
    const link = screen.getByRole('link', { name: 'Search this Store in Monitoring →' });
    expect(link).toHaveClass('ghost', 'store-activity-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '#/monitoring?tab=activity&projectId=project-a&storeId=store-b');
    expect(link).not.toHaveAttribute('target');
});
