import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubReviewHistoryReader } from '../apps/server/src/apps/github-review-history.js';

const repo = 'affank1020/atlas';
const sha = 'a'.repeat(40);

test('bulk dashboard PR reads acquire one scoped installation token and cache verified states', async () => {
    let credentials = 0;
    let active = 0;
    let peak = 0;
    const fetched: number[] = [];
    const reader = new GitHubReviewHistoryReader({
        pullRequestReadToken: async (requested: string) => {
            assert.equal(requested, repo);
            credentials++;
            return 'test-dashboard-token';
        },
    } as any, (async (url: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(init?.method, 'GET');
        assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Bearer test-dashboard-token');
        const prNumber = Number(String(url).split('/').at(-1));
        fetched.push(prNumber);
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return new Response(JSON.stringify({ number: prNumber, state: prNumber % 2 ? 'open' : 'closed',
            head: { sha }, base: { repo: { full_name: 'Affank1020/Atlas' } } }), { status: 200 });
    }) as typeof fetch);
    const numbers = Array.from({ length: 18 }, (_, i) => i + 1);
    const first = await reader.dashboardHeads(repo, numbers);
    assert.equal(credentials, 1, 'one token for all eighteen PRs');
    assert.equal(fetched.length, 18);
    assert.ok(peak <= 5 && peak > 1, 'reads use bounded parallelism');
    assert.equal(first[1]?.open, true);
    assert.equal(first[2]?.open, false);
    const again = await reader.dashboardHeads(repo, numbers);
    assert.deepEqual(again, first);
    assert.equal(credentials, 1, 'short-lived status cache prevents redundant auth work');
    assert.equal(fetched.length, 18);
});

test('bulk dashboard checks refuse identity mismatches and honour cancellation after auth', async () => {
    const controller = new AbortController();
    let fetched = 0;
    const reader = new GitHubReviewHistoryReader({
        pullRequestReadToken: async () => 'test-dashboard-token',
    } as any, (async () => {
        fetched++;
        return new Response(JSON.stringify({ number: 999, state: 'closed',
            head: { sha }, base: { repo: { full_name: repo } } }), { status: 200 });
    }) as typeof fetch);
    const result = await reader.dashboardHeads(repo, [1]);
    assert.deepEqual(result, {}, 'foreign PR status cannot be used as verified evidence');
    controller.abort();
    assert.deepEqual(await reader.dashboardHeads(repo, [2, 3], controller.signal), {});
    assert.equal(fetched, 1, 'aborted dashboard does not start extra GitHub requests');
});
