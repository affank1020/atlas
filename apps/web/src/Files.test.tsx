import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Files } from './Files';
import { archiveFile, downloadFile, listFiles, restoreFile, uploadFile } from './filesApi';

const projectId = '00000000-0000-4000-8000-000000000001';
vi.mock('./atlasApi', () => ({
    useListProjectsQuery: () => ({ data: [{ id: projectId, name: 'Research' }], isLoading: false, error: null, refetch: vi.fn() }),
    useApplicationRead: (name: string) => ({
        data: name === 'list_workspaces'
            ? [{ id: '00000000-0000-4000-8000-000000000002', name: 'Mac Repo', status: 'active' }]
            : [{ slug: 'portfolio', name: 'Portfolio', projectId: null },
                { slug: 'research-app', name: 'Research App', projectId },
                { slug: 'old-app', name: 'Archived App', projectId: '00000000-0000-4000-8000-000000000099' }],
        isLoading: false, error: null, refetch: vi.fn(),
    }),
}));
vi.mock('./filesApi', () => ({
    listFiles: vi.fn(),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    archiveFile: vi.fn(),
    restoreFile: vi.fn(),
}));

const saved = {
    id: '00000000-0000-4000-8000-000000000003',
    owner: { kind: 'project', id: projectId },
    fileName: 'research.pdf', mimeType: 'application/pdf',
    byteSize: 100, checksum: 'demo', visibility: 'private', status: 'active',
    createdAt: '2026-10-21T13:00:00.000Z', updatedAt: '2026-10-21T13:00:00.000Z',
};

test('Files browser lists private scoped files and invokes download and archive', async () => {
    vi.mocked(listFiles).mockResolvedValue([saved] as never);
    vi.mocked(downloadFile).mockResolvedValue(undefined);
    vi.mocked(archiveFile).mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Files />);
    expect(await screen.findByText('research.pdf')).toBeInTheDocument();
    expect(vi.mocked(listFiles)).toHaveBeenCalledWith({ kind: 'project', id: projectId }, 'active');
    expect(screen.getByText('Private')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download research.pdf' }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledWith({ kind: 'project', id: projectId }, saved));
    fireEvent.click(screen.getByRole('button', { name: 'Archive research.pdf' }));
    await waitFor(() => expect(archiveFile).toHaveBeenCalledWith({ kind: 'project', id: projectId }, saved.id));
    expect(screen.queryByText('research.pdf')).not.toBeInTheDocument();
    confirm.mockRestore();
});

test('Files browser changes ownership scope without listing another owners files', async () => {
    vi.mocked(listFiles).mockResolvedValue([]);
    render(<Files />);
    await waitFor(() => expect(listFiles).toHaveBeenCalledWith({ kind: 'project', id: projectId }, 'active'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Owner type' }), { target: { value: 'workspace' } });
    await waitFor(() => expect(listFiles).toHaveBeenCalledWith({
        kind: 'workspace', id: '00000000-0000-4000-8000-000000000002',
    }, 'active'));
    expect(await screen.findByText('No files yet')).toBeInTheDocument();
    expect(uploadFile).not.toHaveBeenCalled();
});

test('Files excludes application owners belonging to archived projects', async () => {
    vi.mocked(listFiles).mockResolvedValue([]);
    render(<Files />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Owner type' }), { target: { value: 'application' } });
    expect(await screen.findByRole('option', { name: 'Portfolio' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Research App' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Archived App' })).not.toBeInTheDocument();
});

test('Archived files are listed separately and can be restored without downloading', async () => {
    const archived = { ...saved, status: 'archived' as const };
    vi.mocked(listFiles).mockImplementation(async (_owner, status) => status === 'archived' ? [archived] as never : []);
    vi.mocked(restoreFile).mockResolvedValue({ ...saved } as never);
    render(<Files />);
    await screen.findByText('No files yet');
    fireEvent.change(screen.getByRole('combobox', { name: 'File status' }), { target: { value: 'archived' } });
    expect(await screen.findByText('research.pdf')).toBeInTheDocument();
    expect(listFiles).toHaveBeenCalledWith({ kind: 'project', id: projectId }, 'archived');
    expect(screen.queryByRole('button', { name: 'Download research.pdf' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload files' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore research.pdf' }));
    await waitFor(() => expect(restoreFile).toHaveBeenCalledWith({ kind: 'project', id: projectId }, saved.id));
    await waitFor(() => expect(screen.queryByText('research.pdf')).not.toBeInTheDocument());
    expect(screen.getByText(/restored. You can now download/)).toBeInTheDocument();
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });
