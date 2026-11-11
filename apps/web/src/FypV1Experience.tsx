import { useCallback, useEffect, useState } from 'react';
import { callTool } from './api';

type FypManifest = { available: boolean; contract: { contract_id: string; behavior: string; observations: { size: number }; actions: { continuous: number }; scene: string; trainer_kind: string } };
type FypPreflight = { editor_available: boolean; trainer_available: boolean; verified_build: boolean; ready_to_train: boolean; source_sha256: string; note: string };
type FypRun = { run_id: string; preset: string; steps: number; seed: number; state: string; source_sha256: string; exported_model?: boolean; error?: string };
type FypTicket = { accepted?: boolean; ticket: string; run_id?: string | null; action: string; status: string; result?: unknown; error?: string; note?: string };

export function FypV1Experience() {
    const [manifest, setManifest] = useState<FypManifest | null>(null);
    const [preflight, setPreflight] = useState<FypPreflight | null>(null);
    const [runs, setRuns] = useState<FypRun[]>([]);
    const [seed, setSeed] = useState(63);
    const [basePort, setBasePort] = useState(5605);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [ticket, setTicket] = useState<FypTicket | null>(null);

    const refresh = useCallback(async () => {
        try {
            const [m, p, r] = await Promise.all([
                callTool<FypManifest>('football_fyp_manifest'),
                callTool<FypPreflight>('football_fyp_preflight'),
                callTool<FypRun[]>('football_fyp_runs'),
            ]);
            setManifest(m); setPreflight(p); setRuns(r); setError('');
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    }, []);
    useEffect(() => { void refresh(); }, [refresh]);

    const perform = async (operation: 'build' | 'smoke' | 'pilot_50k') => {
        setBusy(operation); setError(''); setNotice('');
        try {
            const response = operation === 'build'
                ? await callTool<FypTicket>('football_fyp_build')
                : await callTool<FypTicket>('football_fyp_train', {
                    preset: operation, seed, basePort,
                });
            setTicket(response);
            setNotice('Request accepted on the FYP Mac Node. Check the receipt and run status; no result is presumed.');
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setBusy(''); }
    };
    const inspect = async () => {
        if (!ticket) return;
        try {
            const response = await callTool<FypTicket>('football_fyp_task_status', { runId: ticket.ticket });
            setTicket(response);
            if (response.status === 'completed') await refresh();
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    };

    return <div className="fg-stack" aria-label="FYP v1 training">
        <section className="fg-panel">
            <h2>FYP — new Unity football project</h2>
            <p className="fg-muted">Canonical successor to AI Football. The FootballV1 25/8 policy is independent of historical V2 54/5 and experimental FootV1 54/7 models.</p>
            <div className="fg-stats">
                <div><small>Behavior</small><strong>{manifest?.contract.behavior ?? 'Unavailable'}</strong></div>
                <div><small>Observations</small><strong>{manifest?.contract.observations.size ?? '—'}</strong></div>
                <div><small>Actions</small><strong>{manifest?.contract.actions.continuous ?? '—'}</strong></div>
                <div><small>Trainer</small><strong>{manifest?.contract.trainer_kind ?? '—'}</strong></div>
            </div>
            <p className="fg-muted">Scene: {manifest?.contract.scene ?? 'FYP Unity Workspace not connected'}</p>
            {error && <p className="fg-error" role="alert">{error}</p>}
            {notice && <p className="fg-notice" role="status">{notice}</p>}
            <button className="fg-button" type="button" onClick={() => void refresh()} disabled={!!busy}>Refresh FYP preflight</button>
        </section>
        <section className="fg-panel">
            <h2>Local readiness</h2>
            <p>Unity Editor: <strong>{preflight?.editor_available ? 'Detected' : 'Not verified'}</strong> · Python trainer: <strong>{preflight?.trainer_available ? 'Detected' : 'Not verified'}</strong> · Source-pinned player: <strong>{preflight?.verified_build ? 'Verified' : 'Not ready'}</strong></p>
            <p className="fg-muted">Source fingerprint: {preflight?.source_sha256?.slice(0, 14) ?? '—'} · No training launch until the source and binary are verified.</p>
            <div className="fg-actions">
                <button className="fg-button" type="button" disabled={!!busy || !manifest} onClick={() => void perform('build')}>Build FYP player</button>
            </div>
        </section>
        <section className="fg-panel">
            <h2>Bounded MA-POCA training</h2>
            <div className="fg-actions">
                <label>Seed <input aria-label="FYP training seed" type="number" min={0} max={2147483647} value={seed} onChange={e => setSeed(Number(e.target.value))}/></label>
                <label>Base port <input aria-label="FYP training port" type="number" min={1024} max={65519} value={basePort} onChange={e => setBasePort(Number(e.target.value))}/></label>
            </div>
            <div className="fg-actions">
                <button className="fg-button primary" type="button" disabled={!!busy || !preflight?.ready_to_train} onClick={() => void perform('smoke')}>Run 2,048-step smoke</button>
                <button className="fg-button" type="button" disabled={!!busy || !preflight?.ready_to_train} onClick={() => void perform('pilot_50k')}>Run 50k pilot</button>
            </div>
            <p className="fg-muted">Training produces a candidate model only. There is no automatic evaluation, Watch approval, policy promotion or phase advancement.</p>
            {ticket && <div aria-label="FYP operation receipt">
                <p>Operation: <strong>{ticket.action}</strong> · State: <strong>{ticket.status}</strong> · Ticket: <code>{ticket.ticket}</code></p>
                {ticket.run_id && <p>Run: <code>{ticket.run_id}</code></p>}
                {ticket.error && <p className="fg-error">{ticket.error}</p>}
                <button type="button" className="fg-button" onClick={() => void inspect()}>Check operation receipt</button>
            </div>}
        </section>
        <section className="fg-panel">
            <h2>FYP training receipts</h2>
            {runs.length === 0 ? <p className="fg-muted">No FYP v1 training results recorded yet.</p> :
                <ul>{runs.map(run => <li key={run.run_id}>
                    <strong>{run.run_id}</strong> · {run.state} · {run.preset} · seed {run.seed}
                    {run.exported_model === true ? ' · ONNX exported' : ''}
                    {run.error ? ` · ${run.error}` : ''}
                </li>)}</ul>}
        </section>
    </div>;
}
