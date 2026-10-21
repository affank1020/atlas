import { useRouteTiming } from './performance';
import { useEffect, useMemo, useState } from "react";
import { API_BASE, callTool } from "./api";
import "./Portfolio.css";
import { useApplicationRead } from "./atlasApi";
const EMPTY: never[] = [];

type ContentType = "profile" | "contact" | "projects" | "experience" | "posts" | "collections";
type Field = { name:string; type:"string"|"number"|"boolean"|"date"|"datetime"|"enum"|"array"|"object"; enumValues?:string[]; description?:string };
type Schema = { contentType:ContentType; storeId:string; name:string; description?:string; fields:Field[] };
type Entry = { id:string; contentType:ContentType; storeId:string; data:Record<string,unknown>; status:"draft"|"published"|"changed"; createdAt:string; updatedAt:string; publishedAt?:string; publishedRevision?:number };
type Dashboard = { contentTypes:{contentType:ContentType;storeId:string;name:string;total:number;published:number;drafts:number}[];media:{active:number;bytes:number} };
type Media = { id:string;originalName:string;mimeType:string;byteSize:number;width?:number;height?:number;altText?:string;caption?:string;status:string;url:string;thumbnailUrl?:string;previewUrl?:string };
type Revision = {id:string;revision:number;createdBy:string;createdAt:string;published:boolean};

const TITLES:Record<ContentType,string>={profile:"Profile",contact:"Contact",projects:"Projects",experience:"Experience",posts:"Posts",collections:"Collections"};
const LONG_FIELDS=new Set(["description","summary","body","excerpt","note","tagline"]);
const MEDIA_FIELDS=new Set(["imageAssetId","heroAssetId","portraitAssetId","cvAssetId","galleryAssetIds","links","href","repositoryUrl","liveUrl"]);
const META_FIELDS=new Set(["slug","key","order","collectionId","section","placeholder","publishedAt"]);
const APPEARANCE_FIELDS=new Set(["showcase","accent"]);
const EXTRA_FIELDS=new Set(["year","role","outcomes","note"]);
const formatDate=(value:string)=>new Date(value).toLocaleDateString(undefined,{day:"numeric",month:"short",year:"numeric"});
const label=(value:string)=>value.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/^./,x=>x.toUpperCase());
const formatBytes=(value:number)=>value<1024?`${value} B`:value<1024*1024?`${(value/1024).toFixed(1)} KB`:`${(value/1024/1024).toFixed(1)} MB`;
const entryTitle=(entry:Entry)=>String(entry.data.title||entry.data.company||[entry.data.firstName,entry.data.lastName].filter(Boolean).join(" ")||entry.data.email||entry.data.key||"Untitled draft");

const getEntryMedia=(entry:Entry,assets:Media[])=>{
 const assetId=entry.data.imageAssetId??entry.data.heroAssetId??entry.data.portraitAssetId;
 const asset=assets.find(item=>item.id===assetId);
 const url=asset?.thumbnailUrl??asset?.previewUrl;
 return url?API_BASE+url:undefined;
};

