import { createHash } from 'node:crypto';
import type { ViewManifest, ViewAction } from './types.js';
import { viewKitCss, viewKitScript, viewActionsCss, viewActionsScript, viewLinksCss } from './view-kit.js';

const json=(value:unknown)=>JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
export function viewDocument(input:{runtimeId?:string;actions?:ViewAction[];html:string;css:string;script?:string;manifest?:ViewManifest;data:unknown;params:Record<string,string>}) {
    const payload=json(JSON.stringify({runtimeId:input.runtimeId??'',actions:input.actions?.map(a=>a.name)??[],data:input.data,params:input.params,layout:input.manifest?.layout,allowed:input.manifest?.capabilities?.includes('url-params')?Object.keys(input.manifest.params??{}):[]}));
    const bootstrap=String.raw`(() => {
'use strict';
const state=JSON.parse(PAYLOAD);
document.addEventListener('click',event=>{const link=event.target instanceof Element?event.target.closest('a[href]'):null;if(link&&!event.isTrusted)event.preventDefault()},true);
if(state.layout)document.querySelectorAll('atlas-page').forEach(page=>page.setAttribute('layout',state.layout));
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x)}return x};
const params={...state.params};
const pending=new Map();let sequence=0;
const request=(method,details={})=>new Promise((resolve,reject)=>{const requestId=String(++sequence);const timeout=setTimeout(()=>{pending.delete(requestId);reject(new Error('View operation timed out. Refresh to inspect Core before retrying a write.'))},30000);pending.set(requestId,{resolve,reject,timeout});send({type:'atlas-view-request',runtimeId:state.runtimeId,requestId,method,...details},'*')});
addEventListener('message',event=>{const message=event.data;if(event.source!==parent||!message||message.type!=='atlas-view-response'||message.runtimeId!==state.runtimeId)return;const entry=pending.get(message.requestId);if(!entry)return;clearTimeout(entry.timeout);pending.delete(message.requestId);if(message.ok)entry.resolve(message.result);else entry.reject(new Error(message.error||'View operation failed.'))});
const send=parent.postMessage.bind(parent);
const showError=message=>{let e=document.getElementById('atlas-runtime-error');if(!e){e=document.createElement('div');e.id='atlas-runtime-error';e.setAttribute('role','alert');e.style.cssText='padding:16px;background:#ffe8e8;color:#a52e35';document.body.prepend(e)}e.textContent='View script: '+message};
addEventListener('error',event=>showError(event.message));addEventListener('unhandledrejection',()=>showError('An interaction failed.'));
const api=Object.freeze({data:freeze(state.data),get params(){return Object.freeze({...params})},onReady(fn){if(typeof fn!=='function')throw new Error('onReady expects a function');if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fn,{once:true});else fn()},setParam(key,value){if(!state.allowed.includes(key))throw new Error('Undeclared View parameter: '+key);if(value!==null&&(typeof value!=='string'||value.length>500))throw new Error('Parameter values must be strings up to 500 characters, or null');if(value===null)delete params[key];else params[key]=value;send({type:'atlas-view-param',runtimeId:state.runtimeId,key,value},'*')},action(name,input={}){if(!state.actions.includes(name))return Promise.reject(new Error('Undeclared View action: '+name));return request('action',{name,input})},refresh(){return request('refresh',{params:{...params}})},toast(message,tone='success'){let region=document.getElementById('atlas-toasts');if(!region){region=document.createElement('div');region.id='atlas-toasts';document.body.append(region)}const item=document.createElement('atlas-toast');item.setAttribute('tone',tone==='error'?'error':'success');item.textContent=String(message);region.append(item);setTimeout(()=>item.remove(),6000)}});
Object.defineProperty(globalThis,'atlas',{value:api,writable:false,configurable:false});
})();`.replace('PAYLOAD',payload);
    const scripts=input.manifest?[bootstrap,...(input.manifest?.viewKitVersion===1?[viewKitScript,viewActionsScript]:[]),...(input.script?.trim()?[`(() => {\n'use strict';\n${input.script}\n})();`]:[])]:[];
    // Hash only Atlas's boot code and the separately validated saved script. No inline handlers/eval/imports.
    const hashes=scripts.map(s=>`'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' ');
    const csp=`default-src 'none'; script-src ${hashes||"'none'"}; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}${input.manifest?.viewKitVersion===1?viewKitCss+viewActionsCss+viewLinksCss:''}\n${input.css}</style></head><body>${input.html}${scripts.map(s=>`<script>${s}</script>`).join('')}</body></html>`;
}
