import { FypEnvironmentCard, type FypEnvironment } from './FypEnvironmentCatalog';

export type FypPolicy = {
    policy_id: string;
    display_name: string;
    status: 'draft' | 'supported' | 'archived';
    revision: number;
    purpose: string;
    execution_supported?: boolean;
    contract: {
        contract_id: string;
        behavior_name: string;
        observations: { size: number; stacked_vectors: number; reference_frame: string; entity_capacity?: Record<string, unknown>; channels: { name: string; start: number; size: number; components: string[]; encoding: string; frame?: string; scale_divisor?: number; missing_value?: unknown; details?: Record<string, unknown> }[] };
        actions: { continuous_count: number; discrete_branches: number[]; channels: { name: string; index: number; range: number[]; meaning: string }[] };
    };
    actor: { sharing: string; memory: string; decision_period_physics_steps: number; network: Record<string, unknown> };
    trainer: { algorithm: string; config_path: string; python_package_version: string; settings: Record<string, unknown> };
    runtime: { unity_version: string; ml_agents_unity_version: string; player_build_required: boolean; build_requirements?: string[] };
    artifacts: { model_format: string; model_filename: string; behavior_name: string; checkpoint_format: string; notes?: string };
    curriculum: { stage: number; environment_id: string; environment_version: string; definition_sha256?: string; scene_path: string; purpose: string; sampling?: Record<string, unknown> }[];
    notes?: string;
};

