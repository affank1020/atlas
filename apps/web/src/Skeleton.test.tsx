import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SkeletonApplicationWindow, SkeletonCards, SkeletonRows } from './Skeleton';

afterEach(cleanup);

test('skeleton rows announce a single busy region without interactive placeholders', () => {
    const { container } = render(<SkeletonRows count={4} label="Loading activity" variant="activity" />);
    const region = screen.getByRole('status', { name: 'Loading activity' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.atlas-skeleton-row')).toHaveLength(4);
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);
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
});
