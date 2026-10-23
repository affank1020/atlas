import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Files } from './Files';
import {
    archiveFile, archiveProjectFolder, createProjectFolder, downloadFile, listFiles, listProjectFolders,
    moveProjectFile, renameProjectFolder, restoreFile, restoreProjectFolder, uploadFile, listPortfolioProjectMedia,
} from './filesApi';

const projectId = '00000000-0000-4000-8000-000000000001';
const otherProject = '00000000-0000-4000-8000-000000000009';
const folderId = '00000000-0000-4000-8000-000000000002';
const childId = '00000000-0000-4000-8000-000000000004';
const owner = { kind: 'project', id: projectId };
const firstFolder = { id: folderId, projectId, parentId: null, name: 'Modules', status: 'active',
    createdAt: '2026-10-21T13:00:00.000Z', updatedAt: '2026-10-21T13:00:00.000Z' } as const;
const secondFolder = { id: childId, projectId, parentId: folderId, name: 'Week 4', status: 'active',
    createdAt: firstFolder.createdAt, updatedAt: firstFolder.updatedAt } as const;
const saved = {
    id: '00000000-0000-4000-8000-000000000003', owner, folderId: null,
    fileName: 'research.pdf', mimeType: 'application/pdf',
    byteSize: 100, checksum: 'demo', visibility: 'private', status: 'active',
    createdAt: firstFolder.createdAt, updatedAt: firstFolder.updatedAt,
} as const;

vi.mock('./atlasApi', () => ({
    useListProjectsQuery: () => ({
        data: [{ id: projectId, name: 'Research' }, { id: otherProject, name: 'University' }],
        isLoading: false, error: null, isFetching: false, refetch: vi.fn(),
    }),
}));
vi.mock('./filesApi', () => ({
    listFiles: vi.fn(), listProjectFolders: vi.fn(), uploadFile: vi.fn(), downloadFile: vi.fn(),
    archiveFile: vi.fn(), restoreFile: vi.fn(), createProjectFolder: vi.fn(),
    renameProjectFolder: vi.fn(), archiveProjectFolder: vi.fn(), restoreProjectFolder: vi.fn(), moveProjectFile: vi.fn(),
    listPortfolioProjectMedia: vi.fn(),
}));

