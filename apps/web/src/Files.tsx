import { useEffect, useMemo, useRef, useState } from 'react';
import { useListProjectsQuery } from './atlasApi';
import {
    archiveFile, archiveProjectFolder, createProjectFolder, downloadFile, listFiles, listProjectFolders,
    moveProjectFile, renameProjectFolder, restoreFile, restoreProjectFolder, uploadFile, listPortfolioProjectMedia,
    type AtlasFile, type FileOwner, type ProjectFolder, type PortfolioProjectMedia,
} from './filesApi';
import './files.css';

const prettySize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    const unit = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
};
const prettyDate = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function FileGlyph({ mimeType }: { mimeType: string }) {
    return <span className="files-glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="21" height="21" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none">
            <path d="M6 2.5h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1zM14 2.5v5h5" />
            {mimeType.startsWith('image/') ? <><circle cx="10" cy="11" r="1.5" /><path d="m7.5 18 4-4 2.5 2 2-2" /></>
                : <path d="M8 12h8M8 16h6" />}
        </svg>
    </span>;
}
function FolderGlyph() {
    return <span className="files-glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M3 6.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
    </span>;
}

/** Project-owned Files browser. Legacy Workspace/Application records remain accessible
 * to existing API clients, but are not independent storage owners in this UI. */