export function Portfolio(){
 const schemaQuery=useApplicationRead<Schema[]>('get_portfolio_schemas'),entryQuery=useApplicationRead<Entry[]>('list_portfolio_entries'),dashboardQuery=useApplicationRead<Dashboard>('get_portfolio_dashboard'),mediaQuery=useApplicationRead<Media[]>('list_portfolio_media');
 const schemas=schemaQuery.data??EMPTY,entries=entryQuery.data??EMPTY,dashboard=dashboardQuery.data,media=mediaQuery.data??EMPTY;
 const [type,setType]=useState<ContentType>("projects"),[selectedId,setSelectedId]=useState<string>(),[draft,setDraft]=useState<Record<string,unknown>>({}),[view,setView]=useState<"content"|"media">(() => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("tab") === "media" ? "media" : "content");
 const [busy,setBusy]=useState(""),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [creating,setCreating]=useState(false),[search,setSearch]=useState("");
 const dirty=JSON.stringify(draft)!==JSON.stringify(selectedId?entries.find(entry=>entry.id===selectedId)?.data??{}:{});
 const leaveEditor=()=>!dirty||window.confirm("Discard unsaved changes? Your published content will not be affected.");
 useEffect(()=>{if(!dirty)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);},[dirty]);
 const load=async()=>{await Promise.all([schemaQuery.refetch(),entryQuery.refetch(),dashboardQuery.refetch(),mediaQuery.refetch(),...(selectedId?[revisionQuery.refetch()]:[])]);};
 const reloadMedia=async()=>{await Promise.all([dashboardQuery.refetch(),mediaQuery.refetch()]);};
 useRouteTiming("portfolio", "portfolio", !!schemaQuery.data && !!entryQuery.data && !!dashboardQuery.data && !!mediaQuery.data);
 const filtered=useMemo(()=>entries.filter(entry=>entry.contentType===type).sort((a,b)=>Number(a.data.order??999)-Number(b.data.order??999)||entryTitle(a).localeCompare(entryTitle(b))),[entries,type]);
 const visible=useMemo(()=>filtered.filter(entry=>entryTitle(entry).toLowerCase().includes(search.toLowerCase())),[filtered,search]);
 const selected=entries.find(entry=>entry.id===selectedId);
 const revisionQuery=useApplicationRead<Revision[]>("list_portfolio_revisions",{recordId:selectedId},false,!selectedId);const revisions=revisionQuery.data??EMPTY;
 useEffect(()=>{if(selected){setDraft(selected.data);}else{setDraft({});}},[selectedId,selected?.updatedAt]);
 useEffect(()=>{if(selectedId&&!filtered.some(x=>x.id===selectedId))setSelectedId(undefined);},[type,filtered,selectedId]);
 useEffect(()=>{if(!creating&&!selectedId&&filtered.length)setSelectedId(filtered[0].id);},[creating,selectedId,filtered]);
 const schema=schemas.find(item=>item.contentType===type);
 const run=async(name:string,action:()=>Promise<unknown>,message:string)=>{setBusy(name);setError("");setNotice("");try{await action();const refresh=await Promise.allSettled([entryQuery.refetch(),dashboardQuery.refetch(),revisionQuery.refetch()]);setNotice(refresh.some(result=>result.status==="rejected")?message+" Refresh to see the latest state.":message);return true;}catch(e){setError((e as Error).message);return false;}finally{setBusy("");}};
 const save=async()=>{setBusy("save");setError("");setNotice("");try{const entry=await callTool<Entry>("save_portfolio_draft",{contentType:type,recordId:selectedId,data:draft});setDraft(entry.data);setSelectedId(entry.id);setCreating(false);await Promise.allSettled([entryQuery.refetch(),dashboardQuery.refetch()]);setNotice("Draft saved. Publish when you're ready to make it live.");}catch(e){setError((e as Error).message);}finally{setBusy("");}};
 const change=(field:Field,value:unknown)=>setDraft(current=>({...current,[field.name]:value}));
 return <div className="portfolio-app">
  <header className="portfolio-head">
   <div className="portfolio-head-copy"><h1>Portfolio</h1><p>Manage the projects, experience and writing on your site.</p></div>
   <div className="portfolio-summary" aria-label="Portfolio overview">
    <span><b>{entries.filter(x=>x.status==="published").length}</b><small>Live entries</small></span>
    <span><b>{entries.filter(x=>x.status!=="published").length}</b><small>In progress</small></span>
    <span><b>{dashboard?.media.active??0}</b><small>Assets</small></span>
   </div>
  </header>
  <nav className="portfolio-tabs" aria-label="Portfolio sections">
   <div className="portfolio-tab-group"><button className={view==="content"?"active":""} aria-current={view==="content"?"page":undefined} onClick={()=>setView("content")}>Content</button><button className={view==="media"?"active":""} aria-current={view==="media"?"page":undefined} onClick={()=>{if(leaveEditor())setView("media");}}>Media library</button></div>
   <div className="portfolio-nav-actions"><a href="#/ask-portfolio">Ask Portfolio <span aria-hidden="true">↗</span></a><button className="portfolio-refresh" onClick={()=>void load()} disabled={!!busy||[schemaQuery,entryQuery,dashboardQuery,mediaQuery].some(q=>q.isFetching)} title="Fetch the latest portfolio content">↻ <span>Refresh</span></button></div>
  </nav>
  {[schemaQuery,entryQuery,dashboardQuery,mediaQuery].some(q=>q.isLoading)&&<p role="status" className="portfolio-loading">Loading portfolio…</p>}{[schemaQuery,entryQuery,dashboardQuery,mediaQuery].some(q=>q.error)&&<div role="alert" className="portfolio-notice error">Portfolio data unavailable. <button onClick={()=>void load()}>Retry</button></div>}{error&&<div role="alert" className="portfolio-notice error">{error}<button onClick={()=>setError("")} aria-label="Dismiss error">×</button></div>}
  {notice&&<div role="status" className="portfolio-notice success">{notice}<button onClick={()=>setNotice("")} aria-label="Dismiss message">×</button></div>}
  {view==="content"?<div className="portfolio-workspace">
   <aside className="portfolio-sidebar" aria-label="Content browser">
    <div className="portfolio-types" aria-label="Content types">
     {(Object.keys(TITLES) as ContentType[]).map(key=>{const counts=dashboard?.contentTypes.find(x=>x.contentType===key);return <button key={key} className={type===key?"active":""} aria-current={type===key?"page":undefined} onClick={()=>{if(type===key||leaveEditor()){setType(key);setCreating(false);setSelectedId(undefined);setSearch("");setNotice("");}}}><span>{TITLES[key]}</span><small>{counts?.total??0}</small></button>;})}
    </div>
    <div className="portfolio-list-head"><div><strong>{TITLES[type]}</strong><small>{filtered.length} {filtered.length===1?"entry":"entries"}</small></div><button className="portfolio-new" onClick={()=>{if(leaveEditor()){setCreating(true);setSelectedId(undefined);setDraft({});setError("");setNotice("");}}} aria-label={"New "+TITLES[type].toLowerCase()+" entry"}>+ New</button></div>
    <div className="portfolio-search"><span aria-hidden="true">⌕</span><input aria-label="Search entries" placeholder="Find an entry…" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button aria-label="Clear search" onClick={()=>setSearch("")}>×</button>}</div>
    <div className="portfolio-entry-list">
     {visible.map(entry=><button key={entry.id} className={"portfolio-entry "+(selectedId===entry.id&&!creating?"active":"")} onClick={()=>{if((entry.id===selectedId&&!creating)||leaveEditor()){setCreating(false);setSelectedId(entry.id);setError("");setNotice("");}}}><span className="portfolio-entry-thumb">{getEntryMedia(entry,media)?<img src={getEntryMedia(entry,media)??""} alt=""/>:<span>{entryTitle(entry).slice(0,1).toUpperCase()}</span>}</span><span className="portfolio-entry-copy"><b>{entryTitle(entry)}</b><small>{formatDate(entry.updatedAt)}</small></span><span className={"portfolio-status "+entry.status} title={entry.status}>{entry.status==="published"?"Live":entry.status==="changed"?"Edited":"Draft"}</span></button>)}
     {!visible.length&&<p className="portfolio-empty">{search?"No entries match your search.":"Nothing here yet. Create an entry to get started."}</p>}
    </div>
   </aside>
   <section className="portfolio-editor" aria-label="Content editor">
    {(selected||creating)?<>
     <div className="portfolio-editor-top"><div className="portfolio-editor-heading"><p className="eyebrow">{creating?"New "+TITLES[type].toLowerCase()+" entry":TITLES[type]}</p><h2>{creating?"Untitled "+TITLES[type].toLowerCase():entryTitle(selected!)}</h2><p>{creating?"Create a draft. Nothing goes live until you publish it.":"Last updated "+formatDate(selected!.updatedAt)}</p></div><div className="portfolio-editor-flags">{dirty&&<span className="portfolio-dirty">Unsaved changes</span>}{selected&&<span className={"portfolio-status "+selected.status}>{selected.status==="published"?"Published":selected.status==="changed"?"Unpublished edits":"Draft"}</span>}</div></div>
     <div className="portfolio-editor-content">
      <section className="portfolio-section"><div className="portfolio-section-intro"><h3>Content</h3></div><div className="portfolio-form">{schema?.fields.filter(field=>!MEDIA_FIELDS.has(field.name)&&!META_FIELDS.has(field.name)&&!APPEARANCE_FIELDS.has(field.name)&&!EXTRA_FIELDS.has(field.name)).map(field=><EditorField key={(selectedId??"new")+field.name} field={field} value={draft[field.name]} media={media} onChange={value=>change(field,value)}/>)}</div></section>
      {schema?.fields.some(field=>EXTRA_FIELDS.has(field.name))&&<details className="portfolio-section portfolio-fold"><summary><span><b>More details</b><small>Optional fields and additional context</small></span><span className="portfolio-chevron" aria-hidden="true">⌄</span></summary><div className="portfolio-form">{schema.fields.filter(field=>EXTRA_FIELDS.has(field.name)).map(field=><EditorField key={(selectedId??"new")+field.name} field={field} value={draft[field.name]} media={media} onChange={value=>change(field,value)}/>)}</div></details>}
      {schema?.fields.some(field=>MEDIA_FIELDS.has(field.name))&&<details className="portfolio-section portfolio-fold"><summary><span><b>Links &amp; media</b><small>External links and images</small></span><span className="portfolio-chevron" aria-hidden="true">⌄</span></summary><div className="portfolio-form">{schema.fields.filter(field=>MEDIA_FIELDS.has(field.name)).map(field=><EditorField key={(selectedId??"new")+field.name} field={field} value={draft[field.name]} media={media} onChange={value=>change(field,value)}/>)}</div></details>}
      {schema?.fields.some(field=>APPEARANCE_FIELDS.has(field.name))&&<details className="portfolio-section portfolio-fold"><summary><span><b>Appearance</b><small>Optional per-entry colours and visual atmosphere</small></span><span className="portfolio-chevron" aria-hidden="true">⌄</span></summary><div className="portfolio-form">{schema.fields.filter(field=>APPEARANCE_FIELDS.has(field.name)).map(field=><EditorField key={(selectedId??"new")+field.name} field={field} value={draft[field.name]} media={media} onChange={value=>change(field,value)}/>)}</div></details>}
      {schema?.fields.some(field=>META_FIELDS.has(field.name))&&<details className="portfolio-section portfolio-fold"><summary><span><b>Metadata</b><small>URL, order and organisation</small></span><span className="portfolio-chevron" aria-hidden="true">⌄</span></summary><div className="portfolio-form">{schema.fields.filter(field=>META_FIELDS.has(field.name)).map(field=><EditorField key={(selectedId??"new")+field.name} field={field} value={draft[field.name]} media={media} onChange={value=>change(field,value)}/>)}</div></details>}
      {selected&&<details className="portfolio-section portfolio-fold portfolio-history"><summary><span><b>Version history</b><small>{revisions.length} saved {revisions.length===1?"revision":"revisions"}</small></span><span className="portfolio-chevron" aria-hidden="true">⌄</span></summary><div className="portfolio-revisions">{revisions.map(revision=><div key={revision.id}><span><b>Revision {revision.revision}</b><small>{new Date(revision.createdAt).toLocaleString()} · {revision.createdBy}</small></span>{revision.published?<i>Live</i>:<button className="link" disabled={!!busy} onClick={()=>{if(leaveEditor())void run("restore",()=>callTool("restore_portfolio_revision",{recordId:selected.id,revisionId:revision.id}),"Revision "+revision.revision+" restored to draft.");}}>Restore</button>}</div>)}{!revisions.length&&<p className="portfolio-empty">No earlier revisions.</p>}</div></details>}
     </div>
     <div className="portfolio-editor-actions">
      {selected&&<button className="portfolio-danger-link" disabled={!!busy} onClick={()=>{if(window.confirm("Archive this entry? It will no longer appear in the active library."))void run("archive",()=>callTool("archive_portfolio_entry",{recordId:selected.id}),"Entry archived.").then(ok=>{if(ok){setSelectedId(undefined);setCreating(false);}});}}>Archive</button>}
      {selected&&selected.status!=="draft"&&<button className="portfolio-subtle-button" disabled={!!busy||dirty} title={dirty?"Save or discard changes first":undefined} onClick={()=>void run("unpublish",()=>callTool("unpublish_portfolio_entry",{recordId:selected.id}),"Entry unpublished; the draft remains available.")}>Unpublish</button>}
      <span className="portfolio-actions-space"/>
      <button className={dirty?"portfolio-primary-button":"portfolio-subtle-button"} disabled={!!busy||!dirty} onClick={()=>void save()}>{busy==="save"?"Saving…":selected?"Save changes":"Save draft"}</button>
      {selected?.status==="published"?<span className="portfolio-action-live">● Live on site</span>:<button className="portfolio-primary-button" disabled={!selected||!!busy||dirty} title={dirty?"Save your changes before publishing":undefined} onClick={()=>selected&&void run("publish",()=>callTool("publish_portfolio_entry",{recordId:selected.id}),"Your latest revision is now live.")}>{busy==="publish"?"Publishing…":"Publish"}</button>}
     </div>
    </>:<div className="portfolio-editor-placeholder"><div className="portfolio-placeholder-icon">✦</div><h2>Choose something to edit</h2><p>Select an entry from the library, or create a new one.</p><button className="portfolio-primary-button" onClick={()=>{setCreating(true);setDraft({});}}>Create entry</button></div>}
   </section>
  </div>:<MediaLibrary media={media} busy={busy} setBusy={setBusy} setError={setError} setNotice={setNotice} reload={reloadMedia}/>}
 </div>;
}

