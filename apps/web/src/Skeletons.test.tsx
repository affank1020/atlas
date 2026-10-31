import { render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { cleanup } from '@testing-library/react';
import { Skeleton, SkeletonRows } from './Skeletons';

afterEach(cleanup);

test('skeleton rows provide one accessible loading status and inert visual shapes', () => {
    const { container } = render(<SkeletonRows label="Loading project records" variant="table" rows={4} />);
    const status = screen.getByRole('status', { name: 'Loading project records' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.atlas-skeleton-row')).toHaveLength(4);
    expect(container.querySelectorAll('.atlas-skeleton[aria-hidden="true"]')).toHaveLength(12);
    expect(container.querySelectorAll('button, a, [tabindex]')).toHaveLength(0);
});

test('card placeholders render without leaking placeholder text to screen readers', () => {
    const { container } = render(<SkeletonRows label="Loading applications" variant="applications" rows={6} />);
    expect(screen.getByRole('status', { name: 'Loading applications' })).toBeInTheDocument();
    expect(container.querySelectorAll('.atlas-skeleton-card')).toHaveLength(6);
    expect(screen.queryByText(/Loading applications/)).not.toBeInTheDocument();
});

test('the compact primitive uses supplied measurements and remains decorative', () => {
    const { container } = render(<Skeleton width={60} height={14} />);
    expect(container.querySelector('span')).toHaveStyle({ width: '60px', height: '14px' });
    expect(container.querySelector('span')).toHaveAttribute('aria-hidden', 'true');
});
