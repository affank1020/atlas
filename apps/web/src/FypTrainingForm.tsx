import { useState } from 'react';
import { callTool } from './api';
import { useFypRead, FypReadMessage } from './fypHistory';
import type { FypEnvironment } from './FypEnvironmentCatalog';
import type { FypRun } from './FypV1Evidence';

type Ticket = { ticket: string; action: string; status: string; run_id?: string | null };

export function FypTrainingForm({ policyId, parent, disabled, onAccepted }: {
    policyId: string; parent?: FypRun; disabled: boolean; onAccepted: (ticket: Ticket) => void;
}) {
    const [mode, setMode] = useState<'resume' | 'transfer'>('resume');
    const [steps, setSteps] = useState(250000);
    const [seed, setSeed] = useState(615);
    const [speed, setSpeed] = useState(1);
    const [environment, setEnvironment] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const environments = useFypRead<FypEnvironment[]>('football_fyp_environments', {});
    const selectedEnvironment = parent && mode === 'resume' ? parent.environment?.environment_id : environment;
    const readiness = useFypRead<{ ready_to_train: boolean; editor_playing: boolean; note?: string }>(
        'football_fyp_preflight', { policyId, ...(selectedEnvironment ? { environmentId: selectedEnvironment } : {}) }, 3000);
    const start = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy(true); setError('');
        try {
            const ticket = await callTool<Ticket>('football_fyp_train', {
                policyId, checkpointMode: parent ? mode : 'fresh', parentRunId: parent?.run_id,
                environmentId: selectedEnvironment || undefined, maxSteps: steps,
                seed: parent && mode === 'resume' ? parent.seed : seed, timeScale: speed,
            });
            onAccepted(ticket);
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setBusy(false); }
    };
    return <section className="fg-panel">
        <h2>{parent ? 'Continue training' : 'Start training'}</h2>
        <form onSubmit={event => void start(event)} className="fg-stack">
            {parent && <label className="fyp-field">Training mode <select value={mode} onChange={event => setMode(event.target.value as 'resume' | 'transfer')}>
                <option value="resume">Resume in the same environment</option>
                <option value="transfer">Transfer to a curriculum environment</option>
            </select></label>}
            {parent && mode === 'resume' ? <p>Continue the saved trainer state in {parent.environment?.name ?? 'the original environment'}. The budget adds steps to the saved checkpoint counter.</p>
                : <label className="fyp-field">Environment <select value={environment} onChange={event => setEnvironment(event.target.value)}>
                    <option value="">Current Unity scene</option>
                    {environments.data?.map(item => <option key={item.environment_id} value={item.environment_id}>{item.name} · v{item.version}</option>)}
                </select></label>}
            <FypReadMessage label="Environments" read={environments} />
            <label className="fyp-field">{parent ? 'Additional training steps' : 'Training steps'} <input type="number" required min={2048} max={2000000} step={1} value={steps} onChange={event => setSteps(Number(event.target.value))} /></label>
            {(!parent || mode === 'transfer') && <label className="fyp-field">Seed <input type="number" required min={0} max={2147483647} step={1} value={seed} onChange={event => setSeed(Number(event.target.value))} /></label>}
            {(!parent || mode === 'transfer') && <label className="fyp-field">Simulation speed <input type="number" required min={1} max={5} step={0.5} value={speed} onChange={event => setSpeed(Number(event.target.value))} /></label>}
            {parent && mode === 'transfer' && <p>Load this checkpoint into a new run with its step counter starting at zero.</p>}
            <FypReadMessage label="Training readiness" read={readiness} />
            {error && <p role="alert">{error}</p>}
            <button className="fg-button fg-primary" type="submit" disabled={disabled || busy || !readiness.data?.ready_to_train || readiness.data.editor_playing}>
                {busy ? 'Starting…' : parent ? mode === 'resume' ? 'Resume training' : 'Transfer and train' : 'Start training'}
            </button>
            <p>Open the selected environment in Unity Edit Mode. Press Play after the request is accepted.</p>
        </form>
    </section>;
}
