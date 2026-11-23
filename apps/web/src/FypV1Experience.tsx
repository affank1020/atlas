import { useEffect, useRef, useState } from 'react';
import { callTool } from './api';
import { FypV1Evidence, TrainingEvidenceCard, type FypRun, type FypRunSummary, type FypEvaluation, type FypEvaluationSummary, type HistoryRow } from './FypV1Evidence';
import { FypPagination, FypReadMessage, useFypPage, useFypRead, type FypPageResult } from './fypHistory';
import { FypEnvironmentCatalog, type FypEnvironment } from './FypEnvironmentCatalog';
import { FypPolicyPage, type FypPolicy } from './FypPolicyPage';

type FypManifest = { available: boolean; policy: FypPolicy; policies: FypPolicy[]; execution_supported: boolean; contract: { contract_id: string; behavior: string; observations: { size: number }; actions: { continuous: number }; scene: string; trainer_kind: string } };
type FypPreflight = {
    editor_available: boolean; editor_open: boolean; editor_playing: boolean; editor_compiling?: boolean;
    trainer_connected: boolean; agent_controlled?: boolean; trainer_available: boolean; scene_ready: boolean; active_scene: string | null;
    environment_present: boolean; episode: number | null; goals: number | null; last_outcome: string | null;
    episodes_completed: number | null; recent_episodes: { session_id: string; sequence: number; episode: number; seed: number; goals: number; elapsed_seconds: number; outcome: string; trainer_connected: boolean }[];
    environment_session_id?: string | null;
    heartbeat_age_seconds: number | null; verified_build: boolean; ready_to_train: boolean; policy_supported?: boolean;
    source_sha256: string; note: string;
};
type FypOverview = { runs: number; checkpoints: number; evaluations: number };
type FypLive = { training: FypRunSummary | null; evaluation: FypEvaluationSummary | null; busy: boolean };
type FypTicket = { accepted?: boolean; ticket: string; run_id?: string | null; action: string; status: string; result?: unknown; error?: string; note?: string };
type FypPage = 'home' | 'settings' | 'policy' | 'checkpoints' | 'checkpoint' | 'runs' | 'run' | 'evaluations' | 'evaluation' | 'environments' | 'environment';
type FypRoute = { page: FypPage; checkpointId: string | null; runId?: string | null; evaluationId?: string | null; environmentId?: string | null; returnPage?: 'runs' | 'run' | 'evaluations' | 'checkpoints' | 'checkpoint' | 'checkpoint-evaluations' | null };
type FypHistoryEntry = { path: string; page: FypPage; checkpointId: string | null; depth: number };
const FYP_HISTORY_KEY = '__atlasFypRoute';

function readFypRoute(): FypRoute {
    const [path, query = ''] = window.location.hash.split('?');
    const params = new URLSearchParams(query);
    const requested = params.get('fypPage');
    const legacyCheckpointEvaluations = requested === 'evaluations' && params.get('from') === 'checkpoint';
    const page: FypPage = legacyCheckpointEvaluations || requested === 'checkpoint' || (requested === 'checkpoints' && params.has('checkpoint')) ? 'checkpoint'
        : requested === 'environment' || (requested === 'environments' && params.has('environment')) ? 'environment'
        : ['settings', 'policy', 'checkpoints', 'runs', 'run', 'evaluations', 'evaluation', 'environments', 'environment'].includes(requested ?? '') ? requested as FypPage : 'home';
    const runId = page === 'run' || page === 'evaluations' || page === 'evaluation' ? params.get('run') : null;
    const checkpointId = page === 'checkpoint' ? params.get('checkpoint') ?? (legacyCheckpointEvaluations ? params.get('run') : null) : null;
    const evaluationId = page === 'evaluation' ? params.get('evaluation') : null;
    const environmentId = page === 'environments' || page === 'environment' ? params.get('environment') : null;
    const source = params.get('from');
    const returnPage = source === 'run' || source === 'evaluations' || source === 'runs' || source === 'checkpoints' || source === 'checkpoint' || source === 'checkpoint-evaluations' ? source : null;
    if (page === 'evaluation' && !evaluationId) return runId ? { page: 'evaluations', checkpointId: null, runId } : { page: 'runs', checkpointId: null };
    if (page === 'environment' && !environmentId) return { page: 'environments', checkpointId: null };
    if (page === 'checkpoint' && !checkpointId) return { page: 'checkpoints', checkpointId: null };
    return (page === 'run' || page === 'evaluations') && !runId
        ? { page: 'runs', checkpointId: null } : { page, checkpointId, runId, evaluationId, environmentId, returnPage };
}

function writeFypRoute(route: FypRoute, method: 'pushState' | 'replaceState', depth: number) {
    const [path, query = ''] = window.location.hash.split('?');
    const params = new URLSearchParams(query);
    try {
        const selectedPolicy = window.localStorage.getItem(SELECTED_POLICY_KEY);
        if (selectedPolicy) params.set('policy', selectedPolicy);
    } catch {}
    if (route.page === 'home') params.delete('fypPage');
    else params.set('fypPage', route.page);
    if (route.page === 'checkpoint' && route.checkpointId) params.set('checkpoint', route.checkpointId);
    else params.delete('checkpoint');
    if ((route.page === 'run' || route.page === 'evaluations' || route.page === 'evaluation') && route.runId) params.set('run', route.runId);
    else params.delete('run');
    if (route.page === 'evaluation' && route.evaluationId) params.set('evaluation', route.evaluationId);
    else params.delete('evaluation');
    if ((route.page === 'environments' || route.page === 'environment') && route.environmentId) params.set('environment', route.environmentId);
    else params.delete('environment');
    if ((route.page === 'evaluation' || route.page === 'run' || route.page === 'evaluations') && route.returnPage) params.set('from', route.returnPage);
    else params.delete('from');
    const search = params.toString();
    const hash = `${path}${search ? `?${search}` : ''}`;
    const previous = window.history.state;
    const base = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
    window.history[method]({ ...base, [FYP_HISTORY_KEY]: { path, page: route.page, checkpointId: route.checkpointId, depth } satisfies FypHistoryEntry }, '', `${window.location.pathname}${window.location.search}${hash}`);
}

function fypHistoryEntry(): FypHistoryEntry | undefined {
    const value = window.history.state?.[FYP_HISTORY_KEY] as FypHistoryEntry | undefined;
    return value?.path === window.location.hash.split('?')[0] && Number.isInteger(value.depth) ? value : undefined;
}

