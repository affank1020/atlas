import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { agentAckSchema, agentCommandSchema, agentReceiptSchema, agentEventSchema, modelProfileSchema,
    agentReportSchema, type AgentCommand, type AgentReport } from '@atlas/protocol/agent-jobs';
import type { PiWorkers, PiReceipt, PiEvent } from '@atlas/protocol/pi-worker';
import type { Workspace } from '@atlas/protocol/workspace';
import { WorkspaceFiles } from '../workspace-files/files.js';
import { PiWorkerSupervisor } from './supervisor.js';

export const agentPolicySchema = z.object({
    nodeId:z.string().uuid(),
    checkouts:z.array(z.object({id:z.string().uuid(),rootPath:z.string().startsWith('/')}).strict()).min(1).max(64),
    profiles:z.array(modelProfileSchema).min(1).max(16),
}).strict().superRefine((policy,ctx)=>{
    if(new Set(policy.profiles.map(x=>x.id)).size!==policy.profiles.length ||
        new Set(policy.checkouts.map(x=>x.id)).size!==policy.checkouts.length)
        ctx.addIssue({code:'custom',message:'Agent policy IDs must be unique.'});
});
export type AgentPolicy = z.infer<typeof agentPolicySchema>;
const fingerprint = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const claimSchema = z.object({ token:z.string().uuid(), workspaceId:z.string().uuid(),
    fingerprint:z.string(), profile:modelProfileSchema }).strict();
const savedSchema = z.object({ receipt:agentReceiptSchema, events:z.array(agentEventSchema).max(256) }).strict();
type Attempt = { command:AgentCommand; workspace?:Workspace; status:AgentReport['status']; receipt?:PiReceipt;
    savedEvents?:PiEvent[]; after:number; lastSent:number; done:boolean; persisted:boolean; cancelRequested?:boolean };
