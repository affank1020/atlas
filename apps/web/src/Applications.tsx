import { useEffect, useState, type ComponentType } from 'react';
import { callTool } from './api';
import { Portfolio } from './Portfolio';
import './applications.css';

export type ApplicationManifest = {
    type: string;
    slug: string;
    name: string;
    description: string;
    projectId: string;
};

// First-party UI components ship with Atlas Web; the Server registry controls
// which Applications are attached to each Project.
const applicationComponents: Record<string, ComponentType> = {
    portfolio: Portfolio,
};

export function ProjectApplications({ projectId }: { projectId: string }) {
    const [applications, setApplications] = useState<ApplicationManifest[]>([]);
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState('');
    useEffect(() => {
        let active = true;
        setBusy(true);
        callTool<ApplicationManifest[]>('list_applications', { projectId })
            .then(items => { if (active) { setApplications(items); setError(''); } })
            .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
            .finally(() => { if (active) setBusy(false); });
        return () => { active = false; };
    }, [projectId]);
    return <section className="panel project-applications" aria-label="Project Applications">
        <div className="panel-head"><div><p className="eyebrow">Applications</p><h2>Launch an application</h2></div><span>{applications.length} available</span></div>
        <p className="application-section-copy">Applications open in their own tab. Unlike Views, they provide dedicated tools and workflows.</p>
        {busy && <p role="status" className="application-status">Loading Applications…</p>}
        {error && <div role="alert" className="notice error">{error}</div>}
        {!busy && !error && applications.length === 0 && <p className="application-status">No Applications are registered in this Project yet.</p>}
        <div className="application-grid">
            {applications.map(app => <article className="application-card" key={app.slug}>
                <div className="application-card-icon" aria-hidden="true">{app.name.slice(0, 2).toUpperCase()}</div>
                <div className="application-card-details"><h3>{app.name}</h3><p>{app.description}</p><small>{app.type} Application</small></div>
                <a className="button application-launch" href={`#/projects/${projectId}/applications/${app.slug}`} target="_blank" rel="noopener noreferrer" aria-label={`Launch ${app.name} in a new tab`}>Launch ↗</a>
            </article>)}
        </div>
    </section>;
}

export function ApplicationWindow({ projectId, slug }: { projectId: string; slug: string }) {
    const [application, setApplication] = useState<ApplicationManifest>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(true);
    useEffect(() => {
        let active = true;
        setBusy(true);
        setApplication(undefined);
        setError('');
        callTool<ApplicationManifest>('get_application', { projectId, slug })
            .then(app => { if (active) { setApplication(app); setError(''); } })
            .catch(e => { if (active) { setApplication(undefined); setError(e instanceof Error ? e.message : String(e)); } })
            .finally(() => { if (active) setBusy(false); });
        return () => { active = false; };
    }, [projectId, slug]);
    useEffect(() => {
        if (!application) return;
        const previous = document.title;
        document.title = `${application.name} · Atlas`;
        return () => { document.title = previous; };
    }, [application]);
    const currentApplication = application?.projectId === projectId && application.slug === slug ? application : undefined;
    const Component = currentApplication && !error ? applicationComponents[currentApplication.type] : undefined;
    return <div className="application-window">
        <header className="application-window-bar">
            <a href={`#/projects/${projectId}/applications`} className="application-back">← Project Applications</a>
            <span className="application-window-brand">Atlas / {application?.name ?? 'Application'}</span>
        </header>
        <main className="application-window-main">
            {busy && <p role="status" className="application-status">Loading Application…</p>}
            {error && <div role="alert" className="notice error">{error}</div>}
            {!busy && !error && currentApplication && !Component && <div role="alert" className="notice error">This Application is registered on Atlas Server but its UI is not included in this version of Atlas Web.</div>}
            {Component && !busy && <Component />}
        </main>
    </div>;
}