function EditorField({field,value,media,onChange}:{field:Field;value:unknown;media:Media[];onChange:(value:unknown)=>void}){
 if(field.name==="showcase")return <ShowcaseEditor value={value} media={media} onChange={onChange}/>;
 if(field.name==="links")return <LinkField value={value} onChange={onChange}/>;
 if(field.name==="galleryAssetIds")return <GalleryField value={value} media={media} onChange={onChange}/>;
 const asset=field.name.endsWith("AssetId");
 if(asset){
  const item=media.find(x=>x.id===value);
   const available=media.filter(x=>x.status==="active"&&(field.name==="cvAssetId"?x.mimeType==="application/pdf":x.mimeType.startsWith("image/")));
  return <div className="portfolio-field portfolio-wide-field"><label htmlFor={"portfolio-"+field.name}>{label(field.name.replace(/AssetId$/,""))}</label><div className="portfolio-asset-picker">{item&&<div className="portfolio-asset-preview">{item.thumbnailUrl?<img src={API_BASE+item.thumbnailUrl} alt={item.altText||item.originalName}/>:<span>PDF</span>}</div>}<select id={"portfolio-"+field.name} value={String(value??"")} onChange={e=>onChange(e.target.value)}><option value="">No asset selected</option>{available.map(asset=><option key={asset.id} value={asset.id}>{asset.altText||asset.originalName}{asset.altText?" — "+asset.originalName:""}</option>)}</select></div>{item&&<small className="portfolio-field-hint">{formatBytes(item.byteSize)} · {item.mimeType}</small>}</div>;
 }
 if(field.type==="boolean")return <label className="portfolio-check"><input type="checkbox" checked={Boolean(value)} onChange={e=>onChange(e.target.checked)}/><span>{label(field.name)}</span></label>;
 if(field.type==="enum")return <label className="portfolio-field">{label(field.name)}<select value={String(value??"")} onChange={e=>onChange(e.target.value)}><option value="">Select…</option>{field.enumValues?.map(option=><option key={option}>{option}</option>)}</select></label>;
 if(field.type==="array"&&["tags","outcomes","highlights"].includes(field.name))return <PillField name={field.name} value={value} onChange={onChange}/>;
 if(field.type==="array"||field.type==="object")return <JsonField name={field.name} value={value} type={field.type} onChange={onChange}/>;
 if(LONG_FIELDS.has(field.name))return <label className="portfolio-field portfolio-wide-field">{label(field.name)}<textarea className={field.name==="body"?"portfolio-body":""} rows={field.name==="body"?12:field.name==="description"?5:3} value={String(value??"")} onChange={e=>onChange(e.target.value)} placeholder={field.name==="body"?"Write your content here…":undefined}/>{field.name==="body"&&<small className="portfolio-field-hint">Markdown supported</small>}</label>;
 const dateValue=field.type==="datetime"&&value?String(value).slice(0,16):String(value??"");
 return <label className="portfolio-field">{label(field.name)}<input type={field.type==="number"?"number":field.type==="datetime"?"datetime-local":/Url$|^href$/.test(field.name)?"url":"text"} value={dateValue} onChange={e=>onChange(field.type==="number"?(e.target.value===""?undefined:Number(e.target.value)):field.type==="datetime"&&e.target.value?new Date(e.target.value).toISOString():e.target.value)}/></label>;
}

