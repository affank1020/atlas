import type {ViewRenderResult} from './types.js';
import {installViewHost} from './view-host.js';
import {viewActionsCss,viewKitCss} from './view-kit.js';

/** Match Atlas Web's dark View tokens without changing saved View CSS or Kit v1. */
const standaloneTheme=`\n:root{color-scheme:dark;--atlas-bg:#15171c;--atlas-surface:#191c22;--atlas-border:#303540;--atlas-text:#eeede9;--atlas-muted:#b7becb;--atlas-accent:#a0b2ff;--atlas-success:#8dd8b0;--atlas-warning:#e9be79;--atlas-error:#f39c9b;--atlas-info:#9ecafa;--atlas-table-stripe:#111318;--atlas-radius:6px;--atlas-font:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--atlas-shadow:none}atlas-button>button{color:#15171c}[role=tab][aria-selected=true]{background:#455bbe}atlas-badge[tone=success]{background:#203a30}atlas-badge[tone=warning]{background:#3c3223}atlas-badge[tone=error]{background:#432a30}atlas-badge[tone=info]{background:#252f50}\n`;
/** The outer page owns networking; the exact same View document stays in an opaque iframe. */
export function standaloneViewPage(rendered:ViewRenderResult){
 const payload=JSON.stringify(rendered).replaceAll('<','\\u003c');
 const kit=JSON.stringify(viewKitCss+viewActionsCss).replaceAll('<','\\u003c');
 const theme=JSON.stringify(standaloneTheme).replaceAll('<','\\u003c');
 return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self' about:; connect-src 'self'; base-uri 'none'; form-action 'none'"><title>Atlas View</title><style>html,body{height:100%;margin:0;color-scheme:dark}body{display:flex;flex-direction:column;background:#15171c;color:#eeede9;font-family:system-ui}iframe{width:100%;flex:1;border:0;min-height:0}#error{padding:12px;background:#432a30;color:#f39c9b}#error[hidden]{display:none}</style></head><body><div id="error" role="alert" hidden></div><iframe id="view" title="Atlas View" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"></iframe><script>
const __name=(fn)=>fn;
const install=${installViewHost.toString()};
const kitCss=${kit};const themeCss=${theme};
const themedDocument=next=>next.manifest?.viewKitVersion===1&&next.document.includes(kitCss)?next.document.replace(kitCss,()=>kitCss+themeCss):next.document;
let rendered=${payload};let dispose=()=>{};
const frame=document.getElementById('view');const error=document.getElementById('error');
const fail=message=>{error.textContent=message;error.hidden=false};
const api=async(name,input)=>{const response=await fetch('/api/tools/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(result.message||'View request failed.');return result};
const refresh=async(params,scroll)=>{const next=await api('render_view',{projectId:rendered.view.projectId,viewId:rendered.view.id,params});mount(next,scroll)};
function mount(next,scroll){dispose();rendered=next;error.hidden=true;document.title=rendered.view.name;frame.title=rendered.view.name;frame.setAttribute('sandbox',rendered.manifest?'allow-scripts allow-popups allow-popups-to-escape-sandbox':'allow-popups allow-popups-to-escape-sandbox');
 const restoreScroll=scroll&&Number.isFinite(scroll.x)&&Number.isFinite(scroll.y)?()=>frame.contentWindow?.postMessage({type:'atlas-view-scroll',runtimeId:rendered.runtimeId,x:scroll.x,y:scroll.y},'*'):null;if(restoreScroll)frame.addEventListener('load',restoreScroll,{once:true});
 dispose=install({frame,runtimeId:rendered.runtimeId,params:rendered.manifest?.params||{},parameterCapability:!!rendered.manifest?.capabilities?.includes('url-params'),actionNames:(rendered.actions||[]).map(a=>a.name),actionsEnabled:!!rendered.manifest?.capabilities?.includes('record-actions'),onParam(key,value){const url=new URL(location.href);if(value===null)url.searchParams.delete(key);else url.searchParams.set(key,value);history.replaceState(null,'',url.pathname+url.search)},action(name,input){return api('execute_view_action',{projectId:rendered.view.projectId,viewId:rendered.view.id,action:name,input})},refresh,onError:fail});frame.srcdoc=themedDocument(rendered);
}
addEventListener('popstate',()=>refresh(Object.fromEntries(new URLSearchParams(location.search))).catch(e=>fail(e.message)));
mount(rendered);
</script></body></html>`;
}
