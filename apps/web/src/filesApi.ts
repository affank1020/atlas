import { API_BASE, IS_MOCK_MODE } from './api';

export type FileOwner = { kind: 'project' | 'workspace' | 'application'; id: string };
export type AtlasFile = {
    id: string; owner: FileOwner; fileName: string; mimeType: string;
    byteSize: number; checksum: string; visibility: 'private' | 'public';
    status: 'active' | 'archived'; folderId: string | null; createdAt: string; updatedAt: string;
};
export type ProjectFolder = {
    id: string; projectId: string; parentId: string | null; name: string;
    status: 'active' | 'archived'; createdAt: string; updatedAt: string;
};

const demoFiles = new Map<string, { file: AtlasFile; bytes: Blob }[]>();
const demoFolders = new Map<string, ProjectFolder[]>();
const foldersFor = (projectId: string): ProjectFolder[] => demoFolders.get(projectId) ?? [];
const demoFolder = (projectId: string, folderId: string): ProjectFolder => {
    const folder = foldersFor(projectId).find(item => item.id === folderId);
    if (!folder) throw new Error('Project folder was not found.');
    return folder;
};
const validateDemoDestination = (projectId: string, folderId: string | null): void => {
    if (folderId !== null && demoFolder(projectId, folderId).status !== 'active')
        throw new Error('Project folder is archived.');
};
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

export async function listFiles(owner: FileOwner, status: AtlasFile['status'] = 'active', folderId?: string | null): Promise<AtlasFile[]> {
    if (IS_MOCK_MODE) return (demoFiles.get(key(owner)) ?? [])
        .filter(item => item.file.status === status && (folderId === undefined || item.file.folderId === folderId))
        .map(item => item.file);
    return postFiles<AtlasFile[]>('list', { owner, status, ...(folderId === undefined ? {} : { folderId }) });
}

