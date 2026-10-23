import { afterEach, expect, test, vi } from 'vitest';
import { archiveProjectFolder, createProjectFolder, listFiles, listProjectFolders, moveProjectFile,
    renameProjectFolder, restoreProjectFolder, uploadFile } from './filesApi';

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

test('Web preserves long Unicode filenames in binary upload headers', async () => {
    const fileName = '漢'.repeat(251) + '.png';
    const file = new File(['screen'], fileName, { type: 'image/png' });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ fileName }), { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    const owner = { kind: 'project' as const, id: '00000000-0000-4000-8000-000000000001' };
    await uploadFile(owner, file);
    const headers = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers['x-atlas-file-name']).toBe(encodeURIComponent(fileName));
    expect(headers['x-atlas-file-name'].length).toBeGreaterThan(1024);
    expect(fileName.length).toBe(255);
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

test('Project folder requests send scoped JSON and binary uploads select their destination', async () => {
    const projectId = '00000000-0000-4000-8000-000000000001';
    const folderId = '00000000-0000-4000-8000-000000000002';
    const owner = { kind: 'project' as const, id: projectId };
    const calls: [string, RequestInit][] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    await listFiles(owner, 'active', null);
    await listFiles(owner, 'archived', folderId);
    await listProjectFolders(projectId);
    await createProjectFolder(projectId, null, 'Docs');
    await renameProjectFolder(projectId, folderId, 'Other');
    await archiveProjectFolder(projectId, folderId);
    await restoreProjectFolder(projectId, folderId);
    await moveProjectFile(projectId, '00000000-0000-4000-8000-000000000003', null);
    const file = new File(['data'], 'file.txt', { type: 'text/plain' });
    await uploadFile(owner, file, folderId);

    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ owner, status: 'active', folderId: null });
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ owner, status: 'archived', folderId });
    expect(calls.slice(2, 8).map(([url]) => url.split('/').pop())).toEqual([
        'folders-list', 'folders-create', 'folders-rename', 'folders-archive', 'folders-restore', 'file-move',
    ]);
    expect(JSON.parse(String(calls[7]![1].body))).toEqual({
        owner, fileId: '00000000-0000-4000-8000-000000000003', folderId: null,
    });
    expect(calls[8]![1].headers).toMatchObject({
        'x-atlas-owner-kind': 'project', 'x-atlas-owner-id': projectId, 'x-atlas-folder-id': folderId,
    });
    expect(calls[8]![1].body).toBe(file);
});

test('Non-Project folder destinations are rejected before binary upload', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(uploadFile({ kind: 'workspace', id: '00000000-0000-4000-8000-000000000002' },
        new File(['x'], 'x.txt'), '00000000-0000-4000-8000-000000000003')).rejects.toThrow(/Project ownership/);
    expect(fetcher).not.toHaveBeenCalled();
});