export function FypPolicyPage({ policy, environments = [] }: { policy?: FypPolicy; environments?: FypEnvironment[] }) {
    if (!policy) return <section className="fyp-policy-page" aria-label="Policy plan">
        <p className="fg-muted">Policy documentation is unavailable.</p>
    </section>;
    const hasFullPlan = Array.isArray(policy.contract?.observations?.channels) &&
        Array.isArray(policy.contract?.actions?.channels) && !!policy.actor?.network &&
        !!policy.trainer?.settings && !!policy.runtime && !!policy.artifacts && Array.isArray(policy.curriculum);
    if (!hasFullPlan) return <section className="fyp-policy-page" aria-label={`${policy.display_name} policy plan`}>
        <section className="fyp-policy-summary">
            <div className="fyp-policy-summary-head">
                <h2>{policy.display_name}</h2>
                <span className={`fyp-policy-status fyp-policy-status-${policy.status}`}>{policy.status}</span>
            </div>
            <p>Only the existing contract summary is available from this legacy checkout. Detailed observation channels, training settings, and curriculum data are not recorded.</p>
            <div className="fyp-record-grid">
                <Record label="Policy ID" value={policy.policy_id} />
                <Record label="Policy contract" value={policy.contract?.contract_id} />
                <Record label="Behavior name" value={policy.contract?.behavior_name} />
                <Record label="Vector observations" value={policy.contract?.observations?.size} />
                <Record label="Continuous actions" value={policy.contract?.actions?.continuous_count} />
            </div>
        </section>
    </section>;
    const observations = policy.contract.observations;
    const actions = policy.contract.actions;
    return <section className="fyp-policy-page" aria-label={`${policy.display_name} policy plan`}>
        <section className="fyp-policy-summary">
            <div className="fyp-policy-summary-head">
                <div><h2>{policy.display_name}</h2></div>
                <span className={`fyp-policy-status fyp-policy-status-${policy.status}`}>{policy.status}</span>
            </div>
            <p className="fyp-policy-context">{policy.purpose}</p>
            {!policy.execution_supported && <p className="fyp-policy-documentation-note">Documentation only · no compatible trainer is registered for this policy.</p>}
            <div className="fyp-record-grid">
                <Record label="Policy ID" value={policy.policy_id} />
                <Record label="Policy contract" value={policy.contract.contract_id} />
                <Record label="Behavior name" value={policy.contract.behavior_name} />
                <Record label="Actor sharing" value={policy.actor.sharing} />
                <Record label="Actor memory" value={policy.actor.memory} />
                <Record label="Decision cadence" value={`${policy.actor.decision_period_physics_steps} physics steps`} />
            </div>
            {policy.notes && <p className="fyp-policy-notes">{policy.notes}</p>}
        </section>

        <section className="fyp-policy-section">
            <div className="fg-panel-title"><h2>Observations</h2><span>{observations.size} vector values · {observations.stacked_vectors} stack</span></div>
            <p className="fyp-policy-context">Reference frame: {observations.reference_frame}</p>
            {observations.entity_capacity && <div className="fyp-record-grid fyp-policy-capacity">
                {Object.entries(observations.entity_capacity).map(([key, value]) => <Record key={key} label={humanize(key)} value={value} />)}
            </div>}
            <div className="fyp-policy-table" role="table" aria-label="Observation channels">
                <div role="row" className="fyp-policy-table-head"><span>Indices</span><span>Channel</span><span>Components</span><span>Encoding</span></div>
                {observations.channels.map(channel => <div role="row" key={channel.name}>
                    <span>{channel.start}–{channel.start + channel.size - 1}</span>
                    <strong>{humanize(channel.name)}</strong>
                    <span>{channel.components.join(', ')}</span>
                    <span>{channel.encoding}{channel.frame ? ` · ${channel.frame}` : ''}{channel.scale_divisor ? ` · ÷${channel.scale_divisor}` : ''}
                        {channel.missing_value !== undefined ? ` · missing value: ${JSON.stringify(channel.missing_value)}` : ''}
                        {channel.details ? ` · ${Object.entries(channel.details).map(([key, value]) => `${humanize(key)}: ${String(value)}`).join(' · ')}` : ''}</span>
                </div>)}
            </div>
        </section>

        <section className="fyp-policy-section">
            <div className="fg-panel-title"><h2>Actions</h2><span>{actions.continuous_count} continuous · {actions.discrete_branches.length} discrete branches</span></div>
            <div className="fyp-policy-table fyp-policy-actions" role="table" aria-label="Action channels">
                <div role="row" className="fyp-policy-table-head"><span>Index</span><span>Channel</span><span>Range</span><span>Meaning</span></div>
                {actions.channels.map(channel => <div role="row" key={channel.name}>
                    <span>{channel.index}</span><strong>{humanize(channel.name)}</strong><span>{channel.range.join(' to ')}</span><span>{channel.meaning}</span>
                </div>)}
            </div>
        </section>

        <section className="fyp-policy-section">
            <div className="fg-panel-title"><h2>Model and training</h2><span>{policy.trainer.algorithm.toUpperCase()}</span></div>
            <div className="fyp-record-grid">
                <Record label="Network normalization" value={policy.actor.network.normalize} />
                <Record label="Hidden units" value={policy.actor.network.hidden_units} />
                <Record label="Network layers" value={policy.actor.network.layers} />
                <Record label="Trainer config" value={policy.trainer.config_path} />
                <Record label="ML-Agents Python" value={policy.trainer.python_package_version} />
                {Object.entries(policy.trainer.settings).map(([key, value]) => <Record key={key} label={humanize(key)} value={value} />)}
            </div>
            <h3>Runtime requirements</h3>
            <div className="fyp-record-grid">
                <Record label="Unity" value={policy.runtime.unity_version} />
                <Record label="ML-Agents Unity" value={policy.runtime.ml_agents_unity_version} />
                <Record label="Player build required" value={policy.runtime.player_build_required} />
                {policy.runtime.build_requirements?.map((item, index) => <Record key={`${item}-${index}`} label={`Build requirement ${index + 1}`} value={item} />)}
            </div>
            <h3>Artifacts</h3>
            <div className="fyp-record-grid">
                <Record label="Model format" value={policy.artifacts.model_format} />
                <Record label="Model filename" value={policy.artifacts.model_filename} />
                <Record label="Behavior name" value={policy.artifacts.behavior_name} />
                <Record label="Trainer checkpoint" value={policy.artifacts.checkpoint_format} />
            </div>
            {policy.artifacts.notes && <p className="fyp-policy-notes">{policy.artifacts.notes}</p>}
        </section>

        <section className="fyp-policy-section">
            <div className="fg-panel-title"><h2>Environment curriculum</h2><span>{policy.curriculum.length} stage{policy.curriculum.length === 1 ? '' : 's'}</span></div>
            {!policy.curriculum.length ? <p className="fg-muted">No environment stages are defined yet.</p> : <div className="fyp-curriculum-list">
                {policy.curriculum.map(stage => {
                    const current = environments.find(item => item.environment_id === stage.environment_id);
                    const matches = !!current && !!stage.definition_sha256 &&
                        current.version === stage.environment_version && current.definition_sha256 === stage.definition_sha256;
                    const stageEnvironment: FypEnvironment = {
                        environment_id: stage.environment_id,
                        name: current?.name ?? stage.environment_id,
                        version: current?.version ?? stage.environment_version,
                        difficulty: `Stage ${stage.stage}`,
                        purpose: stage.purpose,
                        scene_path: stage.scene_path,
                        definition_sha256: current?.definition_sha256 ?? stage.definition_sha256 ?? '',
                        settings: current?.settings ?? [],
                        modifiers: current?.modifiers ?? [],
                    };
                    const cardMeta = current
                        ? `Plan v${stage.environment_version} · Unity v${current.version} · ${matches ? 'matched' : 'current snapshot differs'}`
                        : `Plan v${stage.environment_version} · no current Unity scene`;
                    return <article className="fyp-curriculum-stage" key={`${stage.stage}-${stage.environment_id}`}>
                        <FypEnvironmentCard environment={stageEnvironment} meta={`Stage ${stage.stage} · ${cardMeta}`} />
                        <div className="fyp-record-grid">
                            <Record label="Environment ID" value={stage.environment_id} />
                            <Record label="Scene" value={stage.scene_path} />
                            <Record label="Pinned definition SHA-256" value={stage.definition_sha256} />
                        </div>
                        {stage.sampling && <pre>{JSON.stringify(stage.sampling, null, 2)}</pre>}
                        {current ? <details className="fyp-policy-environment-snapshot">
                            <summary>View current Unity environment settings and scene schema · {current.settings.length} settings · {current.modifiers.length} modifiers</summary>
                            {!matches && <p className="fyp-policy-context">Showing the latest Unity snapshot (version {current.version}). The plan refers to version {stage.environment_version}; its version and/or definition hash differs, so these current values are not an archived copy of that plan.</p>}
                            {current.settings.length > 0 && <section>
                                <h3>Environment settings</h3>
                                <div className="fyp-policy-snapshot-settings" role="table" aria-label={`Stage ${stage.stage} environment settings`}>
                                    <div role="row"><strong>Category</strong><strong>Setting</strong><strong>Unity value</strong></div>
                                    {current.settings.map(setting => <div role="row" key={setting.key}>
                                        <span>{setting.category}</span>
                                        <span title={`${setting.key} · ${setting.component}`}>{setting.label}</span>
                                        <span>{setting.unit ? `${setting.value} ${setting.unit}` : setting.value}</span>
                                    </div>)}
                                </div>
                            </section>}
                            <section>
                                <h3>Scene modifiers</h3>
                                {current.modifiers.length > 0 ? <div className="fyp-policy-snapshot-modifiers" role="table" aria-label={`Stage ${stage.stage} scene modifiers`}>
                                    <div role="row"><strong>Name</strong><strong>Shape</strong><strong>Position</strong><strong>Size</strong><strong>Trigger</strong></div>
                                    {current.modifiers.map((modifier, index) => <div role="row" key={`${modifier.name}-${modifier.shape}-${index}`}>
                                        <span>{modifier.name}</span><span>{modifier.shape}</span><span>{modifier.position}</span>
                                        <span>{modifier.size}</span><span>{modifier.is_trigger ? 'Yes' : 'No'}</span>
                                    </div>)}
                                </div> : <p className="fg-muted">No additional collider modifiers are recorded in this Unity snapshot.</p>}
                            </section>
                            <p className="fg-muted">These details are read from the current Unity snapshot. The curriculum entry documents the plan; it does not apply settings to the scene.</p>
                        </details> : <p className="fyp-policy-context">No current Unity snapshot has this environment ID. This stage is shown as a documented plan reference.</p>}
                    </article>;
                })}
            </div>}
        </section>
    </section>;
}

function humanize(value: string) {
    return value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function Record({ label, value }: { label: string; value: unknown }) {
    const formatted = typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value ?? '—');
    return <div className="fyp-record-field"><small>{label}</small><strong title={formatted}>{formatted}</strong></div>;
}
