import { afterEach, expect, test, vi } from 'vitest';
import { uploadFile } from './filesApi';

vi.mock('./api', () => ({ API_BASE: 'http://127.0.0.1:3000', IS_MOCK_MODE: false }));

afterEach(() => vi.unstubAllGlobals());

test('Web uploads raw File bytes with private owner metadata, without base64 encoding', async () => {
    const bytes = new Uint8Array([0, 1, 128, 255, 55]);
    const file = new File([bytes], 'mobile screenshot.png', { type: 'image/png' });
    const owner = { kind: 'workspace' as const, id: '00000000-0000-4000-8000-000000000002' };
    const response = { id: 'file-1', fileName: file.name, visibility: 'private' };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response), { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await uploadFile(owner, file)).toEqual(response);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3000/api/files/upload-binary');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    expect(init.headers).toMatchObject({
        'content-type': 'application/octet-stream',
        'x-atlas-owner-kind': 'workspace',
        'x-atlas-owner-id': owner.id,
        'x-atlas-file-name': 'mobile%20screenshot.png',
        'x-atlas-file-type': 'image/png',
    });
});

test('Web rejects empty and oversized files before sending a request', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const owner = { kind: 'project' as const, id: '00000000-0000-4000-8000-000000000001' };
    await expect(uploadFile(owner, new File([], 'empty.png'))).rejects.toThrow(/non-empty/);
    const big = new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'oversize.png');
    await expect(uploadFile(owner, big)).rejects.toThrow(/25 MiB/);
    expect(fetcher).not.toHaveBeenCalled();
});