function readSelectedPolicy() {
    try {
        const query = window.location.hash.split('?')[1] ?? '';
        const fromUrl = new URLSearchParams(query).get('policy');
        if (fromUrl) {
            window.localStorage.setItem(SELECTED_POLICY_KEY, fromUrl);
            return fromUrl;
        }
        return window.localStorage.getItem(SELECTED_POLICY_KEY) || 'football-v1';
    } catch { return 'football-v1'; }
}

const ACTIVE_STATES = new Set(['accepted', 'pending', 'queued', 'dispatching', 'launching', 'starting', 'active', 'running', 'waiting_for_play', 'waiting_for_trainer_connection', 'stopping_after_requested_episodes', 'cancelling']);
const HEARTBEAT_MAX_AGE_SECONDS = 15;
const OPERATION_STORAGE_KEY = 'atlas.football.fyp.operation';
const SELECTED_POLICY_KEY = 'atlas.football.fyp.selected-policy';
const CHECKPOINT_REVIEW_KEY = 'atlas.football.fyp.checkpoint-reviews';
const isActive = (state?: string) => !!state && ACTIVE_STATES.has(state.toLowerCase());
const sceneName = (path?: string | null) => path?.split('/').pop()?.replace(/\.unity$/i, '') || 'FYP scene';
const runName = (preset: string, number?: number) => `${number ? `T${number} · ` : ''}${preset === 'smoke' ? 'Smoke run' : preset === 'pilot_50k' ? '50k pilot' : preset === 'custom' ? 'Custom-budget run' : preset}`;
const runDate = (value?: string) => value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'Date not recorded';
const runTime = (value?: string) => value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
const checkpointRecordedAt = (run: FypRunSummary) => run.finished_at ?? run.started_at;
const checkpointLabel = (run: FypRunSummary) => run.checkpoint_number ? `C${run.checkpoint_number}` : run.run_id;
const evaluationRecordedAt = (evaluation?: FypEvaluationSummary) => evaluation?.started_at ?? evaluation?.finished_at;

function readSavedTicket(): FypTicket | null {
    try {
        if (typeof window === 'undefined') return null;
        const value = JSON.parse(window.sessionStorage.getItem(OPERATION_STORAGE_KEY) || 'null') as Partial<FypTicket> | null;
        return value && typeof value.ticket === 'string' && typeof value.action === 'string' && typeof value.status === 'string'
            ? value as FypTicket : null;
    } catch { return null; }
}

function readCheckpointReviews(): Record<string, 'keep' | 'discard'> {
    try {
        const saved = window.localStorage.getItem(CHECKPOINT_REVIEW_KEY);
        const parsed = saved ? JSON.parse(saved) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, 'keep' | 'discard'] =>
            entry[1] === 'keep' || entry[1] === 'discard'));
    } catch { return {}; }
}

