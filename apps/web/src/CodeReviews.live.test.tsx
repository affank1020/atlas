import { Provider } from 'react-redux';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { callTool } from './api';
import { CodeReviews } from './CodeReviews';
import { createAtlasStore } from './store';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('remount refreshes cached Code Reviews history after a Store write in the same browser session', async () => {
    let total = 0;
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const tool = url.split('/').pop()!;
        requests.push(tool);
        if (tool === 'create_record') {
            total += 1;
            return { ok: true, status: 200, json: async () => ({ id: 'saved' }) };
        }
        if (tool === 'code_reviews_overview')
            return { ok: true, status: 200, json: async () => ({ projectId: 'project', reviewRuns: total, findingObservations: 0 }) };
        if (tool === 'code_reviews_list_runs')
            return { ok: true, status: 200, json: async () => ({
                total, limit: 30, offset: 0, items: total ? [{
                    id: 'run-one',
                    data: { repository: 'affank1020/atlas', prNumber: 69,
                        headSha: 'a'.repeat(40), reviewedAt: '2026-10-22T12:00:00.000Z',
                        reviewer: 'Code Reviewer', verdict: 'no_findings' },
                }] : [],
            }) };
        throw Error('Unexpected tool: ' + tool);
    }));

    const { store, unsubscribeMutations } = createAtlasStore();
    try {
        const wrap = (element: ReactNode) => <Provider store={store}>{element}</Provider>;
        const first = render(wrap(<CodeReviews />));
        expect(await screen.findByText('0 total runs')).toBeInTheDocument();
        expect(screen.getByText('No reviews recorded yet')).toBeInTheDocument();
        first.unmount();

        await callTool('create_record', { projectId: 'project', storeId: 'review-runs', data: {} });
        const revisited = render(wrap(<CodeReviews />));
        expect(await screen.findByText('1 total runs')).toBeInTheDocument();
        expect(await screen.findByRole('link', { name: /affank1020.*atlas #69/ }))
            .toHaveAttribute('href', 'https://github.com/affank1020/atlas/pull/69');
        expect(requests.filter(name => name === 'code_reviews_overview')).toHaveLength(2);
        expect(requests.filter(name => name === 'code_reviews_list_runs')).toHaveLength(2);
        revisited.unmount();
    } finally {
        unsubscribeMutations();
    }
});

test('Refresh reloads the expanded findings query after changes in another client', async () => {
    const runId = 'a4d0a616-361e-4bb2-b9ba-3a870085d107';
    let extraFinding = false;
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const tool = url.split('/').pop()!;
        requests.push(tool);
        if (tool === 'code_reviews_overview') return {
            ok: true, status: 200, json: async () => ({
                projectId: 'project', reviewRuns: 1, findingObservations: extraFinding ? 2 : 1,
            }),
        };
        if (tool === 'code_reviews_list_runs') return {
            ok: true, status: 200, json: async () => ({
                total: 1, limit: 30, offset: 0, items: [{
                    id: runId, data: { repository: 'affank1020/atlas', prNumber: 103,
                        headSha: 'a'.repeat(40), reviewedAt: '2026-10-23T12:00:00.000Z',
                        reviewer: 'Code Reviewer', verdict: 'non_blocking' },
                }],
            }),
        };
        if (tool === 'code_reviews_list_findings') return {
            ok: true, status: 200, json: async () => ({
                total: extraFinding ? 2 : 1, limit: 50, offset: 0,
                items: [
                    { id: 'first', data: { severity: 'sev3', title: 'Original finding',
                        description: 'First review observation', state: 'new' } },
                    ...(extraFinding ? [{ id: 'second', data: { severity: 'sev4',
                        title: 'New finding from another client',
                        description: 'Second review observation', state: 'unverified' } }] : []),
                ],
            }),
        };
        throw Error('Unexpected tool: ' + tool);
    }));

    const { store, unsubscribeMutations } = createAtlasStore();
    try {
        const ui = render(<Provider store={store}><CodeReviews /></Provider>);
        fireEvent.click(await screen.findByRole('button', { name: 'View findings' }));
        expect(await screen.findByText(/Original finding/)).toBeInTheDocument();
        expect(requests.filter(name => name === 'code_reviews_list_findings')).toHaveLength(1);

        // This change occurs outside the current browser session, so RTK
        // has not received a local mutation invalidation signal.
        extraFinding = true;
        expect(screen.queryByText(/New finding from another client/)).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(await screen.findByText(/New finding from another client/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Hide findings' }))
            .toHaveAttribute('aria-expanded', 'true');
        expect(requests.filter(name => name === 'code_reviews_list_findings')).toHaveLength(2);
        expect(await screen.findByText('2')).toBeInTheDocument();
        ui.unmount();
    } finally {
        unsubscribeMutations();
    }
});