function PillField({name,value,onChange}:{name:string;value:unknown;onChange:(value:unknown)=>void}){
 const [input,setInput]=useState("");
 const items=Array.isArray(value)?value.filter((x):x is string=>typeof x==="string"):[];
 const add=()=>{const next=input.trim();if(next&&!items.includes(next))onChange([...items,next]);setInput("");};
 return <div className="portfolio-field portfolio-wide-field"><label htmlFor={"portfolio-add-"+name}>{label(name)}</label><div className="portfolio-pills">{items.map((item,i)=><span key={i} className="portfolio-pill">{item}<button type="button" aria-label={"Remove "+item} onClick={()=>onChange(items.filter((_,index)=>index!==i))}>×</button></span>)}<input id={"portfolio-add-"+name} value={input} placeholder={items.length?"Add another…":"Type and press Enter…"} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"||e.key===","){e.preventDefault();add();}}} onBlur={add}/></div><small className="portfolio-field-hint">Press Enter to add an item.</small></div>;
}

function LinkField({value,onChange}:{value:unknown;onChange:(value:unknown)=>void}){
 const links=Array.isArray(value)?value.filter((item):item is {label:string;url:string}=>!!item&&typeof item==="object"&&!Array.isArray(item)):[];
 const edit=(index:number,key:"label"|"url",text:string)=>onChange(links.map((item,i)=>i===index?{...item,[key]:text}:item));
 return <div className="portfolio-field portfolio-wide-field"><label>Additional links</label><div className="portfolio-link-list">{links.map((item,i)=><div key={i} className="portfolio-link-row"><input aria-label={"Link "+(i+1)+" label"} placeholder="Label" value={item.label??""} onChange={e=>edit(i,"label",e.target.value)}/><input aria-label={"Link "+(i+1)+" URL"} type="url" placeholder="https://…" value={item.url??""} onChange={e=>edit(i,"url",e.target.value)}/><button type="button" aria-label={"Remove link "+(i+1)} onClick={()=>onChange(links.filter((_,index)=>index!==i))}>×</button></div>)}</div><button type="button" className="portfolio-add-inline" onClick={()=>onChange([...links,{label:"",url:""}])}>+ Add link</button></div>;
}