export function Files() {
    const projects = useListProjectsQuery({ includeArchived: false });
    const choices = useMemo(() => (projects.data ?? []).map(item => ({ id: item.id, name: item.name }))
        .sort((a, b) => a.name.localeCompare(b.name)), [projects.data]);
    const [selectedId, setSelectedId] = useState('');
    const [folderId, setFolderId] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [fileStatus, setFileStatus] = useState<AtlasFile['status']>('active');
    const [entries, setEntries] = useState<AtlasFile[]>([]);
    const [folders, setFolders] = useState<ProjectFolder[]>([]);
    const [mediaEntries, setMediaEntries] = useState<PortfolioProjectMedia[]>([]);
    const [mediaError, setMediaError] = useState('');
    const [busy, setBusy] = useState(false);
    const [mutating, setMutating] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [version, setVersion] = useState(0);
    const [movingId, setMovingId] = useState<string | null>(null);
    const [moveTarget, setMoveTarget] = useState<string>('');
    const uploadInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!choices.some(item => item.id === selectedId)) {
            setSelectedId(choices[0]?.id ?? '');
            setFolderId(null);
            setFileStatus('active');
            setMovingId(null);
        }
    }, [choices, selectedId]);

    const owner: FileOwner | null = selectedId && choices.some(item => item.id === selectedId)
        ? { kind: 'project', id: selectedId } : null;
    const projectName = choices.find(item => item.id === selectedId)?.name ?? 'Project';

    useEffect(() => {
        let live = true;
        if (!owner) { setEntries([]); setFolders([]); setMediaEntries([]); setBusy(false); return; }
        setBusy(true); setEntries([]); setFolders([]); setMediaEntries([]); setError(''); setMediaError('');
        // Portfolio is an independent, read-only catalogue projection. A
        // transient failure in it must not make ordinary Project files vanish.
        const projected = folderId === null
            ? listPortfolioProjectMedia(owner.id).catch(reason => {
                if (live) setMediaError(reason instanceof Error ? reason.message : 'Portfolio media could not be loaded.');
                return [] as PortfolioProjectMedia[];
            }) : Promise.resolve([] as PortfolioProjectMedia[]);
        void Promise.all([listFiles(owner, fileStatus, folderId), listProjectFolders(owner.id), projected])
            .then(([files, folderRows, mediaRows]) => {
                if (live) { setEntries(files); setFolders(folderRows); setMediaEntries(mediaRows); }
            })
            .catch(reason => { if (live) setError(reason instanceof Error ? reason.message : 'Could not load Project files.'); })
            .finally(() => { if (live) setBusy(false); });
        return () => { live = false; };
    }, [owner?.id, fileStatus, folderId, version]);

    const refresh = () => { setVersion(value => value + 1); };
    const reload = () => { refresh(); void projects.refetch(); };
    const currentFolder = folders.find(item => item.id === folderId);
    const trail: ProjectFolder[] = [];
    let cursor = currentFolder;
    // Defensive bound even though the PostgreSQL model rejects cycles.
    while (cursor && trail.length < 100) {
        trail.unshift(cursor);
        cursor = folders.find(item => item.id === cursor?.parentId);
    }
    const activeFolders = folders.filter(item => item.status === 'active');
    const folderPath = (folder: ProjectFolder): string => {
        const names = [folder.name];
        const seen = new Set([folder.id]);
        let parent = folders.find(item => item.id === folder.parentId);
        while (parent && !seen.has(parent.id) && names.length < 100) {
            names.unshift(parent.name);
            seen.add(parent.id);
            parent = folders.find(item => item.id === parent?.parentId);
        }
        return names.join(' / ');
    };
    const searchText = search.trim().toLocaleLowerCase();
    const visibleFolders = folders.filter(item => item.parentId === folderId &&
        (fileStatus === 'archived' || item.status === 'active') &&
        item.name.toLocaleLowerCase().includes(searchText));
    const visibleFiles = entries.filter(item =>
        (item.fileName + ' ' + item.mimeType).toLocaleLowerCase().includes(searchText));
    const visibleMedia = folderId === null ? mediaEntries.filter(item =>
        item.status === fileStatus && (item.fileName + ' ' + item.mimeType).toLocaleLowerCase().includes(searchText)) : [];
    const totalBytes = entries.reduce((sum, item) => sum + item.byteSize, 0);
    const canWrite = !!owner && fileStatus === 'active' && !busy && !mutating && (folderId === null || currentFolder?.status === 'active');

    const selectProject = (id: string) => {
        setSelectedId(id); setFolderId(null); setSearch(''); setFileStatus('active');
        setMovingId(null); setError(''); setMessage('');
    };
    const navigate = (id: string | null, archived = false) => {
        if (mutating) return;
        setFolderId(id); setMovingId(null); setSearch(''); setError(''); setMessage('');
        if (archived) setFileStatus('archived');
    };
    const mutate = async (action: () => Promise<unknown>, success: string) => {
        setMutating(true); setError(''); setMessage('');
        try { await action(); setMessage(success); refresh(); }
        catch (reason) { setError(reason instanceof Error ? reason.message : 'Files operation failed.'); }
        finally { setMutating(false); }
    };
    const onCreateFolder = () => {
        if (!owner || !canWrite) return;
        const name = window.prompt('New folder name');
        if (name === null) return;
        void mutate(() => createProjectFolder(owner.id, folderId, name), 'Folder created.');
    };
    const onRenameFolder = (folder: ProjectFolder) => {
        if (!owner || mutating) return;
        const name = window.prompt('Rename folder', folder.name);
        if (name === null || name === folder.name) return;
        void mutate(() => renameProjectFolder(owner.id, folder.id, name), 'Folder renamed.');
    };
    const onArchiveFolder = (folder: ProjectFolder) => {
        if (!owner || mutating || !window.confirm('Archive "' + folder.name + '"? Move or archive active contents first. No bytes will be deleted.')) return;
        void mutate(() => archiveProjectFolder(owner.id, folder.id), 'Folder archived.');
    };
    const onRestoreFolder = (folder: ProjectFolder) => {
        if (!owner || mutating) return;
        void mutate(() => restoreProjectFolder(owner.id, folder.id), 'Folder restored.');
    };
    const onUpload = async (files: FileList | null) => {
        if (!owner || !canWrite || !files?.length) return;
        setMutating(true); setError(''); setMessage('');
        const chosen = Array.from(files);
        let uploaded = 0;
        try {
            for (const file of chosen) {
                try { await uploadFile(owner, file, folderId); uploaded++; }
                catch (reason) {
                    setError('Uploaded ' + uploaded + ' of ' + chosen.length + '. ' + file.name + ': ' +
                        (reason instanceof Error ? reason.message : 'Upload failed.'));
                    break;
                }
            }
            if (uploaded === chosen.length) setMessage(uploaded + (uploaded === 1 ? ' file uploaded privately.' : ' files uploaded privately.'));
            refresh();
        } finally {
            setMutating(false);
            if (uploadInput.current) uploadInput.current.value = '';
        }
    };
    const onArchive = (file: AtlasFile) => {
        if (!owner || mutating || !window.confirm('Archive "' + file.fileName + '"? Stored bytes will be retained.')) return;
        void mutate(() => archiveFile(owner, file.id), file.fileName + ' archived.');
    };
    const onRestore = (file: AtlasFile) => {
        if (!owner || mutating) return;
        void mutate(() => restoreFile(owner, file.id), file.fileName + ' restored.');
    };
    const onDownload = async (file: AtlasFile) => {
        if (!owner) return;
        setError('');
        try { await downloadFile(owner, file); }
        catch (reason) { setError(reason instanceof Error ? reason.message : 'Download failed.'); }
    };
    const onMove = (file: AtlasFile) => {
        if (!owner || mutating) return;
        const destination = moveTarget === '' ? null : moveTarget;
        if (destination === file.folderId) { setMovingId(null); return; }
        void mutate(() => moveProjectFile(owner.id, file.id, destination), file.fileName + ' moved.');
        setMovingId(null);
    };

    return <section className="files-page" aria-label="Atlas Files">
        <header className="files-page-header">
            <div><h1>Files</h1><p>Project-owned storage for documents, media and application assets.</p></div>
            <div className="files-actions">
                <button type="button" className="ghost" disabled={busy || mutating || projects.isFetching} onClick={reload}>↻ Refresh</button>
                <button type="button" className="ghost" disabled={!canWrite} onClick={onCreateFolder}>New folder</button>
                <button type="button" disabled={!canWrite} onClick={() => uploadInput.current?.click()}>{mutating ? 'Working…' : 'Upload files'}</button>
                <input ref={uploadInput} type="file" multiple className="files-hidden-input"
                    aria-label="Choose files to upload" onChange={event => void onUpload(event.target.files)} />
            </div>
        </header>
        <div className="files-scope-panel">
            <div className="files-scope-fields">
                <label>Project<select aria-label="Project" value={owner?.id ?? ''} disabled={mutating || projects.isLoading || !choices.length}
                    onChange={event => selectProject(event.target.value)}>
                    {!choices.length && <option value="">{projects.isLoading ? 'Loading Projects…' : 'No Projects available'}</option>}
                    {choices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select></label>
            </div>
            <span className="files-private-note">Private by default · 25 MiB per file</span>
        </div>
        {projects.error && <p className="notice error" role="alert">Could not load Projects. <button type="button" className="ghost" onClick={() => void projects.refetch()}>Retry</button></p>}
        {error && <p className="notice error" role="alert">{error}</p>}
        {message && <p className="notice" role="status">{message}</p>}
        {owner && <nav className="files-breadcrumbs" aria-label="Folder path">
            <button type="button" disabled={mutating || folderId === null} onClick={() => navigate(null)}>{projectName}</button>
            {trail.map(folder => <span className="files-crumb" key={folder.id}><span aria-hidden="true">/</span>
                <button type="button" disabled={mutating || folder.id === folderId}
                    aria-current={folder.id === folderId ? 'page' : undefined}
                    onClick={() => navigate(folder.id, folder.status === 'archived')}>{folder.name}</button></span>)}
        </nav>}
        <div className="files-collection-head">
            <div className="files-collection-info">
                <h2>{currentFolder?.name ?? 'Project files'}</h2>
                <span>{entries.length} files · {prettySize(totalBytes)}</span>
            </div>
            <div className="files-collection-controls">
                <label className="files-status-control">Status
                    <select aria-label="File status" value={fileStatus} disabled={mutating}
                        onChange={event => {
                            const value = event.target.value as AtlasFile['status'];
                            if (value === 'active' && currentFolder?.status === 'archived') setFolderId(null);
                            setFileStatus(value); setMovingId(null);
                        }}>
                        <option value="active">Active</option><option value="archived">Archived</option>
                    </select>
                </label>
                <input type="search" aria-label="Search current folder" placeholder="Search this folder…"
                    value={search} onChange={event => setSearch(event.target.value)} />
            </div>
        </div>
        {busy && <div className="files-skeleton-list" role="status" aria-label="Loading files">
            {[1, 2, 3].map(value => <div className="files-skeleton-row" key={value}><span /><div><i /><i /></div></div>)}
        </div>}
        {!busy && owner && (visibleFolders.length > 0 || visibleFiles.length > 0) && <div className="files-list" aria-label="Project folder contents">
            {visibleFolders.map(folder => <div className="files-list-row" key={'folder-' + folder.id}>
                <FolderGlyph />
                <div className="files-item-details"><strong title={folder.name}>
                    <button className="files-folder-link" type="button" disabled={mutating}
                        onClick={() => navigate(folder.id, folder.status === 'archived')}>{folder.name}</button>
                </strong><span>Folder · {prettyDate(folder.createdAt)}</span></div>
                <span className="files-privacy">{folder.status === 'archived' ? 'Archived' : 'Folder'}</span>
                <div className="files-item-actions">
                    {folder.status === 'active' ? <>
                        <button type="button" className="ghost" disabled={mutating} onClick={() => onRenameFolder(folder)}
                            aria-label={'Rename folder ' + folder.name}>Rename</button>
                        <button type="button" className="ghost danger" disabled={mutating} onClick={() => onArchiveFolder(folder)}
                            aria-label={'Archive folder ' + folder.name}>Archive</button>
                    </> : <button type="button" className="ghost" disabled={mutating}
                        onClick={() => onRestoreFolder(folder)} aria-label={'Restore folder ' + folder.name}>Restore</button>}
                </div>
            </div>)}
            {visibleFiles.map(file => <div className="files-list-row" key={file.id}>
                <FileGlyph mimeType={file.mimeType} />
                <div className="files-item-details"><strong title={file.fileName}>{file.fileName}</strong>
                    <span>{prettySize(file.byteSize)} · {file.mimeType} · {prettyDate(file.createdAt)}</span></div>
                <span className="files-privacy">{fileStatus === 'archived' ? 'Archived' : 'Private'}</span>
                <div className="files-item-actions">
                    {fileStatus === 'archived' ?
                        <button type="button" className="ghost" disabled={mutating || currentFolder?.status === 'archived'}
                            title={currentFolder?.status === 'archived' ? 'Restore the containing folder first' : undefined}
                            onClick={() => onRestore(file)} aria-label={'Restore ' + file.fileName}>Restore</button> : <>
                        <button type="button" className="ghost" disabled={mutating}
                            onClick={() => void onDownload(file)} aria-label={'Download ' + file.fileName}>Download</button>
                        <button type="button" className="ghost" disabled={mutating}
                            onClick={() => { setMovingId(file.id); setMoveTarget(file.folderId ?? ''); }}
                            aria-label={'Move ' + file.fileName}>Move</button>
                        <button type="button" className="ghost danger" disabled={mutating}
                            onClick={() => onArchive(file)} aria-label={'Archive ' + file.fileName}>Archive</button>
                    </>}
                </div>
                {fileStatus === 'active' && movingId === file.id && <div className="files-move-panel">
                    <label>Move to<select aria-label={'Destination for ' + file.fileName} value={moveTarget} disabled={mutating}
                        onChange={event => setMoveTarget(event.target.value)}>
                        <option value="">Project root</option>
                        {activeFolders.map(folder => <option key={folder.id} value={folder.id}>{folderPath(folder)}</option>)}
                    </select></label>
                    <button type="button" disabled={mutating} onClick={() => onMove(file)}>Confirm move</button>
                    <button type="button" className="ghost" disabled={mutating} onClick={() => setMovingId(null)}>Cancel</button>
                </div>}
            </div>)}
        </div>}
        {!busy && !error && owner && folderId === null && mediaError && <p className="notice error" role="alert">
            Portfolio media catalogue unavailable: {mediaError}
        </p>}
        {!busy && !error && owner && visibleMedia.length > 0 && <section className="files-portfolio-section" aria-label="Portfolio media">
            <div className="files-portfolio-header">
                <h3>Portfolio media</h3>
                <span>Read-only · Managed by Portfolio · {visibleMedia.length} items</span>
            </div>
            <div className="files-list">
                {visibleMedia.map(item => <div className="files-list-row" key={'portfolio-' + item.id}>
                    <FileGlyph mimeType={item.mimeType} />
                    <div className="files-item-details"><strong title={item.fileName}>{item.fileName}</strong>
                        <span>{prettySize(item.byteSize)} · {item.mimeType} · {item.variants.length} variants · {prettyDate(item.createdAt)}</span>
                    </div>
                    <span className="files-privacy">{item.status === 'archived' ? 'Archived' : 'Portfolio'}</span>
                    <div className="files-item-actions">
                        {item.url && <a className="files-media-link" href={item.url} target="_blank"
                            rel="noopener noreferrer" aria-label={'Open Portfolio media ' + item.fileName}>Open media</a>}
                    </div>
                </div>)}
            </div>
        </section>}
        {!busy && !error && !owner && <div className="files-empty">{projects.isLoading ? 'Loading Projects…' : 'No Projects available. Create a Project to store files.'}</div>}
        {!busy && !error && owner && !visibleFolders.length && !visibleFiles.length && !visibleMedia.length &&
            <div className="files-empty">{searchText
                ? 'Nothing matches your search in this folder.'
                : fileStatus === 'archived'
                    ? <><h3>No archived items here</h3><p>Archived files and folders can be restored while their original bytes are retained.</p></>
                    : <><h3>This folder is empty</h3><p>Create a folder or upload files to {currentFolder?.name ?? projectName}. Existing Portfolio assets appear here as read-only media.</p></>}
            </div>}
    </section>;
}
