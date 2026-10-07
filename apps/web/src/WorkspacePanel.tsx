import { WorkspaceHost } from './Nodes';
import "./workspaces.css";
import { useEffect, useState } from 'react';
import { callTool } from './api';

type Workspace = { id: string; nodeId: string; name: string; rootPath: string; kind: string; adapter: string | null };
type DevTask = { task: string; command: string; timeoutMs: number };
type DevResult = { task: string; success: boolean; exitCode: number | null; timedOut: boolean; durationMs: number; stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean };
type GitStatus = { available: boolean; branch?: string; dirty?: boolean; reason?: string; changes?: { path: string; status: string }[]; truncated?: boolean };
type UnityStatus = { available: boolean; state: string; cliVersion?: string; pipeline?: string; message?: string; commands?: { name: string; description?: string; approved: boolean; inputSchema: unknown }[] };
export function WorkspacePanel({ projectId, archived = false }: { projectId: string; archived?: boolean }) {
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [git, setGit] = useState<GitStatus>(); const [unity, setUnity] = useState<UnityStatus>();
    const [devTasks, setDevTasks] = useState<DevTask[]>([]); const [devResult, setDevResult] = useState<DevResult>();
    const [hostRevision, setHostRevision] = useState(0);
    const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
    const [entries, setEntries] = useState<{ path: string; type: string }[]>([]); const [truncated, setTruncated] = useState(false);
    const [preview, setPreview] = useState<{ path: string; text: string }>();
    const workspace = workspaces[0];
    async function refresh() {
        setHostRevision(value => value + 1); setBusy(true); setError(''); setGit(undefined); setUnity(undefined); setEntries([]); setPreview(undefined); setDevTasks([]);
        try {
            const list = await callTool<Workspace[]>('list_project_workspaces', { projectId }); setWorkspaces(list);
            if (list[0]) {
                const scope = { projectId, workspaceId: list[0].id };
                const results = await Promise.allSettled([
                    callTool<DevTask[]>('workspace_list_dev_tasks', scope).then(setDevTasks),
                    callTool<GitStatus>('workspace_git_status', scope).then(setGit),
                    callTool<{ entries: { path: string; type: string }[]; truncated: boolean }>('workspace_list_files', { ...scope, depth: 2, limit: 150 }).then(x => { setEntries(x.entries); setTruncated(x.truncated); }),
                    ...(list[0].kind === 'unity' ? [callTool<UnityStatus>('unity_list_commands', scope).then(setUnity)] : []),
                ]);
                const errors = results.filter((x): x is PromiseRejectedResult => x.status === 'rejected').map(x => x.reason.message); setError(errors.join(' '));
            }
        } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }
    useEffect(() => { if (!archived) void refresh(); }, [projectId, archived]);
    async function register(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError('');
        try { await callTool('create_workspace', { projectId, name: data.get('name'), rootPath: data.get('rootPath'), kind: data.get('kind') }); await refresh(); }
        catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }
    async function detach() {
        if (!workspace || !confirm('Detach this workspace? Files on disk will be preserved.')) return;
        setBusy(true); try { await callTool('archive_workspace', { projectId, workspaceId: workspace.id }); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }
    async function runTask(task: string) {
        if (!workspace) return; setBusy(true); setError(''); setDevResult(undefined);
        try { setDevResult(await callTool<DevResult>('workspace_run_dev_task', { projectId, workspaceId: workspace.id, task })); }
        catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }
    async function read(path: string) {
        setError(''); setPreview(undefined);
        try { setPreview(await callTool('workspace_read_file', { projectId, workspaceId: workspace!.id, path })); } catch (e) { setError((e as Error).message); }
    }
    return <section className="panel" aria-label="Workspace">
        <div className="panel-head"><div><p className="eyebrow">Workspace</p><h2>Project resource</h2></div><button disabled={busy || archived} onClick={refresh}>{busy ? 'Checking…' : 'Refresh'}</button></div>
        <div className="workspace-body">
        {error && <p role="alert">{error}</p>}
        {archived ? <p>This project is archived. Workspace access is disabled.</p> : workspace ? <>
            <h3>{workspace.name}</h3>{workspace.nodeId && <WorkspaceHost key={`${workspace.nodeId}:${hostRevision}`} nodeId={workspace.nodeId} />}<p><code>{workspace.rootPath}</code></p><p>{workspace.kind} · Adapter: {workspace.adapter ?? 'None'}</p>
            <p>{git ? git.available ? `${git.branch} · ${git.dirty ? 'Uncommitted changes' : 'Clean'}` : git.reason : 'Git status unavailable'}</p>
            {!!git?.changes?.length && <details><summary>{git.changes.length} changed files{git.truncated ? ' (truncated)' : ''}</summary><ul>{git.changes.map(x => <li key={x.path}><code>{x.status} {x.path}</code></li>)}</ul></details>}
            {unity && <div><h3>Unity · {unity.state.replaceAll('_', ' ')}</h3><p>{unity.cliVersion && `CLI ${unity.cliVersion}`} {unity.pipeline && `· Pipeline ${unity.pipeline}`}</p><p>{unity.message}</p>
                {!!unity.commands?.length && <details><summary>Unity commands ({unity.commands.length})</summary>
                    {unity.commands.map(x => <details key={x.name}><summary>{x.name} · {x.approved ? 'Approved' : 'Not approved'}</summary><p>{x.description}</p><pre style={{ overflow: 'auto', maxHeight: 220 }}>{JSON.stringify(x.inputSchema, null, 2)}</pre></details>)}
                </details>}
            </div>}
            {!!devTasks.length && <div className="workspace-dev"><h3>Development tasks</h3><div className="form-actions">{devTasks.map(item => <button key={item.task} className="ghost" disabled={busy} title={item.command} onClick={() => runTask(item.task)}>Run {item.task}</button>)}</div>
                {devResult && <div role="status"><p><strong>{devResult.task} · {devResult.success ? 'Passed' : 'Failed'} · {(devResult.durationMs / 1000).toFixed(1)}s</strong>{devResult.timedOut && ' · Timed out'}{devResult.exitCode !== null && ` · Exit ${devResult.exitCode}`}</p>
                    {devResult.stdout && <details><summary>Standard output{devResult.stdoutTruncated ? ' (truncated)' : ''}</summary><pre>{devResult.stdout}</pre></details>}
                    {devResult.stderr && <details><summary>Errors{devResult.stderrTruncated ? ' (truncated)' : ''}</summary><pre>{devResult.stderr}</pre></details>}
                </div>}
            </div>}
            <div className="form-actions"><button disabled={busy} onClick={refresh}>Test connection</button><button className="ghost danger" disabled={busy} onClick={detach}>Archive / detach</button></div>
            <details><summary>Files · read-only preview{truncated ? ' (bounded listing)' : ''}</summary>
                <ul>{entries.map(x => <li key={x.path}>{x.type === 'file' ? <button className="ghost" onClick={() => read(x.path)}>{x.path}</button> : <code>{x.path}/</code>}</li>)}</ul>
                {preview && <><h3>{preview.path}</h3><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 480, overflow: 'auto' }}>{preview.text}</pre></>}
            </details>
        </> : <form className="form" onSubmit={register}><p>Bind an existing local repository under ATLAS_WORKSPACE_ROOTS.</p><label>Name<input name="name" required maxLength={200} /></label><label>Local root<input name="rootPath" required placeholder="/Users/you/Projects/MyProject" /></label><label>Kind<select name="kind"><option value="generic">Generic</option><option value="unity">Unity</option></select></label><button disabled={busy}>Bind workspace</button></form>}
        </div>
    </section>;
}