export async function uploadFile(owner: FileOwner, file: File, folderId?: string | null): Promise<AtlasFile> {
    if (folderId !== undefined && owner.kind !== 'project') throw new Error('Folders require Project ownership.');
    if (file.size === 0 || file.size > 25 * 1024 * 1024)
        throw new Error('Choose a non-empty file up to 25 MiB.');
    if (IS_MOCK_MODE) {
        if (folderId !== undefined) validateDemoDestination(owner.id, folderId);
        const stamp = new Date().toISOString();
        const saved: AtlasFile = {
            id: crypto.randomUUID(), owner, fileName: file.name, mimeType: file.type || 'application/octet-stream',
            byteSize: file.size, checksum: 'demo', visibility: 'private', status: 'active', folderId: folderId ?? null,
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
            ...(folderId ? { 'x-atlas-folder-id': folderId } : {}),
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
        if (!item || item.file.status !== 'active') throw new Error('File not found.');
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
        const item = (demoFiles.get(key(owner)) ?? []).find(item => item.file.id === fileId && item.file.status === 'active');
        if (!item) throw new Error('File not found.');
        item.file = { ...item.file, status: 'archived', updatedAt: new Date().toISOString() };
        return;
    }
    await postFiles('archive', { owner, fileId });
}

export async function restoreFile(owner: FileOwner, fileId: string): Promise<AtlasFile> {
    if (IS_MOCK_MODE) {
        const item = (demoFiles.get(key(owner)) ?? []).find(item => item.file.id === fileId && item.file.status === 'archived');
        if (!item) throw new Error('Archived file not found.');
        item.file = { ...item.file, status: 'active', updatedAt: new Date().toISOString() };
        return item.file;
    }
    return postFiles<AtlasFile>('restore', { owner, fileId });
}

/** Project metadata operations are private admin routes. They never manipulate R2 bytes. */
export async function listProjectFolders(projectId: string): Promise<ProjectFolder[]> {
    if (IS_MOCK_MODE) return [...foldersFor(projectId)];
    return postFiles<ProjectFolder[]>('folders-list', { owner: { kind: 'project', id: projectId } });
}
export async function createProjectFolder(projectId: string, parentId: string | null, name: string): Promise<ProjectFolder> {
    if (IS_MOCK_MODE) {
        validateDemoDestination(projectId, parentId);
        if (!name.trim() || name !== name.trim() || name.includes('/') || name.includes('\\') || name === '.' || name === '..')
            throw new Error('Invalid folder name.');
        if (foldersFor(projectId).some(folder => folder.parentId === parentId && folder.status === 'active' &&
            folder.name.toLowerCase() === name.toLowerCase())) throw new Error('A folder with this name already exists.');
        const stamp = new Date().toISOString();
        const folder: ProjectFolder = { id: crypto.randomUUID(), projectId, parentId, name, status: 'active',
            createdAt: stamp, updatedAt: stamp };
        demoFolders.set(projectId, [...foldersFor(projectId), folder]);
        return folder;
    }
    return postFiles<ProjectFolder>('folders-create', { owner: { kind: 'project', id: projectId }, parentId, name });
}
export async function renameProjectFolder(projectId: string, folderId: string, name: string): Promise<ProjectFolder> {
    if (IS_MOCK_MODE) {
        const folder = demoFolder(projectId, folderId);
        if (folder.status !== 'active') throw new Error('Archived folders cannot be renamed.');
        if (!name.trim() || name !== name.trim() || name.includes('/') || name.includes('\\') || name === '.' || name === '..')
            throw new Error('Invalid folder name.');
        if (foldersFor(projectId).some(other => other.id !== folderId && other.parentId === folder.parentId &&
            other.status === 'active' && other.name.toLowerCase() === name.toLowerCase()))
            throw new Error('A folder with this name already exists.');
        Object.assign(folder, { name, updatedAt: new Date().toISOString() });
        return { ...folder };
    }
    return postFiles<ProjectFolder>('folders-rename', { owner: { kind: 'project', id: projectId }, folderId, name });
}
export async function archiveProjectFolder(projectId: string, folderId: string): Promise<ProjectFolder> {
    if (IS_MOCK_MODE) {
        const folder = demoFolder(projectId, folderId);
        if (folder.status !== 'active') throw new Error('Project folder was not found.');
        if (foldersFor(projectId).some(item => item.parentId === folderId && item.status === 'active') ||
            (demoFiles.get(key({ kind: 'project', id: projectId })) ?? [])
                .some(item => item.file.folderId === folderId && item.file.status === 'active'))
            throw new Error('Move or archive active folder contents first.');
        Object.assign(folder, { status: 'archived', updatedAt: new Date().toISOString() });
        return { ...folder };
    }
    return postFiles<ProjectFolder>('folders-archive', { owner: { kind: 'project', id: projectId }, folderId });
}
export async function restoreProjectFolder(projectId: string, folderId: string): Promise<ProjectFolder> {
    if (IS_MOCK_MODE) {
        const folder = demoFolder(projectId, folderId);
        if (folder.status !== 'archived') throw new Error('Project folder was not found.');
        validateDemoDestination(projectId, folder.parentId);
        if (foldersFor(projectId).some(item => item.id !== folder.id && item.parentId === folder.parentId &&
            item.status === 'active' && item.name.toLowerCase() === folder.name.toLowerCase()))
            throw new Error('A folder with this name already exists.');
        Object.assign(folder, { status: 'active', updatedAt: new Date().toISOString() });
        return { ...folder };
    }
    return postFiles<ProjectFolder>('folders-restore', { owner: { kind: 'project', id: projectId }, folderId });
}
export async function moveProjectFile(projectId: string, fileId: string, folderId: string | null): Promise<void> {
    if (IS_MOCK_MODE) {
        validateDemoDestination(projectId, folderId);
        const entry = (demoFiles.get(key({ kind: 'project', id: projectId })) ?? [])
            .find(item => item.file.id === fileId && item.file.status === 'active');
        if (!entry) throw new Error('Atlas file was not found.');
        entry.file = { ...entry.file, folderId, updatedAt: new Date().toISOString() };
        return;
    }
    await postFiles('file-move', { owner: { kind: 'project', id: projectId }, fileId, folderId });
}
