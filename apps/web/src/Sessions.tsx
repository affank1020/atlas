import { useCallback, useEffect, useState } from 'react';
import { callTool } from './api';
import './sessions.css';

type Session = { id:string; title:string; objective:string; summary:string; status:'active'|'closed'; revision:number; updatedAt:string; participants:Participant[]; assignments:Assignment[]; events:SessionEvent[] };
type Participant = { id:string; role:'coordinator'|'worker'; label:string; joinedAt:string; lastSeenAt:string };
type Assignment = { id:string; title:string; brief:string; status:'queued'|'active'|'blocked'|'submitted'|'accepted'; assigneeId:string|null; priority:number; result:string|null; updatedAt:string };
type SessionEvent = { id:string; participantId:string|null; kind:string; body:string; createdAt:string };
type Listing = Pick<Session,'id'|'title'|'objective'|'status'|'revision'|'updatedAt'>;
const time=(date:string)=>new Date(date).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
const joined=(p:Participant)=>p.role==='coordinator'?'Coordinator':p.label;
export function Sessions(){
  const [items,setItems]=useState<Listing[]>([]);
  const [selected,setSelected]=useState<string|null>(null);
  const [detail,setDetail]=useState<Session|null>(null);
  const [includeClosed,setIncludeClosed]=useState(false);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [refreshId,setRefreshId]=useState(0);
  const refresh=useCallback(()=>setRefreshId(x=>x+1),[]);
  useEffect(()=>{
    let live=true;
    setLoading(true);
    Promise.all([callTool<Listing[]>('sessions_list',{includeClosed}),...(selected?[callTool<Session>('sessions_get',{sessionId:selected})]:[])])
      .then(([list,session])=>{if(!live)return;setItems(list);if(session)setDetail(session as Session);else setDetail(null);setError('');})
      .catch((e:Error)=>{if(live)setError(e.message);})
      .finally(()=>{if(live)setLoading(false);});
    return ()=>{live=false;};
  },[includeClosed,selected,refreshId]);
  useEffect(()=>{
    if(!selected && items.length) setSelected(items[0]!.id);
    if(selected && items.length && !items.some(x=>x.id===selected))setSelected(items[0]!.id);
  },[items,selected]);
  const prompt=selected&&detail?`Join Atlas Session "${detail.title}" (sessionId ${detail.id}). Find your worker assignment, sync your role, and publish your results in Atlas.`:'Join my active Atlas Session and take an available worker assignment.';
  const copy=()=>{if(navigator.clipboard)void navigator.clipboard.writeText(prompt).catch(()=>setError('Clipboard unavailable. Select the instruction manually.'));};
  const name=(id:string|null)=>detail?.participants.find(p=>p.id===id)?.label??'Unassigned';
  return <div className="sessions-page">
    <header className="page-head"><div><p className="eyebrow">Tools / Coordination</p><h1>Sessions</h1><p>Organise ChatGPT conversations into a coordinated engineering team. Atlas keeps the shared assignments, roles and decisions.</p></div>
      <div className="actions"><label className="toggle"><input type="checkbox" checked={includeClosed} onChange={e=>setIncludeClosed(e.target.checked)}/> Include closed</label><button onClick={refresh} disabled={loading}>Refresh</button></div></header>
    {error&&<div className="notice error" role="alert">{error}</div>}
    <div className="sessions-layout">
      <aside className="panel sessions-index" aria-label="Sessions list">
        <div className="panel-head"><div><p className="eyebrow">Workspace</p><h2>Team sessions</h2></div><small>{items.length}</small></div>
        {items.map(item=><button className={item.id===selected?'session-list-item active':'session-list-item'} key={item.id} onClick={()=>setSelected(item.id)} aria-current={item.id===selected?'true':undefined}>
          <span><b>{item.title}</b><small>{item.objective}</small></span><span className={item.status==='active'?'session-state':'session-state closed'}>{item.status}</span>
        </button>)}
        {!items.length&&!loading&&<div className="sessions-empty">No sessions yet. Start one from a ChatGPT conversation using the Atlas connection.</div>}
      </aside>
      <div className="sessions-detail">
        {loading&&!detail&&<section className="panel sessions-empty" role="status">Loading sessions…</section>}
        {!detail&&!loading&&<section className="panel sessions-start"><p className="eyebrow">Get started</p><h2>Start from ChatGPT</h2><p>Ask a conversation to “Start an Atlas Session for [objective]”. The creator becomes coordinator. Other chats can join through Atlas MCP.</p><p className="hint">No chat URLs or additional AI API billing required. Chats still need you to initiate turns.</p></section>}
        {detail&&<><section className="panel sessions-hero">
          <div className="sessions-hero-title"><div><p className="eyebrow">Session / revision {detail.revision}</p><h2>{detail.title}</h2></div><span className={detail.status==='active'?'session-state':'session-state closed'}>{detail.status}</span></div>
          <p>{detail.objective}</p><p className="sessions-updated">Last updated {time(detail.updatedAt)}</p>
          <div className="sessions-metrics"><div><b>{detail.participants.length}</b><small>Participants</small></div><div><b>{detail.assignments.filter(a=>a.status==='active').length}</b><small>In progress</small></div><div><b>{detail.assignments.filter(a=>a.status==='submitted').length}</b><small>For review</small></div><div><b>{detail.assignments.filter(a=>a.status==='accepted').length}</b><small>Accepted</small></div></div>
          {detail.summary&&<div className="sessions-context"><strong>Current decisions &amp; context</strong><p>{detail.summary}</p></div>}
          <div className="sessions-prompt"><span>Connect another chat by asking it to join this session.</span><button className="ghost" onClick={copy}>Copy join instruction</button></div>
        </section>
        <section className="panel"><div className="panel-head"><div><p className="eyebrow">Team</p><h2>Participants</h2></div><small>Last check-in, not online status</small></div>
          <div className="sessions-participants">{detail.participants.map(p=><div className="sessions-participant" key={p.id}><div className="sessions-avatar">{p.role==='coordinator'?'C':'W'}</div><div><b>{joined(p)}</b><small>{p.role==='coordinator'?'Plans and integrates work':'Executes assigned work'}</small></div><time title={p.lastSeenAt}>{time(p.lastSeenAt)}</time></div>)}</div>
        </section>
        <section className="panel"><div className="panel-head"><div><p className="eyebrow">Execution</p><h2>Assignments</h2></div><small>{detail.assignments.length} total</small></div>
          {detail.assignments.length===0&&<p className="sessions-empty">The coordinator hasn't assigned any work yet.</p>}
          <div className="sessions-tasks">{detail.assignments.map(task=><article className="sessions-task" key={task.id}><div className="sessions-task-head"><b>{task.title}</b><span className={'session-task-status '+task.status}>{task.status}</span></div><p>{task.brief}</p><small>{name(task.assigneeId)} · priority {task.priority}</small>{task.result&&<div className="sessions-result"><strong>Worker report</strong><p>{task.result}</p></div>}</article>)}</div>
        </section>
        <section className="panel"><div className="panel-head"><div><p className="eyebrow">History</p><h2>Activity</h2></div><small>Latest 50</small></div>
          <div className="sessions-events">{detail.events.map(ev=><div key={ev.id} className="sessions-event"><time>{time(ev.createdAt)}</time><div><b>{ev.kind}</b><span> · {name(ev.participantId)}</span><p>{ev.body}</p></div></div>)}</div>
        </section></>}
      </div>
    </div>
  </div>;
}
