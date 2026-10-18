import { afterEach, expect, test, vi } from 'vitest';
import { callTool, onToolMutation } from './api';

afterEach(() => vi.unstubAllGlobals());
const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response;

test('callTool remains an uncached transport for live reads', async () => {
    const fetcher = vi.fn(async () => response([]));
    vi.stubGlobal('fetch', fetcher);
    await callTool('get_recent_activity', { limit: 10 });
    await callTool('get_recent_activity', { limit: 10 });
    expect(fetcher).toHaveBeenCalledTimes(2);
});

test('successful direct mutations notify the RTK invalidation bridge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ id: 'p' })));
    const listener = vi.fn();
    const unsubscribe = onToolMutation(listener);
    try {
        await callTool('create_project', { name: 'New' });
        expect(listener).toHaveBeenCalledWith({ name: 'create_project', input: { name: 'New' } });
    } finally { unsubscribe(); }
});
