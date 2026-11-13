import { useCallback, useEffect, useMemo, useState } from 'react';
import { callTool } from './api';

export type FypEnvironmentSetting = {
    key: string; component: string; category: string; label: string; value: string; unit: string;
};
export type FypEnvironmentModifier = {
    name: string; shape: string; position: string; size: string; is_trigger: boolean;
};
export type FypEnvironment = {
    environment_id: string; name: string; version: string; difficulty: string; purpose: string;
    scene_path: string; definition_sha256: string;
    snapshot_recorded?: boolean;
    settings: FypEnvironmentSetting[]; modifiers: FypEnvironmentModifier[];
};

export function FypEnvironmentCard({ environment, onOpen, meta }: {
    environment: FypEnvironment; onOpen?: (environmentId: string) => void; meta?: string;
}) {
    const content = <>
        <span className="fyp-environment-card-heading"><strong>{environment.name}</strong></span>
        <span className="fyp-environment-difficulty">{environment.difficulty}</span>
        <span className="fyp-environment-purpose">{environment.purpose || 'No purpose recorded.'}</span>
        <span className="fyp-environment-card-meta">{meta ?? `Version ${environment.version} · ${environment.settings.length} settings · ${environment.modifiers.length} modifiers`}</span>
    </>;
    return onOpen
        ? <button className="fyp-environment-card" type="button" onClick={() => onOpen(environment.environment_id)}>{content}</button>
        : <article className="fyp-environment-card fyp-environment-card-static">{content}</article>;
}

export function FypEnvironmentCatalog({ initialEnvironmentId, onSelectEnvironment, onEnvironmentCount, onEnvironmentName }: {
    initialEnvironmentId?: string; onSelectEnvironment?: (environmentId?: string) => void;
    onEnvironmentCount?: (count: number | null) => void;
    onEnvironmentName?: (name?: string) => void;
}) {
    const [environments, setEnvironments] = useState<FypEnvironment[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(initialEnvironmentId ?? null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        try {
            const records = await callTool<FypEnvironment[]>('football_fyp_environments');
            setEnvironments(records);
            onEnvironmentCount?.(records.length);
            setError('');
        } catch (failure) {
            onEnvironmentCount?.(null);
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally { setLoading(false); }
    }, [onEnvironmentCount]);

    useEffect(() => {
        setSelectedId(initialEnvironmentId ?? null);
    }, [initialEnvironmentId]);
    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => { void refresh(); }, 15000);
        return () => window.clearInterval(timer);
    }, [refresh]);

    const selected = environments.find(environment => environment.environment_id === selectedId);
    useEffect(() => { onEnvironmentName?.(selected?.name); }, [selected?.name, onEnvironmentName]);
    const groupedSettings = useMemo(() => {
        const groups = new Map<string, FypEnvironmentSetting[]>();
        for (const setting of selected?.settings ?? []) {
            const group = groups.get(setting.category) ?? [];
            group.push(setting);
            groups.set(setting.category, group);
        }
        return [...groups.entries()];
    }, [selected]);

    const open = (environmentId: string) => {
        setSelectedId(environmentId);
        onSelectEnvironment?.(environmentId);
    };
    if (selected) return <section className="fyp-environment-page" aria-label={`${selected.name} environment details`}>
        <div className="fg-panel-title fyp-environment-detail-title">
            <p>{selected.purpose || 'No purpose recorded.'}</p>
            <div className="fyp-environment-badges"><span>{selected.difficulty}</span><span>Version {selected.version}</span></div>
        </div>
        <div className="fyp-record-grid">
            <Record label="Scene" value={selected.scene_path} />
            <Record label="Environment ID" value={selected.environment_id} />
            <Record label="Definition SHA-256" value={selected.definition_sha256} />
        </div>
        <h3>Environment settings</h3>
        {groupedSettings.length === 0 ? <p className="fg-muted">No annotated environment settings are recorded.</p> :
            <div className="fyp-environment-settings">{groupedSettings.map(([category, settings]) => <section key={category} aria-label={category}>
                <h4>{category}</h4>
                <div className="fyp-record-grid">{settings.map(setting => <Record key={setting.key} label={setting.label}
                    value={setting.unit ? `${setting.value} ${setting.unit}` : setting.value} detail={setting.key} />)}</div>
            </section>)}</div>}
        <h3>Scene modifiers</h3>
        {!selected.modifiers.length ? <p className="fg-muted">No additional collider modifiers are recorded.</p> :
            <div className="fyp-environment-modifiers" role="table" aria-label="Scene collider modifiers">
                <div role="row"><strong>Name</strong><strong>Shape</strong><strong>Position</strong><strong>Size</strong><strong>Trigger</strong></div>
                {selected.modifiers.map((modifier, index) => <div role="row" key={`${modifier.name}-${modifier.shape}-${index}`}>
                    <span>{modifier.name}</span><span>{modifier.shape}</span><span>{modifier.position}</span>
                    <span>{modifier.size}</span><span>{modifier.is_trigger ? 'Yes' : 'No'}</span>
                </div>)}
            </div>}
    </section>;

    return <section className="fyp-environment-page" aria-label="FYP environment library">
        <div className="fyp-environment-toolbar">
            {error && <p className="fg-error" role="alert">{error}</p>}
            <button type="button" className="fg-button" onClick={() => void refresh()} disabled={loading}>Refresh</button>
        </div>
        {!loading && !error && environments.length === 0 && <p className="fg-muted">No scenes are currently included in the Unity environment catalogue.</p>}
        <div className="fyp-environment-cards">{environments.map(environment => <FypEnvironmentCard key={environment.environment_id}
            environment={environment} onOpen={open} />)}</div>
    </section>;
}

function Record({ label, value, detail }: { label: string; value: string; detail?: string }) {
    return <div className="fyp-record-field"><small>{label}</small><strong title={detail}>{value}</strong>{detail && <code>{detail}</code>}</div>;
}
