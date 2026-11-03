import { useEffect, useRef, useState } from 'react';
import type { AgentHierarchyNode, AgentState } from '@atlas/protocol/agent-jobs';
import { agentRequest, agentHref, duration, type AgentRunView, type AgentRunPage, type AgentEventPage } from './agentsApi';
import { SkeletonRows } from './Skeletons';
import './agents.css';
const terminal=new Set(['completed','failed','cancelled','timed_out','incomplete']);
const when=(x:string|null)=>x?new Date(x).toLocaleString():'Not observed';
const label=(x:string)=>x.replaceAll('_',' ');
function useLocationQuery() {
    const read=()=>location.hash.split('?')[1]??'';
    const [query,setQuery]=useState(read);
    useEffect(()=>{const change=()=>setQuery(read());addEventListener('hashchange',change);return()=>removeEventListener('hashchange',change);},[]);
    return new URLSearchParams(query);
}
export function AgentStatus({state}:{state:AgentState}) {return <span className={'agent-status agent-status-'+state}>{label(state)}</span>;}
function Notice({error,retry}:{error:string;retry:()=>void}) {return error?<p className="notice error" role="alert">{error} <button className="ghost" onClick={retry}>Retry</button></p>:null;}
export function Agents() {
    const query=useLocationQuery(),runId=query.get('run');
    const root=useRef<HTMLElement>(null);
    useEffect(()=>{root.current?.closest('main')?.scrollTo({top:0});},[runId]);
    return <section ref={root} className="agents-app"><header className="agents-heading"><div><p className="eyebrow">Application</p><h1>Agents</h1></div><span>Read-only Pi execution</span></header>
        {runId?<AgentDetail key={runId} runId={runId}/>:<AgentList key={query.toString()} state={query.get('state')??''} nodeId={query.get('nodeId')??''} checkoutId={query.get('checkoutId')??''}/>}</section>;
}
function AgentList({state,nodeId,checkoutId}:{state:string;nodeId:string;checkoutId:string}) {
    const [data,setData]=useState<AgentRunPage>(),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
    const [before,setBefore]=useState<AgentRunPage['next']>(null),[busy,setBusy]=useState(false);
    const [choices,setChoices]=useState<AgentRunView[]>([]);
    useEffect(()=>{
        const controller=new AbortController();let active=true,loading=false;
        const load=async()=>{
            if(loading)return;loading=true;setBusy(true);
            try {const page=await agentRequest<AgentRunPage>('list',{limit:50,...(state?{state}:{}),...(nodeId?{nodeId}:{}),...(checkoutId?{checkoutId}:{}),...(before?{before}:{})},controller.signal);
                if(active){setData(page);setError('');setChoices(old=>[...new Map([...old,...page.runs].map(r=>[r.runId,r])).values()].slice(-200));}}
            catch(e){if(active&&!controller.signal.aborted)setError((e as Error).message);}
            finally{loading=false;if(active)setBusy(false);}
        };
        void load();const timer=setInterval(()=>void load(),3000);
        return()=>{active=false;controller.abort();clearInterval(timer);};
    },[state,nodeId,checkoutId,before,refresh]);
    const filter=(key:string,value:string)=>{const q:Record<string,string>={};if(state)q.state=state;if(nodeId)q.nodeId=nodeId;if(checkoutId)q.checkoutId=checkoutId;if(value)q[key]=value;else delete q[key];location.hash=agentHref(undefined,q);};
    const nodes=data?.scopes?.nodes??[...new Map(choices.map(r=>[r.nodeId,{id:r.nodeId,name:r.nodeName}])).values()];
    const checkouts=data?.scopes?.checkouts??[...new Map(choices.map(r=>[r.checkoutId,{id:r.checkoutId,name:r.checkoutName}])).values()];
    return <>
        <div className="agents-toolbar"><label>Status<select value={state} onChange={e=>filter('state',e.target.value)}><option value="">All runs</option>{['active','running','completed','failed','cancelled','unknown','incomplete','timed_out','dispatching','starting','cancelling'].map(s=><option key={s} value={s}>{label(s)}</option>)}</select></label>
            <label>Node<select value={nodeId} onChange={e=>filter('nodeId',e.target.value)}><option value="">All Nodes</option>{[...nodes,...(!nodes.some(n=>n.id===nodeId)&&nodeId?[{id:nodeId,name:nodeId}]:[])].map(({id,name})=><option key={id} value={id}>{name}</option>)}</select></label>
            <label>Checkout<select value={checkoutId} onChange={e=>filter('checkoutId',e.target.value)}><option value="">All checkouts</option>{[...checkouts,...(!checkouts.some(n=>n.id===checkoutId)&&checkoutId?[{id:checkoutId,name:checkoutId}]:[])].map(({id,name})=><option key={id} value={id}>{name}</option>)}</select></label>
            <button className="ghost" disabled={busy} onClick={()=>setRefresh(n=>n+1)}>Refresh</button></div>
        <Notice error={error} retry={()=>setRefresh(n=>n+1)}/>
        {data?.scopes?.truncated&&<p className="hint">Filter choices are limited to 200 Nodes/checkouts. Scoped deep links still work.</p>}
        {!data&&!error&&<SkeletonRows label="Loading agent runs" variant="list" rows={4}/>}
        {data&&<><p className="agents-update" role="status">{error?'Updates interrupted. Showing the last retrieved snapshot.':busy?'Refreshing…':'Refreshes every 3 seconds.'}</p>
            {data.runs.length===0?<p className="agents-empty">No agent runs match this view.</p>:<div className="agents-table-wrap"><table className="agents-table"><thead><tr><th>Run / state</th><th>Checkout / branch</th><th>Node</th><th>Actual model</th><th>Started / duration</th></tr></thead><tbody>{data.runs.map(run=><tr key={run.runId}><td><a href={agentHref(run.runId)}>{run.runId.slice(0,8)}</a><br/><AgentStatus state={run.state}/></td><td><a href={'#/workspaces?workspace='+run.checkoutId}>{run.checkoutName}</a><br/><code>{run.branch}</code></td><td><a href={'#/nodes?node='+run.nodeId}>{run.nodeName}</a><br/><small>{run.nodeOnline?'Connected':'Offline'}</small></td><td>{run.actualProfile?`${run.actualProfile.provider} / ${run.actualProfile.model}`:'Not observed'}<br/><small>Requested: {run.requestedProfileId}</small></td><td>{when(run.startedAt)}<br/><small>{duration(run.startedAt,run.finishedAt)}{run.state==='unknown'?' · observation uncertain':''}</small></td></tr>)}</tbody></table></div>}
            <nav className="agents-pagination" aria-label="Run pages">{before&&<button className="ghost" onClick={()=>{setData(undefined);setBefore(null);}}>Newest runs</button>}{data.next&&<button className="ghost" onClick={()=>{setBefore(data.next);setData(undefined);}}>Older runs</button>}</nav></>}
    </>;
}
export function AgentTree({node}:{node:AgentHierarchyNode}) {
    return <ul className="agent-tree"><li><span>{node.role} Pi agent</span> <code>{node.agentId.slice(0,8)}</code> · <AgentStatus state={node.state}/> · {node.actualProfile?`${node.actualProfile.provider} / ${node.actualProfile.model}`:node.requestedProfileId?`Requested model profile: ${node.requestedProfileId}`:'Model not observed'}
        {node.children.map(child=><AgentTree key={child.agentId} node={child}/>)}</li></ul>;
}
const eventTitle=(event:AgentEventPage['events'][number])=>{
    switch(event.type){
        case 'starting':return 'Process starting';case 'ready':return 'Pi runtime ready';case 'agent_start':return 'Pi agent loop started';
        case 'agent_end':return 'Pi turn ended';case 'agent_settled':return 'Pi agent settled';case 'process_heartbeat':return 'Process observed';
        case 'tool_execution_start':return 'Read tool started';case 'tool_execution_end':return event.data.isError?'Read tool returned an error':'Read tool completed';
        case 'worker_error':return 'Pi worker error (details redacted)';case 'result':return event.data.ok?'Pi returned a successful process result':'Pi returned an error result';
        case 'child_start':return event.data.role+' child agent started ('+event.data.agentId.slice(0,8)+')';
        case 'child_state':return 'Child agent '+event.data.agentId.slice(0,8)+' '+label(event.data.state);
        case 'child_terminal':return 'Child agent '+event.data.agentId.slice(0,8)+' '+label(event.data.state);
        case 'stopping':return 'Stopping: '+label(event.data.reason);case 'terminal':return 'Process '+label(event.data.state)+': '+label(event.data.reason);
    }
};
function AgentDetail({runId}:{runId:string}) {
    const [run,setRun]=useState<AgentRunView>(),[events,setEvents]=useState<AgentEventPage['events']>([]),[error,setError]=useState('');
    const [gap,setGap]=useState(false),[refresh,setRefresh]=useState(0),[cancelling,setCancelling]=useState(false),[more,setMore]=useState(false);
    const cursorRef=useRef(0);
    useEffect(()=>{
        const controller=new AbortController();let active=true,cursor=cursorRef.current,loading=false;
        const load=async()=>{
            if(loading)return;loading=true;
            try {
                const current=await agentRequest<AgentRunView>('get',{runId},controller.signal);
                const page=await agentRequest<AgentEventPage>('events',{runId,after:cursor,limit:100},controller.signal);
                if(active){setRun(current);setError('');setGap(old=>old||page.truncated||current.eventGap);
                    setEvents(old=>[...new Map([...old,...page.events].map(e=>[e.cursor,e])).values()].sort((a,b)=>a.cursor-b.cursor).slice(-2000));
                    cursor=page.events.at(-1)?.cursor??cursor;cursorRef.current=cursor;setMore(cursor<page.lastCursor);}
            } catch(e){if(active&&!controller.signal.aborted)setError((e as Error).message);}
            finally{loading=false;}
        };
        void load();const timer=setInterval(()=>void load(),2000);
        return()=>{active=false;controller.abort();clearInterval(timer);};
    },[runId,refresh]);
    const cancel=async()=>{
        if(!window.confirm('Request cancellation? Termination is confirmed only by a process receipt.'))return;
        setCancelling(true);
        try{setRun(await agentRequest<AgentRunView>('control',{runId,action:'cancel'}));setError('');setRefresh(n=>n+1);}
        catch(e){setError((e as Error).message);}finally{setCancelling(false);}
    };
    return <>
        <div className="agents-detail-nav"><a href={agentHref()}>← All runs</a><button className="ghost" onClick={()=>setRefresh(n=>n+1)}>Refresh</button></div>
        <Notice error={error} retry={()=>setRefresh(n=>n+1)}/>
        {!run&&!error&&<SkeletonRows label="Loading agent run" variant="panel" rows={4}/>}
        {run&&<><header className="agent-run-heading"><h2>Run <code>{run.runId.slice(0,8)}</code></h2><AgentStatus state={run.state}/>{run.canCancel&&<button className="ghost danger" disabled={cancelling||!!run.cancelRequestedAt} onClick={()=>void cancel()}>{run.cancelRequestedAt?'Cancellation requested':cancelling?'Requesting…':'Cancel run'}</button>}</header>
            {run.state==='unknown'&&<p className="notice" role="status">Execution is uncertain. The Node is offline or its report is stale. This run has not been retried or confirmed stopped.</p>}
            {error&&<p>Live updates interrupted. Status below is the last retrieved snapshot.</p>}
            {run.reason&&<p className="agent-reason">{label(run.reason)}</p>}
            <dl className="agent-facts"><div><dt>Execution Node</dt><dd><a href={'#/nodes?node='+run.nodeId}>{run.nodeName}</a> · {run.nodeOnline?'Connected':'Offline'}</dd></div>
                <div><dt>Workspace / checkout</dt><dd><a href={'#/workspaces?workspace='+run.checkoutId}>{run.checkoutName}</a>{run.logicalWorkspaceId&&<> · <code>{run.logicalWorkspaceId}</code></>}</dd></div>
                <div><dt>Approved scope</dt><dd>{run.permission} · <code>{run.approvedRoot}</code></dd></div><div><dt>Branch / HEAD</dt><dd><code>{run.branch}</code> · <code>{run.head}</code></dd></div>
                <div><dt>Actual model</dt><dd>{run.actualProfile?`${run.actualProfile.provider} / ${run.actualProfile.model}`:'Not observed'} (requested {run.requestedProfile.provider} / {run.requestedProfile.model})</dd></div>
                <div><dt>Initiator</dt><dd>Authenticated owner OAuth client · client name not recorded</dd></div>
                <div><dt>Requested</dt><dd>{when(run.createdAt)}</dd></div><div><dt>Process started</dt><dd>{when(run.startedAt)}</dd></div><div><dt>Duration</dt><dd>{duration(run.startedAt,run.finishedAt)}{run.state==='unknown'?' · elapsed; process state uncertain':''}</dd></div>
                <div><dt>Last observed / finished</dt><dd>{when(run.observedAt)} / {when(run.finishedAt)}</dd></div>
                {run.projectId&&<div><dt>Project</dt><dd><a href={'#/projects/'+run.projectId}>Open associated Project</a></dd></div>}
                <div><dt>Cancellation</dt><dd>{run.cancelRequestedAt?`Requested ${when(run.cancelRequestedAt)}${terminal.has(run.state)?'':' · termination not confirmed'}`:'Not requested'}</dd></div></dl>
            <section className="agent-section"><h3>Agents</h3><AgentTree node={run.hierarchy}/>{run.hierarchy.children.length===0&&<p className="hint">No child-agent lifecycle events observed. Subagent execution remains disabled until the reviewed Pi extension is enabled.</p>}</section>
            <section className="agent-section"><h3>Execution timeline</h3><p className="hint">Observed metadata only. Tool arguments, file contents and model prose are redacted.</p>{(gap||events.length===2000)&&<p className="notice">History is bounded. Earlier events may be unavailable; complete execution evidence cannot be inferred from this timeline.</p>}
                <ol className="agent-timeline">{events.map(event=><li key={event.cursor}><span className="agent-event-cursor">{event.cursor}</span><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time><span>{eventTitle(event)}</span></li>)}</ol>
                {!events.length&&<p>No execution events received.</p>}{more&&<p role="status">Catching up with persisted events… <button className="ghost" onClick={()=>setRefresh(n=>n+1)}>Refresh history</button></p>}</section>
            <section className="agent-section"><h3>Process receipt and evidence</h3><p>Process completion does not verify the requested task. No tests or commits have been independently verified.</p>
                <dl className="agent-facts"><div><dt>Observed read completions</dt><dd>{run.evidence.toolExecutions??0} (includes tool errors)</dd></div><div><dt>Runtime / loop / result</dt><dd>{run.evidence.runtimeReady?'Ready':'Not observed'} / {run.evidence.agentSettled?'Settled':'Not observed'} / {run.evidence.piResult?'Pi result received':'No successful Pi result'}</dd></div>
                    <div><dt>Verified task success</dt><dd>Not verified</dd></div><div><dt>Receipt source</dt><dd>Authenticated Node process reports · trusted Node, no hardware attestation</dd></div>
                    {run.result&&<><div><dt>Process PID / runtime</dt><dd>{run.result.pid??'Not observed'} / Pi {run.result.runtimeVersion}</dd></div><div><dt>Exit code / signal</dt><dd>{run.result.exitCode??'Not observed'} / {run.result.signal===null?'None':run.result.signal??'Not observed'}</dd></div><div><dt>Terminal receipt</dt><dd>{label(run.result.state)} · {label(run.result.reason??'No reason reported')}</dd></div></>}
                </dl></section>
        </>}
    </>;
}
