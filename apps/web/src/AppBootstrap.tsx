import { useCallback, useEffect, useRef, useState } from 'react';
import App from './App';
import { preloadProjects, type BootstrapProgress, type BootstrapTask } from './bootstrap';
import { store } from './store';

type Phase = 'loading' | 'list-error' | 'partial' | 'ready';
const initialProgress: BootstrapProgress = { completed: 0, total: null, activeProjects: 0, failed: 0 };

/** Runs once per app startup; route changes only mount consumers of the shared cache. */
export function Bootstrap() {
    const [phase, setPhase] = useState<Phase>('loading');
    const [progress, setProgress] = useState(initialProgress);
    const [failedTasks, setFailedTasks] = useState<BootstrapTask[]>([]);
    const [error, setError] = useState('');
    const started = useRef(false);
    const stopped = useRef(false);
    const generation = useRef(0);

    const run = useCallback(async (retryTasks?: BootstrapTask[]) => {
        const current = ++generation.current;
        stopped.current = false;
        setPhase('loading');
        setError('');
        const result = await preloadProjects(store.dispatch, next => {
            if (generation.current === current) setProgress(next);
        }, () => stopped.current, retryTasks);
        if (generation.current !== current) return;
        console.info('[Atlas] bootstrap', result.metrics);
        setFailedTasks(result.failedTasks);
        if (result.listError) { setError(result.listError); setPhase('list-error'); }
        else setPhase(result.failedTasks.length ? 'partial' : 'ready');
    }, []);

    useEffect(() => {
        // React StrictMode replays effects in development. The ref prevents a
        // second startup pass and keeps both passes attached to one RTK cache.
        if (started.current) return;
        started.current = true;
        void run();
    }, [run]);

    const continueWithCache = () => {
        stopped.current = true;
        generation.current++;
        setPhase('ready');
    };

    if (phase === 'ready') return <div className="atlas-app-enter"><App /></div>;
    const discovered = progress.total !== null;
    const complete = discovered && progress.completed === progress.total;
    const canContinue = discovered || phase === 'list-error';
    return <div className="atlas-bootstrap" role="main">
        <div className="atlas-bootstrap-glow" aria-hidden="true" />
        <section className="atlas-bootstrap-card" aria-label="Atlas startup">
            <div className="atlas-bootstrap-mark" aria-hidden="true"><span>A</span></div>
            <p className="atlas-bootstrap-wordmark">ATLAS <span>WEB</span></p>
            <h1>{phase === 'list-error' ? 'Atlas is unavailable' : phase === 'partial' ? 'Some projects are unavailable' : 'Preparing your workspace'}</h1>
            <p className="atlas-bootstrap-description">{phase === 'list-error' ? 'The project list could not be loaded. You can retry or open Atlas with limited data.' : phase === 'partial' ? 'The available project data is ready. Retry the remaining requests or continue.' : 'Loading your projects and the data needed for quick navigation.'}</p>
            <div className="atlas-bootstrap-progress" aria-live="polite">
                {discovered ? <progress max={progress.total || 1} value={progress.completed} aria-label="Bootstrap requests completed" /> : <div className="atlas-bootstrap-discovery" role="status" aria-label="Finding projects" />}
                <div className="atlas-bootstrap-progress-text">
                    <span>{discovered ? `${progress.completed} of ${progress.total} requests complete` : 'Finding projects'}</span>
                    {discovered && <span>{progress.activeProjects} {progress.activeProjects === 1 ? 'project' : 'projects'}{progress.failed ? ` · ${progress.failed} unavailable` : ''}</span>}
                </div>
            </div>
            {(phase === 'partial' || phase === 'list-error') && <p className="atlas-bootstrap-error" role="alert">{error || `${failedTasks.length} project ${failedTasks.length === 1 ? 'request' : 'requests'} could not be completed.`}</p>}
            {(phase === 'partial' || phase === 'list-error') && <div className="atlas-bootstrap-actions"><button onClick={() => void run(phase === 'partial' ? failedTasks : undefined)}>Retry {phase === 'partial' ? 'failed requests' : 'connection'}</button><button className="ghost" onClick={continueWithCache}>Continue with available data</button></div>}
            {phase === 'loading' && canContinue && !complete && <button className="atlas-bootstrap-skip" onClick={continueWithCache}>Continue while projects finish loading →</button>}
        </section>
    </div>;
}