beforeEach(() => {
    vi.mocked(listFiles).mockResolvedValue([]);
    vi.mocked(listPortfolioProjectMedia).mockResolvedValue([]);
    vi.mocked(listProjectFolders).mockResolvedValue([]);
    vi.mocked(downloadFile).mockResolvedValue(undefined);
    vi.mocked(archiveFile).mockResolvedValue(undefined);
    vi.mocked(restoreFile).mockResolvedValue({ ...saved } as never);
    vi.mocked(createProjectFolder).mockResolvedValue({ ...firstFolder } as never);
    vi.mocked(renameProjectFolder).mockResolvedValue({ ...firstFolder } as never);
    vi.mocked(archiveProjectFolder).mockResolvedValue({ ...firstFolder, status: 'archived' } as never);
    vi.mocked(restoreProjectFolder).mockResolvedValue({ ...firstFolder } as never);
    vi.mocked(moveProjectFile).mockResolvedValue(undefined);
    vi.mocked(uploadFile).mockResolvedValue({ ...saved } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

test('Files browser offers Projects only, scopes root listing and navigates nested folders', async () => {
    vi.mocked(listProjectFolders).mockResolvedValue([firstFolder, secondFolder] as never);
    vi.mocked(listFiles).mockImplementation(async (_owner, _status, dest) => dest === null ? [saved] as never : []);
    render(<Files />);
    expect(screen.queryByRole('combobox', { name: 'Owner type' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Project' })).toBeInTheDocument();
    expect(await screen.findByText('research.pdf')).toBeInTheDocument();
    expect(listFiles).toHaveBeenCalledWith(owner, 'active', null);
    expect(screen.getByRole('button', { name: 'Modules' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Modules' }));
    await waitFor(() => expect(listFiles).toHaveBeenCalledWith(owner, 'active', folderId));
    expect(await screen.findByRole('button', { name: 'Week 4' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Week 4' }));
    await waitFor(() => expect(listFiles).toHaveBeenCalledWith(owner, 'active', childId));
    expect(screen.getByRole('navigation', { name: 'Folder path' })).toHaveTextContent('Research/Modules/Week 4');
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    await screen.findByText('research.pdf');
});

test('File moves target active Project folders without copying or changing ownership', async () => {
    vi.mocked(listFiles).mockResolvedValue([saved] as never);
    vi.mocked(listProjectFolders).mockResolvedValue([firstFolder, secondFolder] as never);
    render(<Files />);
    await screen.findByText('research.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Move research.pdf' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Destination for research.pdf' }), { target: { value: childId } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
    await waitFor(() => expect(moveProjectFile).toHaveBeenCalledWith(projectId, saved.id, childId));
    expect(screen.queryByRole('combobox', { name: 'Destination for research.pdf' })).not.toBeInTheDocument();
});

test('Folder creation, rename, archive and restore use Project-scoped actions', async () => {
    vi.mocked(listProjectFolders).mockResolvedValue([firstFolder] as never);
    render(<Files />);
    await screen.findByRole('button', { name: 'Modules' });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('New folder').mockReturnValueOnce('Renamed');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    await waitFor(() => expect(createProjectFolder).toHaveBeenCalledWith(projectId, null, 'New folder'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename folder Modules' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Rename folder Modules' }));
    await waitFor(() => expect(renameProjectFolder).toHaveBeenCalledWith(projectId, folderId, 'Renamed'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive folder Modules' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Archive folder Modules' }));
    await waitFor(() => expect(archiveProjectFolder).toHaveBeenCalledWith(projectId, folderId));
    prompt.mockRestore(); confirm.mockRestore();
});

test('Archived folders remain discoverable and restorable; active upload is disabled inside them', async () => {
    const archivedFolder = { ...firstFolder, status: 'archived' };
    vi.mocked(listProjectFolders).mockResolvedValue([archivedFolder] as never);
    vi.mocked(listFiles).mockImplementation(async (_owner, status, destination) =>
        status === 'archived' && destination === folderId
            ? [{ ...saved, folderId, status: 'archived' }] as never : []);
    render(<Files />);
    await screen.findByText('This folder is empty');
    expect(screen.queryByRole('button', { name: 'Modules' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'File status' }), { target: { value: 'archived' } });
    expect(await screen.findByRole('button', { name: 'Restore folder Modules' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Modules' }));
    await waitFor(() => expect(listFiles).toHaveBeenCalledWith(owner, 'archived', folderId));
    expect(screen.getByRole('button', { name: 'Upload files' })).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Restore research.pdf' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore folder Modules' }));
    await waitFor(() => expect(restoreProjectFolder).toHaveBeenCalledWith(projectId, folderId));
});

test('Archived files can be restored without downloading and uploads are gated by status', async () => {
    vi.mocked(listFiles).mockImplementation(async (_owner, status) =>
        status === 'archived' ? [{ ...saved, status: 'archived' }] as never : []);
    render(<Files />);
    await screen.findByText('This folder is empty');
    fireEvent.change(screen.getByRole('combobox', { name: 'File status' }), { target: { value: 'archived' } });
    expect(await screen.findByText('research.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload files' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Download research.pdf' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore research.pdf' }));
    await waitFor(() => expect(restoreFile).toHaveBeenCalledWith(owner, saved.id));
});

test('Uploads explicitly select the current Project folder, not a Workspace or Application', async () => {
    vi.mocked(listProjectFolders).mockResolvedValue([firstFolder] as never);
    render(<Files />);
    fireEvent.click(await screen.findByRole('button', { name: 'Modules' }));
    await waitFor(() => expect(listFiles).toHaveBeenCalledWith(owner, 'active', folderId));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload files' })).toBeEnabled());
    const file = new File(['test'], 'week.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Choose files to upload'), { target: { files: [file] } });
    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith(owner, file, folderId));
});

test('Project switch resets folder context and stale responses cannot leak files', async () => {
    vi.mocked(listProjectFolders).mockImplementation(async (id) =>
        id === projectId ? [firstFolder] as never : []);
    let releaseOld: ((files: typeof saved[]) => void) | undefined;
    vi.mocked(listFiles).mockImplementation(async (requestedOwner) => {
        if (requestedOwner.id === projectId) return new Promise(resolve => { releaseOld = resolve; }) as never;
        return [];
    });
    render(<Files />);
    await waitFor(() => expect(releaseOld).toBeDefined());
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: otherProject } });
    await waitFor(() => expect(listFiles).toHaveBeenCalledWith({ kind: 'project', id: otherProject }, 'active', null));
    releaseOld?.([saved]);
    await screen.findByText('This folder is empty');
    expect(screen.queryByText('research.pdf')).not.toBeInTheDocument();
});

test('Downloads and archives stay scoped to selected Project', async () => {
    vi.mocked(listFiles).mockResolvedValue([saved] as never);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Files />);
    await screen.findByText('research.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Download research.pdf' }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledWith(owner, saved));
    fireEvent.click(screen.getByRole('button', { name: 'Archive research.pdf' }));
    await waitFor(() => expect(archiveFile).toHaveBeenCalledWith(owner, saved.id));
    confirm.mockRestore();
});

test('Portfolio originals and variants appear read-only under their Project and archived assets have no open link', async () => {
    const active = { id: '00000000-0000-4000-8000-000000000077', projectId: otherProject,
        fileName: 'hero.png', mimeType: 'image/png', byteSize: 420, checksum: 'a'.repeat(64),
        status: 'active' as const, createdAt: firstFolder.createdAt, updatedAt: firstFolder.updatedAt,
        url: '/api/media/00000000-0000-4000-8000-000000000077/original',
        variants: [{ name: 'preview', mimeType: 'image/webp', byteSize: 160 }] };
    const archived = { ...active, id: '00000000-0000-4000-8000-000000000078',
        fileName: 'old.png', status: 'archived' as const, url: null };
    vi.mocked(listPortfolioProjectMedia).mockImplementation(async id =>
        id === otherProject ? [active, archived] : []);
    render(<Files />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: otherProject } });
    expect(await screen.findByText('hero.png')).toBeInTheDocument();
    expect(listPortfolioProjectMedia).toHaveBeenCalledWith(otherProject);
    expect(screen.getByText('1 variants')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Portfolio media hero.png' }))
        .toHaveAttribute('href', active.url);
    expect(screen.queryByRole('button', { name: 'Move hero.png' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive hero.png' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'File status' }), { target: { value: 'archived' } });
    expect(await screen.findByText('old.png')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Portfolio media old.png' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: projectId } });
    await waitFor(() => expect(screen.queryByText('old.png')).not.toBeInTheDocument());
});

test('Portfolio projection failures do not hide native Project files', async () => {
    vi.mocked(listFiles).mockResolvedValue([saved] as never);
    vi.mocked(listPortfolioProjectMedia).mockRejectedValue(new Error('Media projection unavailable'));
    render(<Files />);
    expect(await screen.findByText('research.pdf')).toBeInTheDocument();
    expect(screen.getByText(/Portfolio media catalogue unavailable/)).toBeInTheDocument();
});