/** A trusted local policy, not a Server-provided path, enables remote read-only starts. */
export class AgentNodeHost {
    private readonly attempts = new Map<string,Attempt>();
    private readonly workers:PiWorkers;
    private closed=false;
    constructor(private policy:AgentPolicy, private stateDirectory:string, files:WorkspaceFiles, workers?:PiWorkers) {
        this.policy=agentPolicySchema.parse(policy);
        this.workers=workers??new PiWorkerSupervisor(this.policy.nodeId,files,[],{
            profiles:this.policy.profiles,
            approve:(workspace,input)=>{
                if (!this.allowed(workspace.id,workspace.rootPath) || !this.policy.profiles.some(x=>x.id===input.modelProfile))
                    throw new Error('Local agent policy denied.');
                return {runId:input.runId,workspaceId:workspace.id,nodeId:this.policy.nodeId,rootPath:workspace.rootPath,
                    head:input.expectedHead,branch:input.expectedBranch,modelProfile:input.modelProfile,
                    promptSha256:createHash('sha256').update(input.prompt).digest('hex'),timeoutMs:input.timeoutMs,
                    expiresAt:new Date(Date.now()+60_000).toISOString()};
            },
        });
    }
    private allowed(id:string,root:string) { return this.policy.checkouts.some(x=>x.id===id&&x.rootPath===root); }
    private async directory() {
        await mkdir(this.stateDirectory,{recursive:true,mode:0o700});
        const stat=await lstat(this.stateDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode&0o077)!==0 || stat.uid!==process.getuid?.())
            throw new Error('Agent journal requires a private local directory.');
        if ((await readdir(this.stateDirectory)).length>256) throw new Error('Agent journal needs operator retention.');
    }
    async handle(raw:AgentCommand) {
        const command=agentCommandSchema.parse(raw);
        if(this.closed) return;
        const existing=this.attempts.get(command.runId);
        if(existing) {
            if(existing.command.token!==command.token) return;
            if(command.action==='start' && fingerprint(command)!==fingerprint(existing.command)) return;
            if(command.action!=='start') {
                existing.after=command.after; existing.done=false;
                if(command.action==='cancel') {
                    existing.cancelRequested=true;
                    if(existing.workspace&&existing.status==='observed') this.workers.cancel(existing.workspace,command.runId);
                }
            }
            return;
        }
        if(this.attempts.size>=64) return; // Fail closed; no eviction of uncertain ownership.
        const attempt:Attempt={command,status:'pending',after:command.action==='start'?0:command.after,lastSent:0,done:false,persisted:false};
        this.attempts.set(command.runId,attempt); // Reserve before any asynchronous I/O.
        if(command.action==='start' && (Date.parse(command.expiresAt)<=Date.now() ||
            command.workspace.nodeId!==this.policy.nodeId || command.input.modelProfile!==command.profile.id ||
            !this.allowed(command.workspace.id,command.workspace.rootPath) ||
            !this.policy.profiles.some(x=>JSON.stringify(x)===JSON.stringify(command.profile)))) {
            attempt.status='rejected'; return;
        }
        try {
            await this.directory();
            const claimPath=path.join(this.stateDirectory,command.runId+'.claim');
            let claim:z.infer<typeof claimSchema>|undefined;
            try { claim=claimSchema.parse(JSON.parse(await readFile(claimPath,'utf8'))); }
            catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
            if(claim) {
                if(claim.token!==command.token) throw new Error('Claim identity mismatch.');
                const saved=await readFile(path.join(this.stateDirectory,command.runId+'.terminal'),'utf8').catch(()=>null);
                if(saved) {
                    const terminal=savedSchema.parse(JSON.parse(saved));
                    attempt.receipt=terminal.receipt;attempt.savedEvents=terminal.events;
                    attempt.status='observed';attempt.persisted=true;
                } else attempt.status='missing'; // Claimed before a previous process died: NEVER replay.
                return;
            }
            if(command.action!=='start') { attempt.status='missing';return; }
            if(Date.parse(command.expiresAt)<=Date.now() || command.workspace.nodeId!==this.policy.nodeId || command.workspace.id!==command.input.workspaceId ||
                command.runId!==command.input.runId || !this.allowed(command.workspace.id,command.workspace.rootPath) ||
                command.input.modelProfile!==command.profile.id ||
                !this.policy.profiles.some(x=>JSON.stringify(x)===JSON.stringify(command.profile))) throw new Error('Local policy denied.');
            // Atomic tombstone precedes process creation. A crash between these steps remains unknown.
            const file=await open(claimPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
            try { await file.writeFile(JSON.stringify({token:command.token,workspaceId:command.workspace.id,
                fingerprint:fingerprint(command),profile:command.profile}));await file.sync(); } finally {await file.close();}
            const directory=await open(this.stateDirectory,'r');
            try {await directory.sync();}finally{await directory.close();}
            if(this.closed) {attempt.status='missing';return;}
            attempt.workspace={...command.workspace} as Workspace;
            try {
                attempt.receipt=await this.workers.start(attempt.workspace,command.input);
                attempt.status='observed';
                if(attempt.cancelRequested) this.workers.cancel(attempt.workspace,command.runId);
            } catch {attempt.status='rejected';}
        } catch { attempt.status='missing'; }
    }
    ack(raw:unknown) {
        const ack=agentAckSchema.parse(raw), attempt=this.attempts.get(ack.runId);
        if(!attempt||attempt.command.token!==ack.token) return;
        attempt.after=Math.max(attempt.after,ack.cursor);
        if(attempt.status==='missing'||attempt.status==='rejected'||
            (attempt.receipt?.finishedAt&&ack.cursor>=attempt.receipt.lastCursor)) attempt.done=true;
    }
    async report():Promise<AgentReport|undefined> {
        if(this.closed) return;
        for(const [runId,attempt] of this.attempts) {
            if(attempt.done||Date.now()-attempt.lastSent<1000) continue;
            attempt.lastSent=Date.now();
            let events=attempt.savedEvents??[],oldestCursor=events[0]?.cursor??0;
            if(attempt.workspace&&attempt.status==='observed') {
                attempt.receipt=this.workers.get(attempt.workspace,runId);
                const page=this.workers.events(attempt.workspace,runId,0);
                events=page.events;oldestCursor=page.oldestCursor;
                if(attempt.receipt.finishedAt&&!attempt.persisted) {
                    const temporary=path.join(this.stateDirectory,runId+'.tmp');
                    try {
                        await unlink(temporary).catch(()=>undefined);
                        const file=await open(temporary,'wx',0o600);
                        try {await file.writeFile(JSON.stringify({receipt:attempt.receipt,events}));await file.sync();}finally{await file.close();}
                        await rename(temporary,path.join(this.stateDirectory,runId+'.terminal'));
                        attempt.persisted=true;
                    } catch { /* Keep truthful in-memory receipts; durable replay remains fail-closed. */ }
                }
            }
            return agentReportSchema.parse({type:'agent.report',runId,token:attempt.command.token,status:attempt.status,
                receipt:attempt.receipt??null,profile:attempt.command.profile,
                events:events.filter(x=>x.cursor>attempt.after).slice(0,32),oldestCursor});
        }
    }
    async close(){this.closed=true;await this.workers.close();}
}
export async function readAgentPolicy(file:string,nodeId:string) {
    const stat=await lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)!==0||
        stat.uid!==process.getuid?.()||stat.size>65536) throw new Error('Agent policy must be a private, owner-controlled file.');
    const policy=agentPolicySchema.parse(JSON.parse(await readFile(file,'utf8')));
    if(policy.nodeId!==nodeId) throw new Error('Agent policy belongs to another Node.');
    return policy;
}
