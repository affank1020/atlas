
import { useEffect, useState } from 'react';
import { callTool } from './api';
import './knowledge-study.css';

type StudyCard = {
  id:string;cardKey:string;question:string;expectedAnswer:string;explanation?:string;
  cardType:'recall'|'application'|'critique'|'assessment';origin:'lecturer'|'generated';
  sourceKey:string;sourceLink?:string;sectionKey?:string;tags?:string[];
  progress?:{reviews:number;streak:number;intervalDays:number;nextDueAt:string;lastRating:string}|null;
};
type Deck={items:StudyCard[];total:number;mode:'due'|'all'};
type Overview={groups:{id:string;key:string;name:string}[]};
type Source={id:string;sourceKey:string;title:string};
const ratings = [
  {value:'again',label:'Again',sub:'10 min'},
  {value:'hard',label:'Hard',sub:'short review'},
  {value:'good',label:'Good',sub:'longer review'},
  {value:'easy',label:'Easy',sub:'longest review'},
] as const;
const safe=(link?:string)=>{try{const u=new URL(link||'');return ['http:','https:'].includes(u.protocol)?u.toString():'';}catch{return '';}};

export function KnowledgeStudy(){
  const [group,setGroup]=useState('');
  const [overview,setOverview]=useState<Overview>({groups:[]});
  const [sourceKey,setSourceKey]=useState('');
  const [sources,setSources]=useState<Source[]>([]);
  const [sourceTerm,setSourceTerm]=useState('');
  const [mode,setMode]=useState<'due'|'all'>('due');
  const [practice,setPractice]=useState<'flashcards'|'assessment'>('flashcards');
  const [deck,setDeck]=useState<Deck>({items:[],total:0,mode:'due'});
  const [idx,setIdx]=useState(0);
  const [batchOffset,setBatchOffset]=useState(0);
  const [flipped,setFlipped]=useState(false);
  const [written,setWritten]=useState('');
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [done,setDone]=useState(0);
  const [refresh,setRefresh]=useState(0);
  const card=deck.items[idx];
  const cardType=practice==='assessment'?'assessment':'all';

  useEffect(()=>{
    const controller=new AbortController();
    callTool<Overview>('knowledge_bank_overview',{},controller.signal).then(setOverview).catch(()=>{});
    return()=>controller.abort();
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    const timer=window.setTimeout(()=>{
      callTool<{items:Source[]}>('knowledge_bank_browse',{
        collection:'sources',q:sourceTerm,group,sourceKey:'',sourceType:'',entryKind:'',tag:'',limit:30,offset:0
      },controller.signal).then(value=>setSources(value.items)).catch(()=>{});
    },180);
    return()=>{window.clearTimeout(timer);controller.abort();};
  },[group,sourceTerm]);
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);setError('');setIdx(0);setFlipped(false);setWritten('');setDone(0);
    callTool<Deck>('knowledge_bank_study_deck',{group,sourceKey,cardType,mode,limit:25,offset:mode==='all'?batchOffset:0},controller.signal)
      .then(value=>{if(!controller.signal.aborted)setDeck(value);})
      .catch(err=>{if(!controller.signal.aborted)setError(err instanceof Error?err.message:String(err));})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[group,sourceKey,practice,mode,batchOffset,refresh]);
  const grade=async(rating:'again'|'hard'|'good'|'easy')=>{
    if(!card||saving)return;
    setSaving(true);setError('');
    try{
      await callTool('knowledge_bank_rate_card',{cardKey:card.cardKey,rating});
      setDone(count=>count+1);setFlipped(false);setWritten('');setIdx(i=>i+1);
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setSaving(false);}
  };
  const isFinished=!loading && idx>=deck.items.length;
  return <main className="kb-study" aria-label="Knowledge Bank Study">
    <div className="kb-study-intro">
      <div><p className="kb-study-kicker">STUDY / KNOWLEDGE BANK</p><h2>Practice what you've read.</h2>
        <p>Retrieval practice from your source library. Reveal the guidance, then rate your own answer; no AI marking.</p></div>
      <div className="kb-study-scope"><strong>{deck.total}</strong><span>{mode==='due'?'due or new cards':'available cards'}</span></div>
    </div>
    <div className="kb-study-controls">
      <fieldset className="kb-study-toggle"><legend>Mode</legend>
        <button type="button" className={practice==='flashcards'?'active':''} onClick={()=>{setBatchOffset(0);setPractice('flashcards');}}>Flashcards</button>
        <button type="button" className={practice==='assessment'?'active':''} onClick={()=>{setBatchOffset(0);setPractice('assessment');}}>Mini assessment</button>
      </fieldset>
      <label>Group <select aria-label="Study group" value={group} onChange={e=>{setBatchOffset(0);setGroup(e.target.value);setSourceKey('');}}>
        <option value="">All groups</option>{overview.groups.map(g=><option value={g.key} key={g.key}>{g.name}</option>)}
      </select></label>
      <label>Find source <input type="search" value={sourceTerm} onChange={e=>setSourceTerm(e.target.value)}
        aria-label="Search study sources" placeholder="Search by document title…" /></label>
      <label>Source <select aria-label="Study source" value={sourceKey} onChange={e=>{setBatchOffset(0);setSourceKey(e.target.value);}}>
        <option value="">All sources</option>{sources.map(s=><option key={s.sourceKey} value={s.sourceKey}>{s.title}</option>)}
        {sourceKey && !sources.some(s=>s.sourceKey===sourceKey) && <option value={sourceKey}>{sourceKey}</option>}
      </select></label>
      <label>Review set <select aria-label="Review set" value={mode} onChange={e=>{setBatchOffset(0);setMode(e.target.value as 'due'|'all');}}>
        <option value="due">Due + new</option><option value="all">All practice cards</option>
      </select></label>
    </div>
    <div className="kb-study-help">{practice==='assessment'
      ? 'These are the lecturer’s own self-assessment questions. The answer guidance was prepared from the notes; it is not a lecturer-provided mark scheme.'
      : 'Generated practice cards are clearly labelled. Each is linked to the original material it draws upon.'}</div>
    {error && <div role="alert" className="kb-study-error">{error} <button type="button" onClick={()=>setRefresh(n=>n+1)}>Retry</button></div>}
    {loading ? <p role="status" className="kb-study-load">Loading your practice deck…</p>
      : deck.items.length===0 ? <div className="kb-study-empty"><h3>{mode==='due'?'Nothing due right now':'No cards in this selection'}</h3>
        <p>{mode==='due'?'You can practise all cards or select a different source.':'Cards will appear here as we ingest more reading material.'}</p>
        {mode==='due' && <button type="button" onClick={()=>setMode('all')}>Practise all cards</button>}
      </div>
      : isFinished ? <div className="kb-study-empty"><h3>Practice round complete</h3><p>You reviewed {done} cards. Your self-ratings have been saved to Atlas.</p>
          {mode==='all' && batchOffset + deck.items.length < deck.total
            ? <button type="button" onClick={()=>setBatchOffset(n=>n+deck.items.length)}>Next batch →</button>
            : <button type="button" onClick={()=>setRefresh(n=>n+1)}>Refresh practice</button>}
          {mode==='due'&&<button type="button" onClick={()=>setMode('all')}>Browse all practice</button>}</div>
      : <div className="kb-study-stack">
        <div className="kb-study-progress"><span>Card {idx+1} of {deck.items.length} in this round</span>
          <span>{done} reviewed</span></div>
        <div className="kb-study-card">
          <div className="kb-study-card-meta"><span>{card.cardType==='assessment'?'Lecturer self-assessment':'Generated practice'}</span>
            <span>{card.sectionKey?.split(':').slice(-1)[0]||'Source reading'}</span></div>
          <h3>{card.question}</h3>
          {practice==='assessment'&&!flipped && <label className="kb-study-answer-label">Your response
            <textarea aria-label="Your practice answer" value={written} onChange={e=>setWritten(e.target.value)}
              placeholder="Write your answer without looking at the notes, then reveal the guidance…" rows={6}/></label>}
          {!flipped ? <button className="kb-study-reveal" type="button" onClick={()=>setFlipped(true)}>Reveal answer guidance</button>
          : <section className="kb-study-reveal-area" aria-label="Answer guidance">
            <h4>Source-grounded guidance</h4><p>{card.expectedAnswer}</p>
            {card.explanation && <small>{card.explanation}</small>}
            {safe(card.sourceLink) && <a href={safe(card.sourceLink)} target="_blank" rel="noopener noreferrer">Read original chapter ↗</a>}
            <div className="kb-study-rate"><p>How well did you know this?</p>
              <div className="kb-study-rating-buttons">{ratings.map(r=><button type="button" key={r.value} disabled={saving}
                onClick={()=>grade(r.value)}><strong>{r.label}</strong><small>{r.sub}</small></button>)}</div>
              <small>Self-rating only. Your selection sets the next review date, not an exam grade.</small>
            </div>
          </section>}
        </div>
        <p className="kb-study-foot">These are independent revision exercises. Follow the course assessment rules during official tests.</p>
      </div>}
  </main>;
}