function GalleryField({value,media,onChange}:{value:unknown;media:Media[];onChange:(value:unknown)=>void}){
 const ids=Array.isArray(value)?value.filter((id):id is string=>typeof id==="string"):[];
 const active=media.filter(x=>x.status==="active"&&x.mimeType.startsWith("image/"));
 return <div className="portfolio-field portfolio-wide-field"><label htmlFor="portfolio-gallery-add">Gallery images</label>{ids.length>0&&<div className="portfolio-gallery-selection">{ids.map((id,i)=>{const item=media.find(x=>x.id===id);return <div className="portfolio-gallery-thumb" key={id+"-"+i}>{item?.thumbnailUrl?<img src={API_BASE+item.thumbnailUrl} alt={item.altText||item.originalName}/>:<span>Missing image</span>}<button type="button" title="Remove image" aria-label={"Remove "+(item?.originalName??"image")} onClick={()=>onChange(ids.filter((_,index)=>index!==i))}>×</button></div>})}</div>}<select id="portfolio-gallery-add" value="" onChange={e=>{if(e.target.value)onChange([...ids,e.target.value]);}}><option value="">+ Add an image</option>{active.filter(x=>!ids.includes(x.id)).map(item=><option key={item.id} value={item.id}>{item.originalName}</option>)}</select><small className="portfolio-field-hint">Images appear in this order on your site.</small></div>;
}

