import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { PortfolioApplicationLoading, PortfolioWorkspaceLoading, PortfolioMediaLoading } from './PortfolioLoading';
import { CodeReviewsApplicationLoading, CodeReviewsListLoading, CodeReviewsOpenCardsLoading, CodeReviewsDetailLoading } from './CodeReviewsDashboardLoading';
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

test('Code Reviews lazy fallback matches the shared open-PR card skeleton', () => {
    const { container } = render(<CodeReviewsApplicationLoading />);
    expect(screen.getByRole('status', { name: 'Loading Code Reviews' }))
        .toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(container.querySelectorAll('.cr-metrics article')).toHaveLength(4);
    expect(container.querySelectorAll('.cr-overview-tools .atlas-load-skeleton')).toHaveLength(2);
    expect(container.querySelector('.cr-section-title')).toHaveTextContent('Open PRs');
    expect(container.querySelectorAll('.cr-open-grid .cr-open-card')).toHaveLength(3);
    expect(container.querySelectorAll('.cr-open-card .cr-card-stats > div')).toHaveLength(9);
    expect(container.querySelectorAll('.cr-open-card .cr-card-top')).toHaveLength(3);
    expect(container.querySelectorAll('.cr-open-card .cr-severity-summary')).toHaveLength(3);
    expect(container.querySelectorAll('.cr-open-card .cr-card-bottom')).toHaveLength(3);
    expect(container.querySelector('.cr-table-head, .cr-pr, .cr-list-head')).toBeNull();
    expect(container.querySelectorAll('button, a, input, textarea, select')).toHaveLength(0);
});

test('shared open-PR skeleton has the same card anatomy when mounted for data loading', () => {
    const { container } = render(<CodeReviewsOpenCardsLoading />);
    expect(screen.getByRole('status', { name: 'Loading Code Reviews pull requests' }))
        .toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.cr-open-grid .cr-open-card')).toHaveLength(3);
    expect(container.querySelectorAll('.cr-open-card .cr-card-stats > div')).toHaveLength(9);
    expect(container.querySelector('.cr-pr, .cr-table-head')).toBeNull();
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

test('Portfolio Media skeleton matches the full-width asset manager, not the entry editor', () => {
    const { container } = render(<PortfolioMediaLoading />);
    expect(screen.getByRole('status', { name: 'Loading Portfolio media library' })).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('.portfolio-media-header')).toBeInTheDocument();
    expect(container.querySelector('.portfolio-media-toolbar .portfolio-media-search')).toBeInTheDocument();
    expect(container.querySelectorAll('.portfolio-media-grid article')).toHaveLength(6);
    expect(container.querySelectorAll('.portfolio-media-grid .portfolio-media-preview')).toHaveLength(6);
    expect(container.querySelector('.portfolio-workspace, .portfolio-sidebar, .portfolio-editor')).toBeNull();
    expect(container.querySelectorAll('button, input, a, select, textarea')).toHaveLength(0);
});

test('Portfolio lazy fallback selects media layout and active tab from a media deep link', () => {
    const previousHash = window.location.hash;
    window.location.hash = '#/applications/portfolio?tab=media';
    try {
        const { container } = render(<PortfolioApplicationLoading />);
        expect(screen.getByRole('status', { name: 'Loading Portfolio' })).toBeInTheDocument();
        expect(container.querySelectorAll('.portfolio-media-grid article')).toHaveLength(6);
        expect(container.querySelector('.portfolio-workspace')).not.toBeInTheDocument();
        expect(container.querySelector('.portfolio-loading-tab.active')).toHaveTextContent('Media library');
        expect(screen.getAllByRole('status')).toHaveLength(1);
    } finally {
        window.location.hash = previousHash;
    }
});
