import { render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { cleanup } from '@testing-library/react';
import { Skeleton, SkeletonRows } from './Skeletons';
import { SkeletonRows as ShellSkeletonRows } from './Skeleton';

afterEach(cleanup);

test('skeleton rows provide one accessible loading status and inert visual shapes', () => {
    const { container } = render(<SkeletonRows label="Loading project records" variant="table" rows={4} />);
    const status = screen.getByRole('status', { name: 'Loading project records' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.atlas-load-skeleton-row')).toHaveLength(4);
    expect(container.querySelectorAll('.atlas-load-skeleton[aria-hidden="true"]')).toHaveLength(12);
    expect(container.querySelectorAll('button, a, [tabindex]')).toHaveLength(0);
});

test('card placeholders render without leaking placeholder text to screen readers', () => {
    const { container } = render(<SkeletonRows label="Loading applications" variant="applications" rows={6} />);
    expect(screen.getByRole('status', { name: 'Loading applications' })).toBeInTheDocument();
    expect(container.querySelectorAll('.atlas-load-skeleton-card')).toHaveLength(6);
    expect(screen.queryByText(/Loading applications/)).not.toBeInTheDocument();
});

test('the compact primitive uses supplied measurements and remains decorative', () => {
    const { container } = render(<Skeleton width={60} height={14} />);
    expect(container.querySelector('span')).toHaveStyle({ width: '60px', height: '14px' });
    expect(container.querySelector('span')).toHaveAttribute('aria-hidden', 'true');
});

test('page skeleton variants coexist with merged shell skeletons without sharing class selectors', () => {
    const { container } = render(<>
        <ShellSkeletonRows label="Loading navigation" count={2} />
        <SkeletonRows label="Loading records" variant="table" rows={2} />
    </>);
    expect(container.querySelectorAll('.atlas-skeleton-row')).toHaveLength(2);
    expect(container.querySelectorAll('.atlas-load-skeleton-row')).toHaveLength(2);
    expect(screen.getAllByRole('status')).toHaveLength(2);
});
