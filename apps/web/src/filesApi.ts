import { API_BASE, IS_MOCK_MODE } from './api';

export type FileOwner = { kind: 'project' | 'workspace' | 'application'; id: string };
export type AtlasFile = {
    id: string; owner: FileOwner; fileName: string; mimeType: string;
    byteSize: number; checksum: string; visibility: 'private' | 'public';
    status: 'active' | 'archived'; createdAt: string; updatedAt: string;
};

const demoFiles = new Map<string, { file: AtlasFile; bytes: Blob }[]>();
const key = (owner: FileOwner) => `${owner.kind}/${owner.id}`;
const errorMessage = async (response: Response) => {
    const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
    return body.message || body.error || `Files request failed (HTTP ${response.status}).`;
};

async function postFiles<T>(action: string, data: object): Promise<T> {
    const response = await fetch(`${API_BASE}/api/files/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(action === 'upload' ? 120_000 : 30_000),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    return response.json() as Promise<T>;
}

export async function listFiles(owner: FileOwner): Promise<AtlasFile[]> {
    if (IS_MOCK_MODE) return (demoFiles.get(key(owner)) ?? []).map(item => item.file);
    return postFiles<AtlasFile[]>('list', { owner });
}

export async function uploadFile(owner: FileOwner, file: File): Promise<AtlasFile> {
    if (file.size === 0 || file.size > 25 * 1024 * 1024)
        throw new Error('Choose a non-empty file up to 25 MiB.');
    if (IS_MOCK_MODE) {
        const stamp = new Date().toISOString();
        const saved: AtlasFile = {
            id: crypto.randomUUID(), owner, fileName: file.name, mimeType: file.type || 'application/octet-stream',
            byteSize: file.size, checksum: 'demo', visibility: 'private', status: 'active',
            createdAt: stamp, updatedAt: stamp,
        };
        demoFiles.set(key(owner), [{ file: saved, bytes: file }, ...(demoFiles.get(key(owner)) ?? [])]);
        return saved;
    }
    // Transfer bytes directly instead of allocating a base64 string (33% overhead).
    // The server keeps a strict 25 MiB cap; resumable uploads are a later phase.
    const response = await fetch(`${API_BASE}/api/files/upload-binary`, {
        method: 'POST',
        headers: {
            'content-type': 'application/octet-stream',
            'x-atlas-owner-kind': owner.kind,
            'x-atlas-owner-id': owner.id,
            'x-atlas-file-name': encodeURIComponent(file.name),
            'x-atlas-file-type': file.type || 'application/octet-stream',
        },
        body: file,
        signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    return response.json() as Promise<AtlasFile>;
}

export async function downloadFile(owner: FileOwner, file: AtlasFile): Promise<void> {
    let blob: Blob;
    if (IS_MOCK_MODE) {
        const item = (demoFiles.get(key(owner)) ?? []).find(entry => entry.file.id === file.id);
        if (!item) throw new Error('File not found.');
        blob = item.bytes;
    } else {
        const response = await fetch(`${API_BASE}/api/files/download`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ owner, fileId: file.id }),
            signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(await errorMessage(response));
        blob = await response.blob();
    }
    const href = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = file.fileName;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
    } finally {
        // Defer revocation until the browser has handed the object URL to the download.
        setTimeout(() => URL.revokeObjectURL(href), 30_000);
    }
}

export async function archiveFile(owner: FileOwner, fileId: string): Promise<void> {
    if (IS_MOCK_MODE) {
        demoFiles.set(key(owner), (demoFiles.get(key(owner)) ?? []).filter(item => item.file.id !== fileId));
        return;
    }
    await postFiles('archive', { owner, fileId });
}
