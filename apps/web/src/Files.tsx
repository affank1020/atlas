import { useEffect, useMemo, useRef, useState } from 'react';
import { useApplicationRead, useListProjectsQuery } from './atlasApi';
import { archiveFile, downloadFile, listFiles, uploadFile, type AtlasFile, type FileOwner } from './filesApi';
import type { ApplicationManifest } from './Applications';
import './files.css';

type WorkspaceChoice = { id: string; name: string; status?: string };
type ScopeChoice = { id: string; name: string };
const prettySize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    const unit = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
};
const prettyDate = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const scopeLabels: Record<FileOwner['kind'], string> = { project: 'Projects', workspace: 'Workspaces', application: 'Applications' };

function FileGlyph({ mimeType }: { mimeType: string }) {
    return <span className="files-glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="21" height="21" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none">
            <path d="M6 2.5h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1zM14 2.5v5h5" />
            {mimeType.startsWith('image/') ? <><circle cx="10" cy="11" r="1.5" /><path d="m7.5 18 4-4 2.5 2 2-2" /></>
                : <path d="M8 12h8M8 16h6" />}
        </svg>
    </span>;
}

/** One admin-facing browser for the shared Files metadata and private object store. */
export function Files() {
    const projects = useListProjectsQuery({ includeArchived: false });
    const workspaces = useApplicationRead<WorkspaceChoice[]>('list_workspaces');
    const apps = useApplicationRead<ApplicationManifest[]>('list_all_applications');
    const [kind, setKind] = useState<FileOwner['kind']>('project');
    const [selectedId, setSelectedId] = useState('');
    const [search, setSearch] = useState('');
    const [entries, setEntries] = useState<AtlasFile[]>([]);
    const [busy, setBusy] = useState(false);
    const [mutating, setMutating] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [version, setVersion] = useState(0);
    const uploadInput = useRef<HTMLInputElement>(null);

    const options = useMemo<ScopeChoice[]>(() => {
        const values: ScopeChoice[] = kind === 'project'
            ? (projects.data ?? []).map(item => ({ id: item.id, name: item.name }))
            : kind === 'workspace'
                ? (workspaces.data ?? []).filter(item => !item.status || item.status === 'active').map(item => ({ id: item.id, name: item.name }))
                : (apps.data ?? []).map(item => ({ id: item.slug, name: item.name }));
        return values.sort((a, b) => a.name.localeCompare(b.name));
    }, [kind, projects.data, workspaces.data, apps.data]);

    useEffect(() => {
        if (!options.some(item => item.id === selectedId)) setSelectedId(options[0]?.id ?? '');
    }, [options, selectedId]);

    const owner = selectedId && options.some(item => item.id === selectedId) ? { kind, id: selectedId } as FileOwner : null;
    useEffect(() => {
        let active = true;
        if (!owner) { setEntries([]); setBusy(false); return; }
        setBusy(true); setError(''); setMessage(''); setEntries([]);
        void listFiles(owner).then(rows => {
            if (active) setEntries(rows);
        }).catch(reason => {
            if (active) setError(reason instanceof Error ? reason.message : 'Could not load files.');
        }).finally(() => { if (active) setBusy(false); });
        return () => { active = false; };
    }, [owner?.kind, owner?.id, version]);

    const reload = () => setVersion(current => current + 1);
    const loadingOwners = projects.isLoading || workspaces.isLoading || apps.isLoading;
    const ownerError = projects.error || workspaces.error || apps.error;
    const visible = entries.filter(item => `${item.fileName} ${item.mimeType}`.toLowerCase().includes(search.trim().toLowerCase()));
    const totalBytes = entries.reduce((sum, item) => sum + item.byteSize, 0);

    const onUpload = async (files: FileList | null) => {
        if (!owner || !files?.length) return;
        const chosen = Array.from(files);
        setError(''); setMessage(''); setMutating(true);
        let uploaded = 0;
        try {
            for (const file of chosen) {
                try { await uploadFile(owner, file); uploaded++; }
                catch (reason) {
                    setError(`Uploaded ${uploaded} of ${chosen.length}. ${file.name}: ${reason instanceof Error ? reason.message : 'Upload failed.'}`);
                    break;
                }
            }
            if (uploaded === chosen.length) setMessage(`${uploaded} ${uploaded === 1 ? 'file' : 'files'} uploaded privately.`);
            const rows = await listFiles(owner);
            setEntries(rows);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not refresh files.');
        } finally {
            setMutating(false);
            if (uploadInput.current) uploadInput.current.value = '';
        }
    };

    const onArchive = async (file: AtlasFile) => {
        if (!owner || !window.confirm(`Archive "${file.fileName}"? It will disappear from Atlas Files, but the stored bytes are retained until a future cleanup policy is configured.`)) return;
        setError(''); setMessage(''); setMutating(true);
        try {
            await archiveFile(owner, file.id);
            setEntries(current => current.filter(item => item.id !== file.id));
            setMessage(`${file.fileName} archived.`);
        } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not archive file.'); }
        finally { setMutating(false); }
    };

    const onDownload = async (file: AtlasFile) => {
        if (!owner) return;
        setError('');
        try { await downloadFile(owner, file); }
        catch (reason) { setError(reason instanceof Error ? reason.message : 'Download failed.'); }
    };

    return <section className="files-page" aria-label="Atlas Files">
        <header className="files-page-header">
            <div><h1>Files</h1><p>Private storage for your projects, workspaces and applications.</p></div>
            <div className="files-actions">
                <button type="button" className="ghost" disabled={busy || mutating || !owner} onClick={reload}>↻ Refresh</button>
                <button type="button" disabled={!owner || mutating || busy} onClick={() => uploadInput.current?.click()}>{mutating ? 'Working…' : 'Upload files'}</button>
                <input ref={uploadInput} type="file" multiple className="files-hidden-input" aria-label="Choose files to upload" onChange={event => void onUpload(event.target.files)} />
            </div>
        </header>
        <div className="files-scope-panel">
            <div className="files-scope-fields">
                <label>Owner type<select aria-label="Owner type" value={kind} onChange={event => { setKind(event.target.value as FileOwner['kind']); setSelectedId(''); }}>
                    {(Object.keys(scopeLabels) as FileOwner['kind'][]).map(entry => <option key={entry} value={entry}>{scopeLabels[entry]}</option>)}
                </select></label>
                <label>Storage owner<select aria-label="Storage owner" value={owner?.id ?? ''} disabled={loadingOwners || !options.length}
                    onChange={event => setSelectedId(event.target.value)}>
                    {options.length === 0 && <option value="">{loadingOwners ? 'Loading owners…' : 'No owners available'}</option>}
                    {options.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select></label>
            </div>
            <span className="files-private-note">Private by default · 25 MiB per file</span>
        </div>
        {ownerError ? <p className="notice error" role="alert">Could not retrieve all storage owners. <button className="ghost" onClick={() => { void projects.refetch(); void workspaces.refetch(); void apps.refetch(); }}>Retry</button></p> : null}
        {error ? <p className="notice error" role="alert">{error}</p> : null}
        {message ? <p className="notice" role="status">{message}</p> : null}
        <div className="files-collection-head">
            <div className="files-collection-info"><h2>Stored files</h2><span>{entries.length} files · {prettySize(totalBytes)}</span></div>
            <input type="search" aria-label="Search stored files" placeholder="Search files…" value={search} onChange={event => setSearch(event.target.value)} />
        </div>
        {busy && <div className="files-skeleton-list" role="status" aria-label="Loading files">{[1, 2, 3].map(value => <div className="files-skeleton-row" key={value}><span /><div><i /><i /></div></div>)}</div>}
        {!busy && owner && visible.length > 0 && <div className="files-list" aria-label="Stored files">
            {visible.map(file => <div className="files-list-row" key={file.id}>
                <FileGlyph mimeType={file.mimeType} />
                <div className="files-item-details"><strong title={file.fileName}>{file.fileName}</strong><span>{prettySize(file.byteSize)} · {file.mimeType} · {prettyDate(file.createdAt)}</span></div>
                <span className="files-privacy">Private</span>
                <div className="files-item-actions">
                    <button type="button" className="ghost" disabled={mutating} onClick={() => void onDownload(file)} aria-label={`Download ${file.fileName}`}>Download</button>
                    <button type="button" className="ghost danger" disabled={mutating} onClick={() => void onArchive(file)} aria-label={`Archive ${file.fileName}`}>Archive</button>
                </div>
            </div>)}
        </div>}
        {!busy && !error && !owner && <div className="files-empty">Select a storage owner to explore their files.</div>}
        {!busy && !error && owner && !entries.length && <div className="files-empty"><h3>No files yet</h3><p>Upload a file to store it privately with this {kind}. It will not appear in the public Portfolio media library.</p></div>}
        {!busy && !error && owner && entries.length > 0 && visible.length === 0 && <div className="files-empty">No files match your search.</div>}
    </section>;
}
