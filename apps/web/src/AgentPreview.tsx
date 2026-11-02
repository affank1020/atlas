import { useEffect, useState } from 'react';
import { agentRequest, agentHref, type AgentRunPage } from './agentsApi';
import './agents.css';
/** A small scoped view; full receipts/timeline live in the Agents Application. */
export function AgentPreview({nodeId,checkoutId,refreshVersion=0}:{nodeId?:string;checkoutId?:string;refreshVersion?:number}) {
    const [page,setPage]=useState<AgentRunPage>(),[error,setError]=useState('');
    useEffect(()=>{
        const controller=new AbortController();let live=true,loading=false;setPage(undefined);setError('');
        const load=async()=>{if(loading)return;loading=true;try{const [active,recent]=await Promise.all([agentRequest<AgentRunPage>('list',{nodeId,checkoutId,state:'active',limit:5},controller.signal),agentRequest<AgentRunPage>('list',{nodeId,checkoutId,limit:5},controller.signal)]);if(live){setPage({runs:[...new Map([...active.runs,...recent.runs].map(run=>[run.runId,run])).values()],next:recent.next});setError('');}}catch(e){if(live&&!controller.signal.aborted)setError((e as Error).message);}finally{loading=false;}};
        void load();const timer=setInterval(()=>void load(),5000);
        return()=>{live=false;controller.abort();clearInterval(timer);};
    },[nodeId,checkoutId,refreshVersion]);
    const scope={...(nodeId?{nodeId}:{}),...(checkoutId?{checkoutId}:{})};
    return <section className="agent-preview" aria-label="Active and recent agents"><h3>Active and recent agents</h3>
        {!page&&!error&&<p role="status">Loading agent runs…</p>}
        {error&&<p role="status">Agent activity unavailable. Open Agents to retry.</p>}
        {page&&!error&&(page.runs.length?<ul>{page.runs.map(run=><li key={run.runId}><a href={agentHref(run.runId)}>{run.runId.slice(0,8)}</a><span>{run.state.replaceAll('_',' ')}</span></li>)}</ul>:<p>No recent agent runs.</p>)}
        <a href={agentHref(undefined,scope)}>View agents →</a></section>;
}
