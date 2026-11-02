import type {IncomingMessage,ServerResponse} from 'node:http';
import { agentSchemas, type AgentTool } from '@atlas/protocol/agent-jobs';
import { ZodError } from 'zod';
import { AtlasError } from '../../shared/errors.js';
import type { ServerServices } from '../../server/composition.js';
import { verifyRelayServiceToken } from '../mcp/oauth.js';

const operations:Record<string,AgentTool>={list:'agent_list',get:'agent_get',events:'agent_events',control:'agent_control'};
/** The single-owner Caddy Basic Auth boundary explicitly maps to the OAuth owner.
 * The proxy overwrites this credential; a client-supplied identity is never trusted.
 * Disabled unless separately opted in. No start/grant operation exists here. */
export async function serveAgentsRequest(req:IncomingMessage,res:ServerResponse,services:ServerServices) {
    if(!req.url?.startsWith('/api/agents/')) return false;
    const send=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
    const {config}=services;
    if(!config.agentsWeb.tokenHash || !config.mcpAuth.enabled || !config.mcpAuth.trustedIngress) {send(503,{error:'AGENTS_WEB_DISABLED'});return true;}
    const credential=req.headers['x-atlas-agents-ingress'];
    if(typeof credential!=='string'||!verifyRelayServiceToken(credential,config.agentsWeb.tokenHash)) {send(401,{error:'AGENTS_WEB_UNAUTHORIZED'});return true;}
    const origin=req.headers.origin;
    if(origin==='null'||(origin&&!config.workspace.origins.includes(origin))||req.headers['sec-fetch-site']==='cross-site') {send(403,{error:'ORIGIN_DENIED'});return true;}
    const action=req.url.slice('/api/agents/'.length);
    const operation=Object.hasOwn(operations,action)?operations[action]:undefined;
    if(!operation) {send(404,{error:'NOT_FOUND'});return true;}
    // Mutating browser requests must prove their Origin even with cached Basic Auth.
    if(operation==='agent_control'&&!origin) {send(403,{error:'ORIGIN_REQUIRED'});return true;}
    if(req.method!=='POST') {send(405,{error:'METHOD_NOT_ALLOWED'});return true;}
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')) {send(415,{error:'JSON_REQUIRED'});return true;}
    try {
        const chunks:Buffer[]=[];let bytes=0;
        for await(const chunk of req) {bytes+=chunk.length;if(bytes>4096) {send(413,{error:'REQUEST_TOO_LARGE'});return true;}chunks.push(Buffer.from(chunk));}
        const input=agentSchemas[operation].parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const value=await services.dispatch(operation,input,'atlas-http',{kind:'mcp-oauth',issuer:config.mcpAuth.issuer,subject:config.mcpAuth.subject});
        send(200,value);
    } catch(error) {
        if(error instanceof AtlasError) send(error.code==='AGENT_DENIED'?404:400,{error:error.code,message:error.message});
        else if(error instanceof ZodError || error instanceof SyntaxError) send(400,{error:'INVALID_REQUEST',message:'Invalid Agents request.'});
        else send(503,{error:'AGENTS_UNAVAILABLE',message:'Agents are temporarily unavailable.'});
    }
    return true;
}
