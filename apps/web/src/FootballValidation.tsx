import { useCallback, useEffect, useState } from 'react';
import { callTool } from './api';

type Check = { name: string; status: 'pass' | 'fail' | 'not_run'; detail?: string };
type Receipt = {
    id: string; layer: 'python' | 'editor' | 'physics'; status: 'pass' | 'fail';
    startedAt: string; completedAt: string; durationMs: number;
    sourceSha256: string; checks: Check[]; summary: string; output: string; error?: string;
};
type Snapshot = {
    results: Receipt[]; pythonAvailable: boolean; editorMenuApproved: boolean;
    sourceSha256: string;
};

function briefHash(value?: string) { return value ? value.slice(0, 12) : 'unknown'; }

export function FootballValidation() {
    const [snapshot, setSnapshot] = useState<Snapshot>();
    const [latest, setLatest] = useState<Receipt>();
    const [busy, setBusy] = useState<'python' | 'editor' | 'physics' | 'refresh' | ''>('');
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        const value = await callTool<Snapshot>('football_validation_status');
        setSnapshot(value);
    }, []);
    useEffect(() => {
        let disposed = false;
        void callTool<Snapshot>('football_validation_status').then(v => {
            if (!disposed) setSnapshot(v);
        }).catch(e => { if (!disposed) setError(e instanceof Error ? e.message : String(e)); });
        return () => { disposed = true; };
    }, []);

    async function run(layer: 'python' | 'editor' | 'physics') {
        if (layer === 'physics' && !window.confirm('Enter Unity Play Mode to run a temporary shared Rigidbody collision/goal smoke? The currently open scene also runs its normal Awake/Start components. No PPO will launch.')) return;
        setBusy(layer); setError('');
        try {
            const command = layer === 'python' ? 'football_validate_python' : layer === 'physics' ? 'football_validate_physics_smoke' : 'football_validate_editor_gates';
            const receipt = await callTool<Receipt>(command);
            setLatest(receipt);
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally { setBusy(''); }
    }

    const receipts = snapshot?.results ?? [];
    return <section className="football-panel" aria-label="Football validation">
        <div className="football-panel-head"><div><span className="football-kicker">MEASURED EVIDENCE</span><h2>Validation</h2></div>
            <span>Source {briefHash(snapshot?.sourceSha256)}</span></div>
        <p className="football-muted">Run the fixed Python suite or four Unity Editor predicates on the connected Mac.
            Every result is saved with its source fingerprint and execution log. Predicate checks are not physical agent-policy evaluations.</p>
        {error && <p role="alert" className="football-alert error">{error}</p>}
        <div className="football-actions">
            <button className="football-button primary" disabled={!!busy || snapshot?.pythonAvailable === false}
                onClick={() => void run('python')}>{busy === 'python' ? 'Running Python tests…' : 'Run Python tests'}</button>
            <button className="football-button quiet" disabled={!!busy || !snapshot?.editorMenuApproved}
                title={!snapshot?.editorMenuApproved ? 'Requires locally approved football-only Unity menu access on the Mac Node' : undefined}
                onClick={() => void run('editor')}>{busy === 'editor' ? 'Checking Editor gates…' : 'Run Unity gates'}</button>
            <button className="football-button quiet" disabled={!!busy || !snapshot?.editorMenuApproved}
                onClick={() => void run('physics')}>{busy === 'physics' ? 'Running physics smoke…' : 'Run shared physics smoke'}</button>
            <button className="football-button quiet" disabled={!!busy}
                onClick={() => { setBusy('refresh'); void refresh().catch(e => setError(String(e))).finally(() => setBusy('')); }}>Refresh evidence</button>
        </div>
        {snapshot && !snapshot.editorMenuApproved &&
            <p className="football-muted" role="note">Unity gates are disabled until the Mac owner approves the restricted <code>menu</code> command. Atlas will allow only the five known football validation menus; no arbitrary menu paths are available.</p>}
        <div className="football-validation-layers">
            <div><small>Python regressions</small><strong>{receipts.find(r => r.layer === 'python')?.status ?? 'Not run in Atlas'}</strong></div>
            <div><small>Unity predicates</small><strong>{receipts.find(r => r.layer === 'editor')?.status ?? 'Not run in Atlas'}</strong></div>
            <div><small>Real Rigidbody physics</small><strong>{receipts.find(r => r.layer === 'physics')?.status ?? 'Not run in Atlas'} · shared probe only</strong></div>
            <div><small>Held-out policy evaluation</small><strong>Separate experiment evidence</strong></div>
        </div>
        {latest && <div className="football-receipt" role="status">
            <div><strong>Latest run: {latest.layer} · {latest.status.toUpperCase()}</strong><small>{latest.summary}</small></div>
        </div>}
        <h3>Saved validation runs</h3>
        <div className="football-validation-history">
            {receipts.map(r => <details key={r.id} className="football-validation-entry">
                <summary><strong>{r.layer === 'python' ? 'Python suite' : r.layer === 'physics' ? 'Shared physics smoke' : 'Unity Editor gates'} · {r.status.toUpperCase()}</strong>
                    <span>{new Date(r.completedAt).toLocaleString()} · {(r.durationMs / 1000).toFixed(1)}s · SHA {briefHash(r.sourceSha256)}</span></summary>
                <p>{r.summary}</p>
                <ul>{r.checks.map(c => <li key={c.name}>{c.name} — {c.status}{c.detail ? ': ' + c.detail : ''}</li>)}</ul>
                {r.error && <p role="alert">{r.error}</p>}
                {r.output && <pre>{r.output}</pre>}
            </details>)}
            {snapshot && !receipts.length && <p className="football-muted">No automated receipts yet. Earlier manual Unity and Python passes are documented separately and are not relabelled as automated runs.</p>}
            {!snapshot && !error && <p className="football-muted">Loading validation history from the Mac Node…</p>}
        </div>
    </section>;
}