function JsonField({name,value,type,onChange}:{name:string;value:unknown;type:"array"|"object";onChange:(value:unknown)=>void}){
 const [raw,setRaw]=useState(()=>value===undefined?"":JSON.stringify(value,null,2));
 const [invalid,setInvalid]=useState(false);
 return <label className="portfolio-field portfolio-wide-field">{label(name)}<textarea value={raw} onChange={e=>{setRaw(e.target.value);try{onChange(JSON.parse(e.target.value||(type==="array"?"[]":"{}")));setInvalid(false);}catch{setInvalid(true);}}}/><small className={invalid?"portfolio-field-error":"portfolio-field-hint"}>{invalid?"Invalid JSON — fix this before saving.":"Advanced JSON "+type}</small></label>;
}

const SHOWCASE_PRESETS = {
 layout:["media-led","editorial","immersive","minimal"],
 motif:["none","grid","lines","geometric"],
 motionStyle:["none","subtle","ambient"],
 mediaFit:["contain","cover"],
 mediaPosition:["center","top","bottom","left","right"],
} as const;
function ShowcaseEditor({value,media,onChange}:{value:unknown;media:Media[];onChange:(value:unknown)=>void}){
 const config=value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
 const update=(key:string,next:string)=>{const changed={...config};if(next)changed[key]=next;else delete changed[key];onChange(changed);};
 return <fieldset className="portfolio-showcase-editor"><legend>Visual settings</legend>
 <div className="portfolio-showcase-fields">
 {(["accentColor","secondaryAccentColor","backgroundColor","ambientColor"] as const).map(key=><label key={key}>{label(key)}<div className="portfolio-color-control"><input aria-label={label(key)+" picker"} type="color" value={/^#[0-9a-f]{6}$/i.test(String(config[key]??""))?String(config[key]):"#626a7b"} onChange={e=>update(key,e.target.value)}/><input aria-label={label(key)+" hex value"} value={String(config[key]??"")} placeholder="Default" onChange={e=>update(key,e.target.value)}/></div></label>)}
 {Object.entries(SHOWCASE_PRESETS).map(([key,values])=><label key={key}>{label(key)}<select value={String(config[key]??"")} onChange={e=>update(key,e.target.value)}><option value="">Default</option>{values.map(option=><option key={option} value={option}>{label(option)}</option>)}</select></label>)}
 {(["artworkAssetId","backgroundAssetId"] as const).map(key=><label key={key}>{label(key.replace("AssetId",""))}<select value={String(config[key]??"")} onChange={e=>update(key,e.target.value)}><option value="">No image</option>{media.filter(asset=>asset.status==="active"&&asset.mimeType.startsWith("image/")).map(asset=><option key={asset.id} value={asset.id}>{asset.originalName}{asset.altText?` — ${asset.altText}`:""}</option>)}</select></label>)}
 </div></fieldset>;
}

type QueuedMedia = {
 id:string; file:File; altText:string; caption:string;
 state:"ready"|"uploading"|"uploaded"|"failed"|"invalid"; error?:string;
};
const ACCEPTED_MEDIA_TYPES=new Set(["image/jpeg","image/png","image/webp","image/gif","image/avif","application/pdf"]);
const MAX_MEDIA_SIZE=25*1024*1024;
const readMediaBase64=(file:File)=>new Promise<string>((resolve,reject)=>{
 const reader=new FileReader();
 reader.onload=()=>resolve(String(reader.result).split(",")[1]??"");
 reader.onerror=()=>reject(reader.error??new Error("Could not read file."));
 reader.readAsDataURL(file);
});

export function MediaLibrary({media,busy,setBusy,setError,setNotice,reload}:{media:Media[];busy:string;setBusy:(x:string)=>void;setError:(x:string)=>void;setNotice:(x:string)=>void;reload:()=>Promise<void>}){
 const [queue,setQueue]=useState<QueuedMedia[]>([]);
 const [uploadOpen,setUploadOpen]=useState(false),[search,setSearch]=useState(""),[showArchived,setShowArchived]=useState(false);
 const uploading=busy==="upload";
 const pending=queue.filter(item=>item.state==="ready"||item.state==="failed");
 const completed=queue.filter(item=>item.state==="uploaded"||item.state==="failed"||item.state==="invalid").length;
 const filtered=media.filter(asset=>(showArchived||asset.status==="active")&&(asset.originalName+" "+(asset.altText??"")+" "+(asset.caption??"")).toLowerCase().includes(search.toLowerCase()));
 const selectFiles=(files:FileList|null)=>{
  if(!files)return;
  setQueue(Array.from(files).map((file,index)=>{
   const error=!ACCEPTED_MEDIA_TYPES.has(file.type)?"Unsupported file type.":file.size===0?"File is empty.":file.size>MAX_MEDIA_SIZE?"Maximum file size is 25 MB.":undefined;
   return {id:String(index)+"-"+file.name+"-"+file.lastModified,file,altText:"",caption:"",state:error?"invalid" as const:"ready" as const,error};
  }));
 };
 const editItem=(id:string,values:Partial<QueuedMedia>)=>setQueue(current=>current.map(item=>item.id===id?{...item,...values}:item));
 const upload=async(e:React.FormEvent)=>{
  e.preventDefault();
  if(busy||!pending.length)return;
  setBusy("upload");setError("");setNotice("");
  let uploaded=0;
  const failed:string[]=[];
  for(const item of pending){
   editItem(item.id,{state:"uploading",error:undefined});
   try{
    const base64=await readMediaBase64(item.file);
    await callTool("upload_portfolio_media",{fileName:item.file.name,mimeType:item.file.type,base64,altText:item.altText,caption:item.caption});
    uploaded++;
    editItem(item.id,{state:"uploaded"});
   }catch(error){
    const message=error instanceof Error?error.message:"Upload failed";
    failed.push(item.file.name);
    editItem(item.id,{state:"failed",error:message});
   }
  }
  let refreshed=true;
  try{await reload();}catch{refreshed=false;}
  const invalid=queue.filter(item=>item.state==="invalid").length;
  if(!failed.length&&!invalid){
   setNotice((queue.length===1?"Asset":"All "+queue.length+" assets")+" uploaded successfully."+(refreshed?"":" Refresh to see the latest media."));
   setQueue([]);setUploadOpen(false);
  }else{
   setNotice(uploaded+" uploaded, "+failed.length+" failed"+(invalid?", "+invalid+" invalid":"")+". "+(failed.length?"Retry failed files below.":"Choose valid files to continue.")+(refreshed?"":" Refresh to see the latest media."));
  }
  setBusy("");
 };
 const update=async(asset:Media,values:Record<string,unknown>)=>{setBusy(asset.id);setError("");try{await callTool("update_portfolio_media",{assetId:asset.id,...values});await reload();setNotice("Asset updated.");}catch(e){setError((e as Error).message);}finally{setBusy("");}};
 return <section className="portfolio-media">
  <header className="portfolio-media-header"><div><p className="eyebrow">Asset manager</p><h2>Media library</h2><p>Images, documents and artwork used throughout your portfolio.</p></div><button type="button" className="portfolio-primary-button" disabled={uploading} onClick={()=>setUploadOpen(current=>!current)}>{uploadOpen?"Close upload":"+ Upload media"}</button></header>
  {uploadOpen&&<form className="portfolio-upload" onSubmit={upload}>
   <div><h2>Upload media</h2><p>Choose one or several images (or PDFs). Originals stay in Atlas storage and images receive optimised previews. Max 25 MB per file.</p></div>
   <label>Choose files<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif,application/pdf" multiple disabled={uploading} onChange={e=>selectFiles(e.currentTarget.files)}/></label>
   {queue.length>0&&<div className="portfolio-upload-queue">
    <div className="portfolio-upload-queue-header"><strong>{queue.length} {queue.length===1?"file":"files"} selected</strong><span aria-live="polite">{uploading?"Uploading":completed===queue.length?"Finished":"Ready"} · {completed}/{queue.length}</span></div>
    <progress className="portfolio-upload-progress" aria-label="Media upload progress" max={queue.length} value={completed}/>
    {queue.map(item=><div className="portfolio-upload-item" key={item.id}>
     <div className="portfolio-upload-item-header"><div><b title={item.file.name}>{item.file.name}</b><small>{formatBytes(item.file.size)}</small></div><span className={"portfolio-upload-state "+item.state}>{item.state==="ready"?"Ready":item.state==="uploading"?"Uploading…":item.state==="uploaded"?"Uploaded":item.state==="invalid"?"Invalid":"Failed"}</span></div>
     {item.error&&<small className="portfolio-upload-error" role="alert">{item.error}</small>}
     {item.state!=="invalid"&&<div className="portfolio-upload-item-fields">
      <label>Alt text<input type="text" aria-label={"Alt text for "+item.file.name} value={item.altText} placeholder="Describe this image" disabled={item.state==="uploaded"||uploading} onChange={e=>editItem(item.id,{altText:e.target.value})}/></label>
      <label>Caption (optional)<input type="text" aria-label={"Caption for "+item.file.name} value={item.caption} placeholder="Optional caption" disabled={item.state==="uploaded"||uploading} onChange={e=>editItem(item.id,{caption:e.target.value})}/></label>
     </div>}
    </div>)}
    <p className="portfolio-upload-hint">Images need alt text before being assigned to a project. You can fill it in here or edit the asset later.</p>
   </div>}
   <button type="submit" disabled={!!busy||!pending.length}>{uploading?"Uploading "+(queue.filter(item=>item.state==="uploaded").length+1)+" / "+queue.length+"…":pending.some(item=>item.state==="failed")?"Retry "+pending.length+" "+(pending.length===1?"file":"files"):"Upload "+pending.length+" "+(pending.length===1?"file":"files")}</button>
  </form>}
  <div className="portfolio-media-toolbar"><div className="portfolio-media-search"><span aria-hidden="true">⌕</span><input aria-label="Search media" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search assets…"/></div><label className="portfolio-show-archived"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/> Show archived</label><span className="portfolio-media-count">{filtered.length} {filtered.length===1?"asset":"assets"}</span></div>
  <div className="portfolio-media-grid">{filtered.map(asset=><article key={asset.id} className={asset.status==="archived"?"archived":""}><div className="portfolio-media-preview">{asset.thumbnailUrl?<img src={API_BASE+asset.thumbnailUrl} alt={asset.altText||asset.originalName}/>:<div className="portfolio-pdf">PDF</div>}</div><div className="portfolio-media-card-content"><b title={asset.originalName}>{asset.originalName}</b><small>{formatBytes(asset.byteSize)}{asset.width?" · "+asset.width+" × "+asset.height:""}</small><div className="portfolio-media-card-actions"><a href={API_BASE+asset.url} target="_blank" rel="noreferrer">View original ↗</a><button className="link danger" disabled={busy===asset.id} onClick={()=>void update(asset,{status:asset.status==="active"?"archived":"active"})}>{asset.status==="active"?"Archive":"Restore"}</button></div><details className="portfolio-media-details"><summary>Edit details</summary><label>Alt text<input defaultValue={asset.altText??""} key={asset.id+"alt"+asset.altText} onBlur={e=>{if(e.target.value!==(asset.altText??""))void update(asset,{altText:e.target.value});}}/></label><label>Caption<input defaultValue={asset.caption??""} key={asset.id+"caption"+asset.caption} onBlur={e=>{if(e.target.value!==(asset.caption??""))void update(asset,{caption:e.target.value});}}/></label></details></div></article>)}</div>
  {!filtered.length&&<p className="portfolio-empty">{search?"No matching assets.":"No assets to show."}</p>}
 </section>;
}
