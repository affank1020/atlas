import { useEffect, useState } from "react";
import { AskChat } from "./AskAtlas";
import { callTool } from "./api";

const EXAMPLES = ["What projects are in this portfolio?", "What experience does Affan have?", "Tell me about the latest blog posts."];
type PortfolioDashboard={contentTypes:{contentType:string;name:string;total:number;published:number;drafts:number}[];media:{active:number;bytes:number}};

export function AskPortfolio() {
    const [status, setStatus] = useState<PortfolioDashboard>();
    const [error, setError] = useState("");
    const refresh = () => callTool<PortfolioDashboard>("get_portfolio_dashboard").then(value => { setStatus(value); setError(""); }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
    useEffect(() => { void refresh(); }, []);
    const count=(type:string,key:"total"|"published"|"drafts")=>status?.contentTypes.find(item=>item.contentType===type)?.[key]??0;
    const banner = <section className="portfolio-sync-banner" aria-label="Atlas Portfolio publication status">
        <div><span className="sync-dot idle" /><b>Atlas Portfolio · published corpus</b><small>Drafts are excluded from this agent</small></div>
        <dl><div><dt>Projects</dt><dd>{count("projects","published")}</dd></div><div><dt>Posts</dt><dd>{count("posts","published")}</dd></div><div><dt>Experience</dt><dd>{count("experience","published")}</dd></div><div><dt>Media</dt><dd>{status?.media.active??0}</dd></div></dl>
        {error ? <span className="sync-error">{error}</span> : null}
        <a className="button ghost" href="#/portfolio">Manage content</a>
    </section>;
    return <AskChat agentName="Ask Portfolio" toolName="ask_portfolio" storageKey="atlas.observatory.ask-portfolio.history" introEyebrow="Grounded in the published portfolio" introCopy="Ask about projects, experience, writing, and profile content explicitly published from Atlas Portfolio into Fabric." examples={EXAMPLES} fixedScope="Published Portfolio only" banner={banner} />;
}
