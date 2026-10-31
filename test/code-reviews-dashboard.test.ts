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

test('complete multi-page review history aggregates mixed-case PRs and statuses per repository', async () => {
    const all = [
        ...Array.from({ length: 102 }, (_, i) =>
            run(i + 1, i % 2 ? 'Affank1020/Atlas' : 'affank1020/atlas',
                17, stamp(102 - i), { sev3: 1 })),
        run(300, 'affank1020/atlas', 22, stamp(0), { sev4: 2 }),
        run(301, 'other/atlas', 17, stamp(-1)),
    ];
    const { reader, queries } = catalog(all);
    const checked: string[] = [];
    const result = await readReviewDashboard(reader, runsId, async (repo, numbers) => {
        checked.push(repo + ':' + numbers.join(','));
        if (repo === 'other/atlas') throw new Error('GitHub unavailable');
        return Object.fromEntries(numbers.map(n => [n, { open: n === 17, headSha: 'a'.repeat(40) }]));
    });
    assert.equal(result.totalRuns, 104);
    assert.equal(result.scannedRuns, 104);
    assert.equal(result.windowComplete, true);
    assert.equal(result.truncatedPrs, false);
    assert.equal(queries.length, 2);
    assert.equal(result.groups.length, 3);
    const open = result.groups.find(g => g.repository === 'affank1020/atlas' && g.prNumber === 17)!;
    assert.equal(open.rounds, 102);
    assert.equal(open.findings, 102);
    assert.equal(open.roundsComplete, true);
    assert.equal(open.status, 'open');
    assert.equal(open.reviewFreshness, 'current');
    const closed = result.groups.find(g => g.prNumber === 22)!;
    assert.equal(closed.status, 'closed');
    assert.equal(closed.findings, 2);
    assert.equal(result.groups.find(g => g.repository === 'other/atlas')!.status, 'unavailable');
    assert.deepEqual(checked.sort(), ['affank1020/atlas:17,22', 'other/atlas:17']);
});

test('inconsistent history remains an error instead of inventing complete counts', async () => {
    await assert.rejects(readReviewDashboard({
        queryRecords: async () => ({ total: 2, items: [run(1, 'a/b', 1, stamp(1))] }),
    } as any, runsId), /incomplete/i);
});

test('the 101st, oldest distinct PR is still discoverable and verified open', async () => {
    const all = Array.from({ length: 101 }, (_, i) =>
        run(i + 1, 'example/atlas', i + 1, stamp(101 - i), { sev3: 1 }));
    const result = await readReviewDashboard(catalog(all).reader, runsId, async (_repo, numbers) =>
        Object.fromEntries(numbers.map(n => [n, { open: n === 101, headSha: 'a'.repeat(40) }])));
    assert.equal(result.totalRuns, 101);
    assert.equal(result.scannedRuns, 101);
    assert.equal(result.groups.length, 101);
    assert.equal(result.windowComplete, true);
    assert.equal(result.truncatedPrs, false);
    assert.equal(result.hasMore, false);
    assert.equal(result.groups.find(g => g.prNumber === 101)?.status, 'open');
    assert.ok(result.groups.every(g => g.roundsComplete && g.countsComplete));
});

test('2001 stored runs show most recent 500, never masquerading as complete PR history', async () => {
    const all = Array.from({ length: 2001 }, (_, i) =>
        run(i + 1, 'example/atlas', 17, stamp(2001 - i), { sev3: 1 }));
    const { reader, queries } = catalog(all);
    const result = await readReviewDashboard(reader, runsId);
    assert.equal(queries.length, 5);
    assert.equal(result.totalRuns, 2001);
    assert.equal(result.scannedRuns, 500);
    assert.equal(result.windowComplete, false);
    assert.equal(result.runOffset, 0);
    assert.equal(result.hasMore, true);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0]!.rounds, 500);
    assert.equal(result.groups[0]!.findings, 500);
    assert.equal(result.groups[0]!.roundsComplete, false);
    assert.equal(result.groups[0]!.countsComplete, false);
    const older = await readReviewDashboard(reader, runsId, undefined, undefined, 500);
    assert.equal(older.scannedRuns, 500);
    assert.equal(older.runOffset, 500);
    assert.equal(older.hasMore, true);
    assert.equal(older.groups[0]!.roundsComplete, false);
});

test('an older still-open PR beyond 500 reviews is reachable on the next page', async () => {
    const all = Array.from({ length: 501 }, (_, i) =>
        run(i + 1, 'example/atlas', i + 1, stamp(501 - i), { sev3: 1 }));
    const { reader, queries } = catalog(all);
    const recent = await readReviewDashboard(reader, runsId);
    assert.equal(recent.groups.length, 500);
    assert.equal(recent.groups.some(g => g.prNumber === 501), false);
    assert.equal(recent.hasMore, true);
    const older = await readReviewDashboard(reader, runsId, async (_repo, numbers) =>
        Object.fromEntries(numbers.map(n => [n, { open: n === 501, headSha: 'a'.repeat(40) }])),
        undefined, 500);
    assert.equal(older.runOffset, 500);
    assert.equal(older.scannedRuns, 1);
    assert.equal(older.hasMore, false);
    assert.equal(older.windowComplete, false);
    assert.equal(older.groups.length, 1);
    assert.equal(older.groups[0]!.prNumber, 501);
    assert.equal(older.groups[0]!.status, 'open');
    assert.equal(older.groups[0]!.roundsComplete, false);
    assert.equal(older.groups[0]!.reviewFreshness, 'current');
    assert.equal(queries.at(-1)?.offset, 500);
});

test('page offsets are validated and cannot be used for unbounded scans', async () => {
    const { reader } = catalog([]);
    for (const offset of [-1, 1, 499, 1_000_000_500]) {
        await assert.rejects(readReviewDashboard(reader, runsId, undefined, undefined, offset),
            /Invalid review dashboard page offset/);
    }
});

test('status checks have an overall deadline; a hung repository never blocks saved aggregates', async () => {
    const rows = [run(1, 'example/repo', 1, stamp(1))];
    let signal: AbortSignal | undefined;
    const start = Date.now();
    const result = await readReviewDashboard(catalog(rows).reader, runsId,
        async (_repo, _numbers, abort) => {
            signal = abort;
            return new Promise<never>(() => { /* Simulate a hung status provider. */ });
        }, 15);
    assert.ok(Date.now() - start < 1_000, 'bounded deadline prevents hung status checks delaying UI');
    assert.equal(signal?.aborted, true);
    assert.equal(result.groups[0]!.status, 'unavailable');
    assert.equal(result.totalRuns, 1);
});

test('repository-level status reads are bounded and preserve unknown counts', async () => {
    const all = Array.from({ length: 8 }, (_, i) => run(i + 1, 'example/repo', i + 1, stamp(i)));
    const { reader } = catalog(all);
    const calls: string[] = [];
    const result = await readReviewDashboard(reader, runsId, async (repo, numbers) => {
        calls.push(repo);
        return Object.fromEntries(numbers.map(n => [n, { open: n % 2 === 0, headSha: 'b'.repeat(40) }]));
    });
    assert.deepEqual(calls, ['example/repo'], 'one batch per repository, never per PR');
    assert.equal(result.groups.length, 8);
    assert.ok(result.groups.every(g => !g.countsComplete && g.reviewFreshness === 'outdated'));
});
