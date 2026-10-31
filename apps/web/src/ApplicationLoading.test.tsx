import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { PortfolioApplicationLoading, PortfolioWorkspaceLoading } from './PortfolioLoading';
import { CodeReviewsApplicationLoading, CodeReviewsListLoading, CodeReviewsDetailLoading } from './CodeReviewsDashboardLoading';
import { FootballGeneralistApplicationLoading, FootballGeneralistContentLoading } from './FootballGeneralistLoading';

afterEach(cleanup);

test('Portfolio placeholder preserves the split browser and editor geometry', () => {
    const { container } = render(<PortfolioApplicationLoading />);
    expect(screen.getByRole('status', { name: 'Loading Portfolio' })).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('.portfolio-workspace .portfolio-sidebar')).toBeInTheDocument();
    expect(container.querySelector('.portfolio-workspace .portfolio-editor')).toBeInTheDocument();
    expect(container.querySelectorAll('.portfolio-types .portfolio-loading-type')).toHaveLength(6);
    expect(container.querySelectorAll('.portfolio-entry-list .portfolio-entry')).toHaveLength(5);
    expect(container.querySelectorAll('.portfolio-form .portfolio-loading-field')).toHaveLength(4);
    expect(container.querySelectorAll('button, a, input, textarea, select')).toHaveLength(0);
    expect(screen.getAllByRole('status')).toHaveLength(1);
});

test('mounted Portfolio data placeholder retains split workspace only', () => {
    const { container } = render(<PortfolioWorkspaceLoading />);
    expect(screen.getByRole('status', { name: 'Loading Portfolio workspace' })).toBeInTheDocument();
    expect(container.querySelector('.portfolio-head')).not.toBeInTheDocument();
    expect(container.querySelector('.portfolio-editor-content')).toBeInTheDocument();
});

test('Code Reviews placeholder matches four KPI tiles and the PR table row anatomy', () => {
    const { container } = render(<CodeReviewsApplicationLoading />);
    expect(screen.getByRole('status', { name: 'Loading Code Reviews' })).toBeInTheDocument();
    expect(container.querySelectorAll('.cr-metrics article')).toHaveLength(4);
    expect(container.querySelectorAll('.cr-table-head')).toHaveLength(1);
    expect(container.querySelectorAll('.cr-pr .cr-pr-main')).toHaveLength(5);
    expect(container.querySelectorAll('.cr-pr .cr-number')).toHaveLength(10);
    expect(container.querySelectorAll('button, a, input, textarea, select')).toHaveLength(0);
    const rows = Array.from(container.querySelectorAll('.cr-pr-main'));
    for (const row of rows) {
        // These exact six children are placed/hidden by Code Reviews' real
        // @media <=1050px and <=720px grid rules, not generic grid defaults.
        expect(Array.from(row.children).map(cell => cell.classList[0])).toEqual([
            'cr-pr-identity', 'cr-number', 'cr-number', 'cr-verdict', 'cr-date', 'cr-expand',
        ]);
        expect(row.querySelector('.cr-expand')).toHaveClass('cr-loading-expand');
        expect(row.querySelector('.cr-expand')).not.toHaveAttribute('tabindex');
    }
    expect(container.querySelectorAll('.cr-pr-main > .cr-date')).toHaveLength(5);
    expect(container.querySelectorAll('.cr-pr-main > .cr-verdict')).toHaveLength(5);
});

test('mounted Code Reviews list and its detail tabs use their own data skeletons', () => {
    const { container, rerender } = render(<CodeReviewsListLoading />);
    expect(screen.getByRole('status', { name: 'Loading Code Reviews pull requests' })).toBeInTheDocument();
    expect(container.querySelectorAll('.cr-pr')).toHaveLength(5);
    rerender(<CodeReviewsDetailLoading variant="findings" />);
    expect(screen.getByRole('status', { name: 'Loading review findings' })).toBeInTheDocument();
    expect(container.querySelectorAll('.cr-finding')).toHaveLength(3);
    rerender(<CodeReviewsDetailLoading variant="rounds" />);
    expect(container.querySelectorAll('.cr-round')).toHaveLength(3);
    rerender(<CodeReviewsDetailLoading variant="github" />);
    expect(container.querySelectorAll('.cr-status-grid > div')).toHaveLength(3);
});

test('Football generalist placeholder uses activity, five stats and curriculum / history panels', () => {
    const { container } = render(<FootballGeneralistApplicationLoading />);
    expect(screen.getByRole('status', { name: 'Loading Football Generalist application' })).toBeInTheDocument();
    expect(container.querySelector('.fg-active-panel')).toBeInTheDocument();
    expect(container.querySelectorAll('.fg-stats > div')).toHaveLength(5);
    expect(container.querySelectorAll('.fg-curriculum-row')).toHaveLength(3);
    expect(container.querySelectorAll('.fg-panel')).toHaveLength(4);
    expect(container.querySelectorAll('.fg-nav .fg-loading-tab')).toHaveLength(9);
    expect(container.querySelectorAll('button, a, input, textarea, select')).toHaveLength(0);
    expect(screen.getAllByRole('status')).toHaveLength(1);
});

test('mounted Football initial data skeleton has no duplicate application heading', () => {
    const { container } = render(<FootballGeneralistContentLoading />);
    expect(screen.getByRole('status', { name: 'Loading Football Generalist' })).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('.fg-heading')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.fg-stats > div')).toHaveLength(5);
});