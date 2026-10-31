import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SkeletonApplicationWindow, SkeletonCards, SkeletonProjectApplications, SkeletonRows } from './Skeleton';

afterEach(cleanup);

test('skeleton rows announce a single busy region without interactive placeholders', () => {
    const { container } = render(<SkeletonRows count={4} label="Loading activity" variant="activity" />);
    const region = screen.getByRole('status', { name: 'Loading activity' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.atlas-skeleton-row')).toHaveLength(4);
    expect(Array.from(container.querySelectorAll('.atlas-skeleton-row')).every(row => row.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(container.querySelectorAll('button, a, input')).toHaveLength(0);
});

test('card skeletons match requested density and are decorative', () => {
    const { container } = render(<SkeletonCards count={3} label="Loading applications" />);
    expect(screen.getByRole('status', { name: 'Loading applications' })).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.atlas-skeleton-card')).toHaveLength(3);
});

test('application fallback has an accessible loading announcement', () => {
    render(<SkeletonApplicationWindow />);
    expect(screen.getByRole('status', { name: 'Loading application interface' })).toBeInTheDocument();
    expect(screen.getAllByRole('status')).toHaveLength(1);
});

test('project applications placeholder uses the same inset single-column grid and row anatomy as loaded cards', () => {
    const { container } = render(<SkeletonProjectApplications count={2} />);
    const region = screen.getByRole('status', { name: 'Loading project applications' });
    expect(region).toHaveClass('application-grid');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.application-card.application-card-skeleton')).toHaveLength(2);
    expect(container.querySelectorAll('.application-card-details')).toHaveLength(2);
    expect(container.querySelectorAll('.application-card-skeleton-launch')).toHaveLength(2);
    expect(container.querySelectorAll('button, a')).toHaveLength(0);
});
