import assert from 'node:assert/strict';
import test from 'node:test';
import { readReviewDashboard } from '../apps/server/src/apps/review-dashboard.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';

const runsId = '0140b619-4f75-454e-92a3-c8b595c9dee5';
function run(i: number, repository: string, prNumber: number, reviewedAt: string,
    severityCounts?: Record<string, number>) {
    return { id: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
        data: { repository, prNumber, headSha: 'a'.repeat(40),
            reviewedAt, verdict: 'non_blocking',
            ...(severityCounts && { counts: severityCounts }) } };
}
const stamp = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
function catalog(items: ReturnType<typeof run>[]) {
    const queries: any[] = [];
    return { queries, reader: { queryRecords: async (q: any) => {
        queries.push(q);
        assert.equal(q.storeId, runsId);
        assert.equal(q.projectId, CODE_REVIEWS_PROJECT_ID);
        assert.equal(q.limit, 100);
        return { total: items.length, items: items.slice(q.offset, q.offset + q.limit) };
    } } as any };
}

test('review dashboard includes complete multi-page saved history and splits verified open, closed and unknown PRs', async () => {
    const all = [
        ...Array.from({ length: 102 }, (_, i) =>
            run(i + 1, i % 2 ? 'Affank1020/Atlas' : 'affank1020/atlas',
                17, stamp(102 - i), { sev3: 1 })),
        run(300, 'affank1020/atlas', 22, stamp(0), { sev4: 2 }),
        run(301, 'other/atlas', 17, stamp(-1)),
    ];
    const { reader, queries } = catalog(all);
    const checked: string[] = [];
    const result = await readReviewDashboard(reader, runsId, async (repo, pr) => {
        checked.push(repo + '#' + pr);
        if (repo === 'other/atlas') throw new Error('GitHub unavailable');
        return { open: pr === 17, headSha: 'a'.repeat(40) };
    });
    assert.equal(result.totalRuns, 104);
    assert.equal(queries.length, 2, 'all 104 stored rounds are read, not merely the first 100');
    assert.equal(result.groups.length, 3);
    const open = result.groups.find(group => group.repository === 'affank1020/atlas' && group.prNumber === 17)!;
    assert.equal(open.rounds, 102);
    assert.equal(open.findings, 102);
    assert.equal(open.status, 'open');
    assert.equal(open.reviewFreshness, 'current');
    assert.equal(open.latest.reviewedAt, stamp(102));
    const closed = result.groups.find(group => group.prNumber === 22)!;
    assert.equal(closed.status, 'closed');
    assert.equal(closed.rounds, 1);
    assert.equal(closed.findings, 2);
    const unknown = result.groups.find(group => group.repository === 'other/atlas')!;
    assert.equal(unknown.status, 'unavailable', 'failed GitHub reads are never closed');
    assert.equal(unknown.reviewFreshness, 'unknown');
    assert.deepEqual(checked.sort(), ['affank1020/atlas#17', 'affank1020/atlas#22', 'other/atlas#17']);
});

test('dashboard refuses incomplete or oversized saved history instead of mislabelling latest review', async () => {
    await assert.rejects(readReviewDashboard({
        queryRecords: async () => ({ total: 2, items: [run(1, 'a/b', 1, stamp(1))] }),
    } as any, runsId), /incomplete/i);
    await assert.rejects(readReviewDashboard({
        queryRecords: async () => ({ total: 2001, items: [] }),
    } as any, runsId), /bounded history/i);
});

test('dashboard bounds concurrent GitHub reads and keeps unknown counts unknown', async () => {
    const all = Array.from({ length: 8 }, (_, i) =>
        run(i + 1, 'example/repo', i + 1, stamp(i)));
    const { reader } = catalog(all);
    let active = 0;
    let peak = 0;
    const result = await readReviewDashboard(reader, runsId, async (_repo, n) => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return { open: n % 2 === 0, headSha: 'b'.repeat(40) };
    });
    assert.ok(peak <= 5);
    assert.ok(peak >= 2);
    assert.equal(result.groups.length, 8);
    assert.ok(result.groups.every(group => !group.countsComplete && group.reviewFreshness === 'outdated'));
    assert.ok(result.groups.every(group => group.findings === 0));
});