export function FypV1Experience() {
    const [route, setRoute] = useState<FypRoute>(readFypRoute);
    const { page, runId: routeRunId, checkpointId: selectedCheckpointId, evaluationId: selectedEvaluationId, returnPage } = route;
    const [selectedPolicyId, setSelectedPolicyId] = useState(readSelectedPolicy);
    const [evaluationSeed, setEvaluationSeed] = useState(515);
    const [evaluationEpisodes, setEvaluationEpisodes] = useState(10);
    const [evaluationTimeScale, setEvaluationTimeScale] = useState(1);
    const [evaluationEnvironmentId, setEvaluationEnvironmentId] = useState('');
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [ticket, setTicket] = useState<FypTicket | null>(readSavedTicket);
    const [environmentCount, setEnvironmentCount] = useState<number | null | undefined>(undefined);
    const [environmentName, setEnvironmentName] = useState<string | undefined>();
    const [checkpointReviews, setCheckpointReviews] = useState<Record<string, 'keep' | 'discard'>>(readCheckpointReviews);
    const [savingCheckpointNote, setSavingCheckpointNote] = useState(false);

    useEffect(() => {
        const requestedPage = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('fypPage');
        if (requestedPage === 'control-room' || !fypHistoryEntry()) {
            writeFypRoute(readFypRoute(), 'replaceState', fypHistoryEntry()?.depth ?? 0);
        }
        const syncRoute = () => {
            setRoute(readFypRoute());
            setSelectedPolicyId(readSelectedPolicy());
        };
        window.addEventListener('popstate', syncRoute);
        window.addEventListener('hashchange', syncRoute);
        return () => {
            window.removeEventListener('popstate', syncRoute);
            window.removeEventListener('hashchange', syncRoute);
        };
    }, []);

    useEffect(() => {
        if (page !== 'evaluations' || returnPage !== 'checkpoint' || !routeRunId) return;
        const next = { page: 'checkpoint' as const, checkpointId: routeRunId };
        writeFypRoute(next, 'replaceState', fypHistoryEntry()?.depth ?? 0);
        setRoute(next);
    }, [page, returnPage, routeRunId]);

    const navigate = (next: FypRoute) => {
        const depth = (fypHistoryEntry()?.depth ?? 0) + 1;
        writeFypRoute(next, 'pushState', depth);
        setRoute(next);
    };
    const openEnvironment = (environmentId: string) => navigate({ page: 'environments', checkpointId: null, environmentId });
    const openEvaluation = (evaluation: FypEvaluationSummary, source: 'runs' | 'checkpoint' | 'evaluations') =>
        navigate({ page: 'evaluation', checkpointId: null, evaluationId: evaluation.evaluation_id,
            runId: evaluation.training_run_id, returnPage: source });

    const selectPolicy = (policyId: string) => {
        setSelectedPolicyId(policyId);
        try { window.localStorage.setItem(SELECTED_POLICY_KEY, policyId); } catch {}
    };
    const followOperation = (policyId: string | undefined, next: FypRoute) => {
        if (policyId) selectPolicy(policyId);
        navigate(next);
    };

    const policiesRead = useFypRead<FypPolicy[]>('football_fyp_policies', {});
    const policies = policiesRead.data ?? [];
    const activePolicy = policies.find(policy => policy.policy_id === selectedPolicyId)
        ?? policies.find(policy => policy.policy_id === 'football-v1') ?? policies[0];
    const policyId = activePolicy?.policy_id ?? selectedPolicyId;
    useEffect(() => {
        if (!activePolicy || activePolicy.policy_id === selectedPolicyId) return;
        setSelectedPolicyId(activePolicy.policy_id);
        try { window.localStorage.setItem(SELECTED_POLICY_KEY, activePolicy.policy_id); } catch {}
        writeFypRoute(readFypRoute(), 'replaceState', fypHistoryEntry()?.depth ?? 0);
    }, [activePolicy, selectedPolicyId]);

    const policyInput = { policyId };
    const manifestRead = useFypRead<FypManifest>('football_fyp_manifest', activePolicy ? policyInput : null);
    const manifest = manifestRead.data;
    const needsEditorStatus = page === 'home' || page === 'checkpoint' || page === 'evaluations';
    const preflightRead = useFypRead<FypPreflight>('football_fyp_preflight', activePolicy && needsEditorStatus ? policyInput : null, 3000);
    const preflight = preflightRead.data;
    const live = useFypRead<FypLive>('football_fyp_live', {}, 3000);
    const overview = useFypRead<FypOverview>('football_fyp_overview',
        activePolicy && (page === 'home' || page === 'runs' || page === 'checkpoints') ? policyInput : null);
    const environments = useFypRead<FypEnvironment[]>('football_fyp_environments',
        page === 'policy' || page === 'checkpoint' || page === 'evaluations' ? {} : null);
    const activity = useFypPage<HistoryRow>('football_fyp_history',
        { ...policyInput, historyView: 'activity' }, !!activePolicy && page === 'runs');
    const checkpoints = useFypPage<FypRunSummary>('football_fyp_history',
        { ...policyInput, historyView: 'checkpoints' }, !!activePolicy && page === 'checkpoints');
    const activeRun = live.data?.training;
    const activeEvaluation = live.data?.evaluation;
    const evaluationLive = !!selectedEvaluationId && activeEvaluation?.evaluation_id === selectedEvaluationId;
    const evaluationDetail = useFypRead<FypEvaluation>('football_fyp_evaluation_detail',
        activePolicy && selectedEvaluationId ? { ...policyInput, evaluationId: selectedEvaluationId } : null,
        evaluationLive ? 3000 : undefined);
    const focusedEvaluation = evaluationDetail.data;
    const selectedRunId = page === 'evaluation' ? focusedEvaluation?.training_run_id : routeRunId;
    const detailRunId = page === 'checkpoint' ? selectedCheckpointId : selectedRunId;
    const evaluationHistory = useFypPage<HistoryRow>('football_fyp_history',
        { ...policyInput, historyView: 'evaluations', runId: detailRunId },
        !!activePolicy && !!detailRunId && (page === 'checkpoint' || page === 'evaluations'));
    const latestEvaluation = useFypRead<FypPageResult<FypEvaluationSummary>>('football_fyp_history',
        activePolicy && detailRunId && page === 'checkpoint'
            ? { ...policyInput, historyView: 'evaluations', runId: detailRunId, limit: 1 } : null);
    const latestFocusedEvaluation = latestEvaluation.data?.items[0];

    const runLive = !!detailRunId && activeRun?.run_id === detailRunId;
    const runDetail = useFypRead<FypRun>('football_fyp_run_detail',
        activePolicy && detailRunId ? { ...policyInput, runId: detailRunId } : null,
        page === 'run' && runLive ? 3000 : undefined);
    const [savedNotes, setSavedNotes] = useState<{ runId: string; notes: string }>();
    const focusedRun = runDetail.data && savedNotes?.runId === runDetail.data.run_id
        ? { ...runDetail.data, notes: savedNotes.notes } : runDetail.data;
    const evaluationEnvironments = (environments.data ?? []).filter(environment =>
        activePolicy?.curriculum?.some(stage => stage.environment_id === environment.environment_id && stage.status !== 'proposed'));
    useEffect(() => {
        const trainingEnvironmentId = focusedRun?.environment?.environment_id;
        if (trainingEnvironmentId) setEvaluationEnvironmentId(trainingEnvironmentId);
    }, [focusedRun?.run_id, focusedRun?.environment?.environment_id]);
    useEffect(() => {
        if (!evaluationEnvironmentId && !focusedRun?.environment?.environment_id && evaluationEnvironments.length)
            setEvaluationEnvironmentId(evaluationEnvironments[0].environment_id);
    }, [evaluationEnvironmentId, evaluationEnvironments, focusedRun?.environment?.environment_id]);
    const evaluationPreflightRead = useFypRead<FypPreflight>('football_fyp_preflight',
        activePolicy && evaluationEnvironmentId && (page === 'checkpoint' || page === 'evaluations')
            ? { ...policyInput, environmentId: evaluationEnvironmentId } : null, 3000);
    const evaluationPreflight = evaluationPreflightRead.data;
    const activeTicket = isActive(ticket?.status) ? ticket : null;
    const ticketRead = useFypRead<FypTicket>('football_fyp_task_status', activeTicket ? { runId: activeTicket.ticket } : null, 2500);
    useEffect(() => {
        if (!ticket) return;
        try {
            if (isActive(ticket.status)) window.sessionStorage.setItem(OPERATION_STORAGE_KEY, JSON.stringify(ticket));
            else window.sessionStorage.removeItem(OPERATION_STORAGE_KEY);
        } catch { /* The live page still inspects receipts if session storage is unavailable. */ }
    }, [ticket]);
    useEffect(() => {
        if (!ticketRead.data) return;
        const response = ticketRead.data;
        setTicket(response);
        if (!isActive(response.status)) {
            const operation = response.action === 'fyp_evaluate' ? 'Evaluation' : 'Training';
            setNotice(response.status === 'completed'
                ? `${operation} completed. See the recorded receipt in Recent Runs.`
                : `${operation} ended with state “${response.status}”. Review the receipt and Unity status.`);
        }
    }, [ticketRead.data]);
    const latestOperationId = activeRun?.run_id ?? activeEvaluation?.evaluation_id;
    const previousOperationId = useRef<string | undefined>(undefined);
    const refreshOverview = overview.refresh;
    const refreshActivity = activity.followingLatest ? activity.refresh : undefined;
    const refreshCheckpoints = checkpoints.followingLatest ? checkpoints.refresh : undefined;
    const refreshEvaluations = evaluationHistory.followingLatest ? evaluationHistory.refresh : undefined;
    const refreshLatestEvaluation = latestEvaluation.refresh;
    useEffect(() => {
        const previous = previousOperationId.current;
        previousOperationId.current = latestOperationId;
        if (previous === latestOperationId) return;
        refreshOverview();
        refreshActivity?.();
        refreshCheckpoints?.();
        refreshEvaluations?.();
        refreshLatestEvaluation();
    }, [latestOperationId, refreshOverview, refreshActivity, refreshCheckpoints, refreshEvaluations, refreshLatestEvaluation]);

    const requestedAction = activeTicket?.action ?? (activeRun ? 'fyp_train' : activeEvaluation ? 'fyp_evaluate' : null);
    const manifestScene = manifest?.contract.scene;
    const sceneMatches = manifest?.available === true && !!preflight?.scene_ready &&
        !!manifestScene && preflight?.active_scene === manifestScene;
    const heartbeatFresh = preflight?.heartbeat_age_seconds != null && preflight.heartbeat_age_seconds <= HEARTBEAT_MAX_AGE_SECONDS;
    const editorReady = !!manifest?.execution_supported && !!preflight?.policy_supported && !!preflight?.ready_to_train && !!preflight.editor_open && sceneMatches &&
        !preflight.editor_compiling && !!preflight.trainer_available && !preflight.editor_playing && heartbeatFresh;
    const operationActive = !!activeTicket || live.data?.busy === true || !!activeRun || !!activeEvaluation;
    const evaluationScene = evaluationEnvironments.find(environment => environment.environment_id === evaluationEnvironmentId);
    const evaluationHeartbeatFresh = evaluationPreflight?.heartbeat_age_seconds != null &&
        evaluationPreflight.heartbeat_age_seconds <= HEARTBEAT_MAX_AGE_SECONDS;
    const evaluationEditorReady = !!evaluationPreflight?.ready_to_train && !!evaluationPreflight.editor_open &&
        !evaluationPreflight.editor_playing && !evaluationPreflight.editor_compiling &&
        !!evaluationPreflight.trainer_available && evaluationHeartbeatFresh &&
        evaluationPreflight.active_scene === evaluationScene?.scene_path;
    const canEvaluate = !!manifest?.execution_supported && !!evaluationScene && evaluationEditorReady &&
        !operationActive && !busy && !!live.data && !live.error && !evaluationPreflightRead.error && !manifestRead.error;

    let readinessMessage = 'Checking Unity status…';
    let readinessTone = 'pending';
    if ((policiesRead.loading || preflightRead.loading) && !preflight) readinessMessage = 'Checking Unity status…';
    else if (!preflight || preflightRead.error) { readinessMessage = 'Unity status unavailable'; readinessTone = 'warning'; }
    else if (requestedAction) {
        readinessTone = 'active';
        if (preflight.trainer_connected && requestedAction === 'fyp_train') readinessMessage = 'Training in Unity';
        else if (preflight.trainer_connected && requestedAction === 'fyp_evaluate') readinessMessage = 'Evaluating checkpoint in Unity';
        else if (!preflight.editor_open) readinessMessage = `${requestedAction === 'fyp_evaluate' ? 'Evaluation' : 'Training'} requested · Unity closed`;
        else if (preflight.editor_playing) readinessMessage = 'Play Mode · waiting for trainer connection';
        else readinessMessage = `${requestedAction === 'fyp_evaluate' ? 'Evaluation' : 'Training'} requested · press Play`;
    } else if (operationActive) {
        readinessMessage = 'FYP Editor operation in progress';
        readinessTone = 'active';
    } else if (!manifest?.available) { readinessMessage = 'FYP policy record unavailable'; readinessTone = 'warning'; }
    else if (!manifest.execution_supported) { readinessMessage = 'Documentation only · no compatible trainer'; readinessTone = 'pending'; }
    else if (!preflight.editor_open) { readinessMessage = 'Unity closed · idle'; readinessTone = 'pending'; }
    else if (preflight.editor_playing && preflight.environment_present && preflight.agent_controlled) { readinessMessage = 'Agent control active · manual actions disabled'; readinessTone = 'active'; }
    else if (preflight.editor_playing && preflight.environment_present) { readinessMessage = 'Manual Play · keyboard controlled'; readinessTone = 'active'; }
    else if (!sceneMatches) { readinessMessage = `Open ${sceneName(manifest?.contract.scene)} in Unity`; readinessTone = 'warning'; }
    else if (preflight.editor_compiling) { readinessMessage = 'Wait for Unity compilation to finish'; readinessTone = 'warning'; }
    else if (!preflight.trainer_available) { readinessMessage = 'ML-Agents trainer is unavailable'; readinessTone = 'warning'; }
    else if (!heartbeatFresh) { readinessMessage = 'Waiting for a fresh Unity heartbeat'; readinessTone = 'warning'; }
    else if (preflight.editor_playing) { readinessMessage = 'Manual Play · no model attached'; readinessTone = 'active'; }
    else if (!preflight.ready_to_train) { readinessMessage = preflight.note || 'Atlas preflight has not approved this operation'; readinessTone = 'warning'; }
    else { readinessMessage = 'Unity open · idle · ready to run'; readinessTone = 'ready'; }

    const operationDescription = activeTicket
        ? preflight?.trainer_connected ? 'Unity is connected to the active Atlas operation.'
            : preflight?.editor_playing ? 'The editor is running. Atlas is waiting for the ML-Agents connection.'
                : 'In the FYP Unity Editor, press Play to connect the trainer.'
        : activeRun ? `${runName(activeRun.preset, activeRun.training_number)} · ${(activeRun.steps_completed ?? 0).toLocaleString()} / ${activeRun.steps.toLocaleString()} steps · seed ${activeRun.seed}`
            : activeEvaluation ? `${activeEvaluation.evaluation_number ? `E${activeEvaluation.evaluation_number} · ` : ''}Checkpoint evaluation · ${activeEvaluation.episodes_completed ?? 0}/${activeEvaluation.requested_episodes} episodes`
        : preflight?.editor_playing ? preflight.agent_controlled ? 'An inference agent is controlling the scene; manual movement and reset controls are disabled.' : 'The FYP scene is running without a requested Atlas operation. Keyboard controls remain active.'
                    : 'OpenGoalClose is the selected FYP scene. Unity is ready for an external learner or an Atlas evaluation.';
    const activeOperationName = activeRun ? 'Training run' : activeEvaluation ? 'Checkpoint evaluation'
        : activeTicket?.action === 'fyp_evaluate' ? 'Checkpoint evaluation'
            : activeTicket?.action === 'fyp_train' ? 'Training run' : operationActive ? 'Editor operation' : '';
    const activeOperationState = activeRun?.state ?? activeEvaluation?.state ?? activeTicket?.status ?? 'requested';
    const evaluateRun = async (runId: string, environmentId: string) => {
        setBusy(`evaluate:${runId}`); setError(''); setNotice('');
        try {
            const response = await callTool<FypTicket>('football_fyp_evaluate', { policyId, runId, environmentId, episodes: evaluationEpisodes, seed: evaluationSeed, timeScale: evaluationTimeScale });
            setTicket(response);
            setNotice('Evaluation request accepted. Home will show the operation status while Unity connects.');
            navigate({ page: 'home', checkpointId: null });
            live.refresh();
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setBusy(''); }
    };

    const updateCheckpointReview = (runId: string, value: 'keep' | 'discard' | null) => {
        const next = { ...checkpointReviews };
        if (value) next[runId] = value;
        else delete next[runId];
        try { window.localStorage.setItem(CHECKPOINT_REVIEW_KEY, JSON.stringify(next)); }
        catch { setError('Checkpoint review could not be saved in this browser.'); return; }
        setCheckpointReviews(next);
    };

    const saveCheckpointNote = async (runId: string, notes: string): Promise<boolean> => {
        setSavingCheckpointNote(true); setError(''); setNotice('');
        try {
            const result = await callTool<{ run_id: string; notes: string }>('football_fyp_checkpoint_note', { policyId, runId, notes });
            setSavedNotes({ runId, notes: result.notes });
            setNotice('Checkpoint notes saved.');
            return true;
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
        finally { setSavingCheckpointNote(false); }
    };

    const refreshNow = () => {
        policiesRead.refresh();
        manifestRead.refresh();
        preflightRead.refresh();
        live.refresh();
        overview.refresh();
    };
    const countText = (count: number | undefined, label: string) =>
        count == null ? (overview.error ? 'Counts unavailable' : 'Loading counts…')
            : `${count} ${label}${count === 1 ? '' : 's'}`;
    const evaluationBlocker = operationActive ? `${activeOperationName} is using the Unity Editor slot.`
        : live.error || live.loading ? 'Waiting for the shared Editor operation status.'
            : !evaluationEnvironmentId ? 'Select an evaluation environment.'
                : evaluationPreflightRead.error ? 'Could not read evaluation environment readiness.'
                    : !evaluationPreflight?.editor_open ? 'Open the FYP Unity Editor.'
                        : evaluationPreflight.editor_playing ? 'Stop Play Mode before requesting evaluation.'
                            : !evaluationScene || evaluationPreflight.active_scene !== evaluationScene.scene_path
                                ? `Open ${evaluationScene?.name ?? 'the selected environment'} in Unity.`
                                    : evaluationPreflight.editor_compiling ? 'Wait for Unity compilation to finish.'
                                        : !evaluationPreflight.trainer_available ? 'ML-Agents trainer is unavailable.'
                                            : !evaluationPreflight.ready_to_train ? evaluationPreflight.note || 'Evaluation environment is not ready.'
                                                : !evaluationHeartbeatFresh ? 'Waiting for a fresh Unity heartbeat.' : readinessMessage;
    const trainingBreadcrumb = focusedRun ? focusedRun.training_number ? `T${focusedRun.training_number}` : focusedRun.run_id : 'Training run';
    const evaluationBreadcrumb = focusedEvaluation ? focusedEvaluation.evaluation_number ? `E${focusedEvaluation.evaluation_number}` : focusedEvaluation.evaluation_id : 'Evaluation';
    const pageTitle = page === 'home' ? 'Home' : page === 'settings' ? 'Settings' : page === 'policy' ? 'Policy plan' : page === 'checkpoints' ? 'Policy Checkpoints' : page === 'checkpoint' ? 'Checkpoint'
            : page === 'run' ? trainingBreadcrumb : page === 'evaluations' ? 'Evaluations'
            : page === 'evaluation' ? evaluationBreadcrumb
                : page === 'runs' ? 'Recent Runs'
                    : page === 'environment' ? environmentName ?? 'Environment details' : 'Environments';
    const checkpointBreadcrumb = focusedRun ? checkpointLabel(focusedRun) : 'Checkpoint';
    const breadcrumbTitle = pageTitle;

    return <div className="fg-stack fyp-experience" aria-label="FYP Football editor-first training">
        {error && <p className="fg-error" role="alert">{error}</p>}
        {notice && <p className="fg-notice" role="status">{notice}</p>}
        {policiesRead.error && <FypReadMessage label="Policies" read={policiesRead} />}
        {ticketRead.error && <FypReadMessage label="Operation status" read={ticketRead} />}

        <header className="fyp-page-heading">
            {page !== 'home' && <nav className="fyp-breadcrumbs" aria-label="Breadcrumb">
                <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'home', checkpointId: null })}>Home</button>
                {page === 'run' && (returnPage === 'checkpoints' || returnPage === 'checkpoint') && <>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'checkpoints', checkpointId: null })}>Policy Checkpoints</button>
                    {returnPage === 'checkpoint' && <>
                        <span aria-hidden="true">/</span>
                        <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'checkpoint', checkpointId: selectedRunId ?? null })}>
                            {checkpointBreadcrumb}
                        </button>
                    </>}
                </>}
                {page === 'run' && returnPage !== 'checkpoints' && returnPage !== 'checkpoint' && <>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'runs', checkpointId: null })}>Recent Runs</button>
                </>}
                {page === 'checkpoint' && <>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'checkpoints', checkpointId: null })}>Policy Checkpoints</button>
                </>}
                {page === 'environment' && <>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'environments', checkpointId: null })}>Environments</button>
                </>}
                {page === 'evaluations' && <>
                    <span aria-hidden="true">/</span>
                    {returnPage === 'checkpoint' ? <>
                        <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'checkpoints', checkpointId: null })}>Policy Checkpoints</button>
                        <span aria-hidden="true">/</span>
                        <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'checkpoint', checkpointId: selectedRunId ?? null })}>{checkpointBreadcrumb}</button>
                    </> : <>
                        <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'checkpoints', checkpointId: null })}>Policy Checkpoints</button>
                        <span aria-hidden="true">/</span>
                        <span>{checkpointBreadcrumb}</span>
                    </>}
                </>}
                {page === 'evaluation' && returnPage === 'runs' && <>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'runs', checkpointId: null })}>Recent Runs</button>
                </>}
                {page === 'evaluation' && returnPage === 'checkpoint' && <>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'checkpoints', checkpointId: null })}>Policy Checkpoints</button>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'checkpoint', checkpointId: selectedRunId ?? null })}>{checkpointBreadcrumb}</button>
                </>}
                {page === 'evaluation' && returnPage === 'run' && <>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'runs', checkpointId: null })}>Recent Runs</button>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'run', runId: selectedRunId, checkpointId: null })}>{trainingBreadcrumb}</button>
                </>}
                {page === 'evaluation' && returnPage === 'evaluations' && <>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'checkpoints', checkpointId: null })}>Policy Checkpoints</button>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'evaluations', runId: selectedRunId, checkpointId: null })}>{checkpointBreadcrumb}</button>
                    <span aria-hidden="true">/</span>
                    <span>Evaluations</span>
                </>}
                {page === 'evaluation' && returnPage === 'checkpoint-evaluations' && <>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'checkpoints', checkpointId: null })}>Policy Checkpoints</button>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'checkpoint', checkpointId: selectedRunId ?? null })}>{checkpointBreadcrumb}</button>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'evaluations', runId: selectedRunId, checkpointId: null, returnPage: 'checkpoint' })}>Evaluations</button>
                </>}
                {page === 'evaluation' && returnPage === 'checkpoints' && <>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'checkpoints', checkpointId: null })}>Policy Checkpoints</button>
                    <span aria-hidden="true">/</span>
                    <button className="fyp-breadcrumb-link" type="button" onClick={() => navigate({ page: 'evaluations', runId: selectedRunId, checkpointId: null })}>{checkpointBreadcrumb}</button>
                    <span aria-hidden="true">/</span>
                    <span>Evaluations</span>
                </>}
                <span aria-hidden="true">/</span>
                <span aria-current="page">{page === 'checkpoint' && focusedRun ? checkpointLabel(focusedRun) : breadcrumbTitle}</span>
            </nav>}
            <div className="fyp-page-title-row">
                {page === 'run' && focusedRun ? <h1 className="fyp-record-page-headline">
                    {focusedRun.training_number && <span className="fyp-index-pill fyp-training-pill">T{focusedRun.training_number}</span>}
                    <span>{runName(focusedRun.preset)}</span>
                </h1> : page === 'evaluation' && focusedEvaluation ? <h1 className="fyp-record-page-headline">
                    {focusedEvaluation.evaluation_number && <span className="fyp-index-pill fyp-evaluation-pill">E{focusedEvaluation.evaluation_number}</span>}
                    <span>Evaluation</span>
                </h1> : page === 'checkpoint' && focusedRun ? <>
                    <h1 className="fyp-checkpoint-page-headline">
                        <span className="fyp-checkpoint-number fyp-checkpoint-headline-pill">{checkpointLabel(focusedRun)}</span>
                        {latestFocusedEvaluation ? <>
                            <span className="fyp-checkpoint-headline-date">{runDate(evaluationRecordedAt(latestFocusedEvaluation))}</span>
                            {runTime(evaluationRecordedAt(latestFocusedEvaluation)) && <time className="fyp-checkpoint-headline-time" dateTime={evaluationRecordedAt(latestFocusedEvaluation)}>{runTime(evaluationRecordedAt(latestFocusedEvaluation))}</time>}
                        </> : <span className="fyp-checkpoint-headline-date">{latestEvaluation.error ? 'Latest evaluation unavailable'
                            : latestEvaluation.loading ? 'Loading latest evaluation…' : 'No evaluation recorded yet'}</span>}
                    </h1>
                </> : <h1>{pageTitle}</h1>}
                {page === 'checkpoints' && <p className="fyp-checkpoint-count">{countText(overview.data?.checkpoints, 'checkpoint')}</p>}
                {page === 'runs' && <p className="fyp-checkpoint-count">{countText(overview.data?.runs, 'training run')}</p>}
                {page === 'runs' && <button className="fg-button fyp-history-refresh" type="button"
                    onClick={() => { activity.restart(); overview.refresh(); }}>Refresh history</button>}
                {page === 'checkpoints' && <button className="fg-button fyp-history-refresh" type="button"
                    onClick={() => { checkpoints.restart(); overview.refresh(); }}>Refresh checkpoints</button>}
                {page === 'environments' && <p className="fyp-checkpoint-count">{environmentCount === undefined ? 'Loading…' : environmentCount === null ? 'Unavailable' : `${environmentCount} environment${environmentCount === 1 ? '' : 's'}`}</p>}
                {page === 'home' && <button className="fyp-settings-link" type="button" onClick={() => navigate({ page: 'settings', checkpointId: null })} aria-label="Open settings">Settings</button>}
            </div>
        </header>

        {operationActive && page !== 'home' &&
            <button className="fyp-operation-banner" type="button" onClick={() => navigate({ page: 'home', checkpointId: null })}>
                <span className="fyp-operation-indicator" aria-hidden="true" />
                <span><strong>{activeOperationName}</strong> · {activeOperationState}</span>
                <span>View on Home →</span>
            </button>}

        {page === 'home' && <section className={`fg-panel fyp-readiness fyp-${readinessTone}`} aria-labelledby="fyp-readiness-title">
            <div className="fyp-readiness-header">
                <div>
                    <h2 id="fyp-readiness-title">{readinessMessage}</h2>
                </div>
                <div className="fg-actions">
                    <button className="fg-button" type="button" onClick={refreshNow}>
                        Refresh status
                    </button>
                </div>
            </div>
            {preflightRead.error && <FypReadMessage label="Unity status" read={preflightRead} />}
            {live.error && <FypReadMessage label="Active operation" read={live} />}
            {manifestRead.error && <FypReadMessage label="Policy details" read={manifestRead} />}
            <p className="fyp-status-context">{!preflight ? 'Reading the FYP Editor connection.' : preflight.editor_open
                ? `${sceneMatches ? sceneName(preflight.active_scene) : preflight.active_scene ? 'Wrong Unity scene' : 'Scene not loaded'} · ${preflight.editor_playing ? 'Play Mode' : 'Edit Mode'}${preflight.trainer_connected ? ' · trainer connected' : ''}`
                : preflight.editor_available ? 'FYP Editor is installed but closed.' : 'FYP Editor is unavailable.'}</p>
            {operationActive && <div className="fyp-live-summary" role="status">
                <strong>{activeOperationName} · {activeOperationState}</strong>
                <span>{operationDescription}</span>
            </div>}
        </section>}

        {page === 'home' && activeRun && <button className="fyp-active-run-card" type="button"
            onClick={() => followOperation(activeRun.policy_id, { page: 'run', checkpointId: null, runId: activeRun.run_id, returnPage: 'runs' })}>
            <span className="fyp-operation-indicator" aria-hidden="true" />
            <span className="fyp-active-run-content">
                <strong>Training run · {activeRun.state}</strong>
                <span>{activeRun.steps_completed?.toLocaleString() ?? 0} / {activeRun.steps.toLocaleString()} steps · {activeRun.episodes_completed ?? 0} episodes · seed {activeRun.seed}</span>
            </span>
            <span aria-hidden="true">Follow run →</span>
        </button>}
        {page === 'home' && !activeRun && activeEvaluation && <button className="fyp-active-run-card" type="button"
            onClick={() => followOperation(activeEvaluation.policy_id, { page: 'evaluation', checkpointId: null, runId: activeEvaluation.training_run_id,
                evaluationId: activeEvaluation.evaluation_id, returnPage: 'runs' })}>
            <span className="fyp-operation-indicator" aria-hidden="true" />
            <span className="fyp-active-run-content">
                <strong>Checkpoint evaluation · {activeEvaluation.state}</strong>
                <span>{activeEvaluation.episodes_completed ?? 0} / {activeEvaluation.requested_episodes} episodes · {activeEvaluation.goals_scored ?? 0} goals · seed {activeEvaluation.seed ?? '—'}</span>
            </span>
            <span aria-hidden="true">Follow evaluation →</span>
        </button>}

        {page === 'home' && <section className="fyp-home-grid" aria-label="FYP sections">
            <button className="fyp-home-card" type="button" onClick={() => navigate({ page: 'policy', checkpointId: null })}>
                <span className="fyp-home-card-heading"><strong>Policy plan</strong><span aria-hidden="true">→</span></span>
                <span>{activePolicy?.display_name ?? 'Selected policy'} · revision {activePolicy?.revision ?? '—'}</span>
            </button>
            <button className="fyp-home-card" type="button" onClick={() => navigate({ page: 'checkpoints', checkpointId: null })}>
                <span className="fyp-home-card-heading"><strong>Policy Checkpoints</strong><span aria-hidden="true">→</span></span>
                <span>{overview.data ? `${overview.data.checkpoints} available` : countText(undefined, 'checkpoint')}</span>
            </button>
            <button className="fyp-home-card" type="button" onClick={() => navigate({ page: 'runs', checkpointId: null })}>
                <span className="fyp-home-card-heading"><strong>Recent Runs</strong><span aria-hidden="true">→</span></span>
                <span>{overview.data ? `${countText(overview.data.runs, 'training run')} · ${countText(overview.data.evaluations, 'evaluation')}` : countText(undefined, 'run')}</span>
            </button>
            <button className="fyp-home-card" type="button" onClick={() => navigate({ page: 'environments', checkpointId: null })}>
                <span className="fyp-home-card-heading"><strong>Environments</strong><span aria-hidden="true">→</span></span>
                <span>Browse Unity scenes, settings, and modifiers</span>
            </button>
        </section>}

        {page === 'settings' && <section className="fg-panel fyp-settings-panel" aria-labelledby="fyp-settings-policy-title">
            <div>
                <h2 id="fyp-settings-policy-title">Current policy</h2>
            </div>
            <div className="fyp-settings-policy-field">
                <select id="fyp-policy-selection" aria-label="Selected FYP policy" value={policyId}
                    onChange={event => {
                        const nextId = event.target.value;
                        selectPolicy(nextId);
                        const nextRoute = { page: 'settings' as const, checkpointId: null };
                        writeFypRoute(nextRoute, 'replaceState', fypHistoryEntry()?.depth ?? 0);
                    }}>
                    {policies.map(policy => <option key={policy.policy_id} value={policy.policy_id}>{policy.display_name} · {policy.status}</option>)}
                </select>
            </div>
            {activePolicy && <p className="fyp-settings-policy-summary">{activePolicy.purpose}</p>}
            <button type="button" className="fg-link fyp-settings-plan-link" onClick={() => navigate({ page: 'policy', checkpointId: null })}>View policy plan →</button>
        </section>}

        {page === 'policy' && <FypPolicyPage policy={activePolicy} environments={environments.data ?? []} />}

        {page === 'checkpoints' && <section className="fyp-checkpoint-page" aria-label="Policy checkpoints">
            <FypReadMessage label="Checkpoints" read={checkpoints} />
            {checkpoints.data && !checkpoints.items.length && <p className="fg-muted">Runs with an exported checkpoint will appear here.</p>}
            <div className="fyp-checkpoint-grid" aria-busy={checkpoints.loading}>{checkpoints.items.map(run => {
                    const review = checkpointReviews[run.run_id];
                    const checkpointDate = checkpointRecordedAt(run);
                    const reviewLabel = review === 'keep' ? 'Kept' : review === 'discard' ? 'Discarded' : 'Unreviewed';
                    return <button className="fyp-checkpoint-card" key={run.run_id} type="button"
                        aria-label={`Open checkpoint ${run.checkpoint_number ? `C${run.checkpoint_number}` : ''}, ${runName(run.preset, run.training_number)}`}
                        onClick={() => navigate({ page: 'checkpoint', checkpointId: run.run_id })}>
                        <div className="fyp-checkpoint-card-header">
                            <div className="fyp-checkpoint-card-title-row">
                                <span className="fyp-checkpoint-number">{checkpointLabel(run)}</span>
                                <div className="fyp-checkpoint-datetime">
                                    <time className="fyp-checkpoint-date" dateTime={checkpointDate}>{runDate(checkpointDate)}</time>
                                    {runTime(checkpointDate) && <time className="fyp-checkpoint-time" dateTime={checkpointDate}>{runTime(checkpointDate)}</time>}
                                </div>
                            </div>
                            <span className={`fyp-review-tag fyp-review-${review ?? 'unreviewed'}`}>{reviewLabel}</span>
                        </div>
                        <span className={`fyp-checkpoint-card-notes${run.notes?.trim() ? '' : ' fyp-checkpoint-card-notes-empty'}`}>
                            {run.notes?.trim() ? run.notes : 'No notes yet'}
                        </span>
                        <span className="fyp-checkpoint-card-arrow" aria-hidden="true">→</span>
                    </button>;
                })}</div>
            <FypPagination label="Checkpoints pagination" page={checkpoints} />
        </section>}

        {page === 'checkpoint' && focusedRun && <>
            <CheckpointNotesEditor key={focusedRun.run_id} run={focusedRun} saving={savingCheckpointNote}
                onSave={notes => saveCheckpointNote(focusedRun.run_id, notes)} />
            <section className="fg-panel fyp-checkpoint-status-panel" aria-label="Checkpoint status">
                <fieldset className="fyp-checkpoint-status" aria-label={`Checkpoint status for ${runName(focusedRun.preset, focusedRun.training_number)}`}>
                    <legend>Checkpoint status</legend>
                    {(['', 'keep', 'discard'] as const).map(value => <label key={value || 'unreviewed'}>
                        <input type="radio" name={`checkpoint-status-${focusedRun.run_id}`} value={value} checked={(checkpointReviews[focusedRun.run_id] ?? '') === value}
                            onChange={() => updateCheckpointReview(focusedRun.run_id, value || null)} />
                        <span>{value ? value === 'keep' ? 'Keep' : 'Discard' : 'Unreviewed'}</span>
                    </label>)}
                </fieldset>
            </section>
            <section className="fyp-checkpoint-run-summary" aria-labelledby="fyp-checkpoint-training-title">
                <h2 id="fyp-checkpoint-training-title" className="fyp-checkpoint-section-title">Training run</h2>
                <TrainingEvidenceCard run={focusedRun}
                    onOpen={() => navigate({ page: 'run', checkpointId: null, runId: focusedRun.run_id, returnPage: 'checkpoint' })} />
            </section>
            <FypV1Evidence policyId={policyId} mode="evaluations" history={evaluationHistory} onRefreshHistory={latestEvaluation.refresh}
                onOpenEvaluation={evaluation => openEvaluation(evaluation, 'checkpoint')}
                onOpenEnvironment={openEnvironment}
                evaluationControls={{ episodes: evaluationEpisodes, seed: evaluationSeed,
                    environments: evaluationEnvironments, environmentId: evaluationEnvironmentId,
                    onEnvironmentChange: setEvaluationEnvironmentId,
                    onEpisodesChange: value => setEvaluationEpisodes(Math.max(1, Math.min(100, Math.floor(value || 1)))),
                    onSeedChange: value => setEvaluationSeed(Math.max(0, Math.min(2147483647, Math.floor(value || 0)))),
                    canStart: canEvaluate, starting: busy === `evaluate:${focusedRun.run_id}`,
                    blocker: evaluationBlocker,
                    timeScale: evaluationTimeScale, onTimeScaleChange: setEvaluationTimeScale,
                    operationActive, onViewHome: () => navigate({ page: 'home', checkpointId: null }),
                    onStart: () => void evaluateRun(focusedRun.run_id, evaluationEnvironmentId) }} />
        </>}

        {page === 'runs' && <>
            <FypV1Evidence policyId={policyId} mode="activity" history={activity}
                onOpenRun={runId => navigate({ page: 'run', checkpointId: null, runId, returnPage: 'runs' })}
                onOpenEvaluation={evaluation => openEvaluation(evaluation, 'runs')} />
        </>}

        {(page === 'checkpoint' || page === 'run' || page === 'evaluations') &&
            <FypReadMessage label="Training receipt" read={runDetail} />}
        {page === 'run' && focusedRun && <FypV1Evidence policyId={policyId} mode="run" run={focusedRun}
            live={runLive} onOpenEnvironment={openEnvironment}
            onOpenCheckpoint={runId => navigate({ page: 'checkpoint', checkpointId: runId })} />}
        {page === 'evaluations' && focusedRun && <FypV1Evidence policyId={policyId} mode="evaluations" history={evaluationHistory}
            onOpenEvaluation={evaluation => openEvaluation(evaluation, 'evaluations')}
            evaluationControls={{ episodes: evaluationEpisodes, seed: evaluationSeed,
                environments: evaluationEnvironments, environmentId: evaluationEnvironmentId,
                onEnvironmentChange: setEvaluationEnvironmentId,
                onEpisodesChange: value => setEvaluationEpisodes(Math.max(1, Math.min(100, Math.floor(value || 1)))),
                onSeedChange: value => setEvaluationSeed(Math.max(0, Math.min(2147483647, Math.floor(value || 0)))),
                canStart: canEvaluate, starting: busy === `evaluate:${selectedRunId}`, blocker: evaluationBlocker,
                timeScale: evaluationTimeScale, onTimeScaleChange: setEvaluationTimeScale,
                operationActive, onViewHome: () => navigate({ page: 'home', checkpointId: null }),
                onStart: () => selectedRunId && void evaluateRun(selectedRunId, evaluationEnvironmentId) }} />}
        {page === 'evaluation' && <>
            <FypReadMessage label="Evaluation receipt" read={evaluationDetail} />
            {focusedEvaluation && runDetail.error && <FypReadMessage label="Linked training receipt" read={runDetail} />}
            {focusedEvaluation && <FypV1Evidence policyId={policyId} mode="evaluation" run={focusedRun}
                evaluation={focusedEvaluation} live={evaluationLive} onOpenEnvironment={openEnvironment}
                onOpenCheckpoint={runId => navigate({ page: 'checkpoint', checkpointId: runId })} />}
        </>}

        {(page === 'environments' || page === 'environment') && <FypEnvironmentCatalog initialEnvironmentId={route.environmentId ?? undefined}
            onSelectEnvironment={environmentId => navigate({ page: environmentId ? 'environment' : 'environments', checkpointId: null, environmentId })}
            onEnvironmentCount={setEnvironmentCount} onEnvironmentName={setEnvironmentName} />}
    </div>;
}

