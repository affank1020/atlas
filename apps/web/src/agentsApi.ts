import type { AgentRunView, AgentRunPage, AgentEventPage } from '@atlas/protocol/agent-jobs';
import { IS_MOCK_MODE } from './api';
export type { AgentRunView, AgentRunPage, AgentEventPage };
// The browser never receives the private ingress credential. Caddy authenticates the
// human, overwrites that header and proxies this namespace. Direct access fails closed.
export async function agentRequest<T>(action:'list'|'get'|'events'|'control',input:object,signal?:AbortSignal):Promise<T> {
    if(IS_MOCK_MODE) {
        if(action==='list') return {runs:[],next:null} as T;
        throw new Error('No execution data is available in frontend demo mode.');
    }
    const response=await fetch(`/api/agents/${action}`,{method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json'},body:JSON.stringify(input),
        signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
    const body=await response.json();
    if(!response.ok) throw new Error(body.message??(response.status===401?'Agents access requires the authenticated owner ingress.':response.status===503?'Agents monitoring is unavailable or not configured.':body.error??'Agents request failed.'));
    return body as T;
}
export const agentHref=(runId?:string,scope:Record<string,string>={})=>{
    const query=new URLSearchParams(runId?{...scope,run:runId}:scope).toString();
    return '#/applications/agents'+(query?'?'+query:'');
};
export function duration(start:string|null,end:string|null,now=Date.now()) {
    if(!start) return 'Not observed';
    const seconds=Math.max(0,Math.floor(((end?Date.parse(end):now)-Date.parse(start))/1000));
    return seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${seconds%60}s`;
}