function CheckpointNotesEditor({ run, saving, onSave }: { run: FypRun; saving: boolean; onSave: (notes: string) => Promise<boolean> }) {
    const [draft, setDraft] = useState(run.notes ?? '');
    const [editing, setEditing] = useState(false);
    useEffect(() => setDraft(run.notes ?? ''), [run.run_id, run.notes]);
    const saved = run.notes ?? '';
    const save = async () => {
        const result = await onSave(draft);
        if (result) setEditing(false);
    };
    return <div className="fyp-checkpoint-notes" aria-label="Checkpoint notes">
        {editing ? <>
            <textarea id={`checkpoint-notes-${run.run_id}`} autoFocus value={draft} maxLength={20_000}
                aria-label="Checkpoint notes" placeholder="Add notes about this checkpoint…"
                onChange={event => setDraft(event.target.value)} />
            <div className="fyp-checkpoint-notes-footer">
                <span>{draft.length.toLocaleString()} / 20,000 characters</span>
                <div className="fyp-checkpoint-notes-actions">
                    <button className="fg-button" type="button" disabled={saving}
                        onClick={() => { setDraft(saved); setEditing(false); }}>Cancel</button>
                    <button className="fg-button primary" type="button" disabled={saving || draft === saved} onClick={() => void save()}>
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
        </> : <div className="fyp-checkpoint-notes-view">
            <p className={saved.trim() ? '' : 'fyp-checkpoint-notes-empty'}>{saved || 'No notes yet.'}</p>
            <button className="fyp-checkpoint-notes-edit" type="button" aria-label="Edit notes"
                title="Edit notes" onClick={() => setEditing(true)}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.7 3.3a1.6 1.6 0 0 1 2.3 2.3L7 14.6l-3.1.8.8-3.1 9-9Z"/><path d="m12.5 4.5 3 3"/></svg>
            </button>
        </div>}
    </div>;
}
