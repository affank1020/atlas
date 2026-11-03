import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { agentSchemas, agentReportSchema, modelProfileSchema, type AgentCommand, type AgentTool, type AgentState } from '@atlas/protocol/agent-jobs';
import { buildAgentHierarchy } from './hierarchy.js';
import type { ApplicationCaller } from '../apps/registry.js';
import { AtlasError } from '../shared/errors.js';
import type { NodeService } from '../nodes/service.js';
import { NodeRouter } from '../nodes/router.js';
import { PostgresWorkspaceRepository } from '../infrastructure/database/workspaces.js';

const terminal = new Set(['completed','failed','cancelled','timed_out','incomplete']);
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])) : value)).digest('hex');
export function agentOwner(caller?: ApplicationCaller) {
    if (!caller || caller.kind !== 'mcp-oauth' || !caller.issuer || !caller.subject)
        throw new AtlasError('Agent operations require authenticated owner OAuth.', 'AGENT_DENIED');
    return hash([caller.issuer, caller.subject]);
}
export const approvalInputSchema = z.object({
    approvalId: z.string().uuid(), runId: z.string().uuid(), checkoutId: z.string().uuid(),
    issuer: z.string().min(1).max(2048), subject: z.string().min(1).max(500),
    instruction: agentSchemas.agent_start.shape.instruction,
    expectedHead: z.string().regex(/^[a-f0-9]{40}$/),
    expectedBranch: z.string().regex(/^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/).refine(x => !x.includes('//') && !x.endsWith('/')),
    timeoutMs: agentSchemas.agent_start.shape.timeoutMs, profile: modelProfileSchema,
    expiresAt: z.string().datetime(),
}).strict();
const denied = () => new AtlasError('Agent run or approval is unavailable to this caller.', 'AGENT_DENIED');
const projection = `SELECT r.*, to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
    n.name AS node_name,w.name AS checkout_name,a.root_path AS approved_root,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'agentId',child.agent_id,'parentAgentId',child.parent_agent_id,
        'role',child.role,'state',child.state,'requestedProfileId',child.requested_profile_id,
        'actualProfile',child.actual_profile,'startedAt',child.started_at,
        'observedAt',child.observed_at,'finishedAt',child.finished_at
    ) ORDER BY child.start_cursor) FROM agent_children child WHERE child.run_id=r.id),'[]'::jsonb) AS children
    FROM agent_runs r JOIN nodes n ON n.id=r.node_id JOIN workspaces w ON w.id=r.checkout_id
    JOIN agent_approvals a ON a.id=r.approval_id`;
/** PostgreSQL is the dispatch/approval authority. The job is independent of its MCP request. */
export class AgentService {
    private closing = false;
    constructor(readonly pool: Pool, private nodes: NodeService) {}
    private async tx<T>(fn: (c: PoolClient) => Promise<T>) {
        const c = await this.pool.connect();
        try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
        catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    }
    /** Admin-local only. No HTTP/MCP grant endpoint; prompt is hashed. */
    async approve(raw: unknown) {
        const x = approvalInputSchema.parse(raw);
        if (!(Date.parse(x.expiresAt) > Date.now()) || Date.parse(x.expiresAt) > Date.now() + 86400_000)
            throw new AtlasError('Approval expiry must be within 24 hours.', 'INVALID_REQUEST');
        const w = await new PostgresWorkspaceRepository(this.pool).getById(x.checkoutId);
        await this.pool.query(`INSERT INTO agent_approvals
            (id,run_id,owner_key,checkout_id,node_id,root_path,head,branch,instruction_sha256,timeout_ms,profile,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [x.approvalId,x.runId,agentOwner({kind:'mcp-oauth',issuer:x.issuer,subject:x.subject}),w.id,w.nodeId,w.rootPath,
                x.expectedHead,x.expectedBranch,hash(x.instruction),x.timeoutMs,x.profile,x.expiresAt]);
        return { approvalId:x.approvalId, runId:x.runId, expiresAt:x.expiresAt };
    }
    async revoke(approvalId: string) {
        await this.pool.query('UPDATE agent_approvals SET revoked_at=now() WHERE id=$1',[z.string().uuid().parse(approvalId)]);
        const runs=(await this.pool.query('SELECT * FROM agent_runs WHERE approval_id=$1 AND finished_at IS NULL',[approvalId])).rows;
        for(const r of runs) {
            await this.pool.query("UPDATE agent_runs SET cancel_requested_at=COALESCE(cancel_requested_at,now()),state='cancelling' WHERE id=$1 AND finished_at IS NULL",[r.id]);
            try {await this.send(r.node_id,{type:'agent.command',action:'cancel',runId:r.id,token:r.token,after:r.last_cursor,profile:r.profile});}
            catch {await this.unknown(r.id,'approval_revocation_cancel_uncertain');}
        }
    }
    private async owned(id: string, owner: string, c: Pool | PoolClient = this.pool) {
        const r = (await c.query(projection+' WHERE r.id=$1 AND r.owner_key=$2',[id,owner])).rows[0];
        if (!r) throw denied(); return r;
    }
    private view(r: any) {
        const stale = !terminal.has(r.state) && (!this.nodes.runtimes.has(r.node_id) ||
            (Date.now() - new Date(r.observed_at??r.created_at).getTime() > 15_000));
        const state=stale?'unknown':r.state;
        return { runId:r.id, checkoutId:r.checkout_id, nodeId:r.node_id, projectId:r.project_id,
            logicalWorkspaceId:r.logical_workspace_id, state:stale?'unknown':r.state, permission:r.permission,
            requestedProfileId:r.profile.id, requestedProfile:r.profile, actualProfile:r.actual_profile,
            nodeName:r.node_name, nodeOnline:this.nodes.runtimes.has(r.node_id), checkoutName:r.checkout_name, approvedRoot:r.approved_root,
            source:'owner-oauth', canCancel:!terminal.has(r.state), startedAt:r.started_at??r.receipt?.startedAt??null,
            hierarchy:buildAgentHierarchy(r.id,state as AgentState,r.actual_profile,r.children),
            head:r.head, branch:r.branch, createdAt:r.created_at, observedAt:r.observed_at, finishedAt:r.finished_at,
            cancelRequestedAt:r.cancel_requested_at, lastCursor:r.last_cursor, eventGap:r.event_gap,
            result:r.receipt, reason:stale?'node_observation_unavailable':r.status_reason,
            evidence:{ ...r.evidence, source:'authenticated_node_process_receipts', verifiedTests:[], verifiedCommits:[],
                taskSuccessVerified:false } };
    }
    async call(name: AgentTool, raw: unknown, caller?: ApplicationCaller) {
        const owner = agentOwner(caller), x: any = agentSchemas[name].parse(raw);
        if (this.closing) throw new AtlasError('Agent service is stopping.', 'AGENT_UNAVAILABLE');
        if (name === 'agent_list') return this.list(x,owner);
        if (name === 'agent_start') return this.start(x, owner);
        const r = await this.owned(x.runId,owner);
        if (name === 'agent_get') return this.view(r);
        if (name === 'agent_events') {
            const events = (await this.pool.query('SELECT event FROM agent_events WHERE run_id=$1 AND cursor>$2 ORDER BY cursor LIMIT $3',
                [r.id,x.after,x.limit])).rows.map(x => x.event);
            const oldest = (await this.pool.query('SELECT min(cursor) AS cursor FROM agent_events WHERE run_id=$1',[r.id])).rows[0].cursor;
            return { runId:r.id, events, oldestCursor:oldest ?? r.last_cursor + 1, lastCursor:r.last_cursor,
                truncated:r.event_gap || (oldest !== null && x.after < oldest-1) };
        }
        if (terminal.has(r.state)) return this.view(r);
        await this.pool.query("UPDATE agent_runs SET cancel_requested_at=COALESCE(cancel_requested_at,now()),state='cancelling' WHERE id=$1 AND finished_at IS NULL",[r.id]);
        try { await this.send(r.node_id,{type:'agent.command',action:'cancel',runId:r.id,token:r.token,after:r.last_cursor,profile:r.profile}); }
        catch { await this.unknown(r.id,'cancel_delivery_uncertain'); }
        return this.view(await this.owned(r.id,owner));
    }
    private async list(x:z.infer<typeof agentSchemas.agent_list>,owner:string) {
        const values:unknown[]=[owner],where=['r.owner_key=$1'];
        const add=(sql:string,value:unknown)=>{values.push(value);where.push(sql.replace('?',`$${values.length}`));};
        if(x.nodeId) add('r.node_id=?',x.nodeId);
        if(x.checkoutId) add('r.checkout_id=?',x.checkoutId);
        if(x.logicalWorkspaceId) add('r.logical_workspace_id=?',x.logicalWorkspaceId);
        // Use the exact same effective status as agent_get, including stale dispatches.
        if(x.state) {
            values.push([...this.nodes.runtimes.keys()]);
            const effective=`CASE WHEN r.finished_at IS NULL AND (NOT(r.node_id=ANY($${values.length}::uuid[])) OR COALESCE(r.observed_at,r.created_at)<now()-interval '15 seconds') THEN 'unknown' ELSE r.state END`;
            if(x.state==='active') where.push(`(${effective}) IN ('dispatching','starting','running','cancelling','unknown')`);
            else add(`(${effective})=?`,x.state);
        }
        if(x.before) {values.push(x.before.createdAt,x.before.runId);where.push(`(r.created_at,r.id)<($${values.length-1}::timestamptz,$${values.length}::uuid)`);}
        values.push(x.limit+1);
        const rows=(await this.pool.query(projection+' WHERE '+where.join(' AND ')+` ORDER BY r.created_at DESC,r.id DESC LIMIT $${values.length}`,values)).rows;
        // Filter choices come from the owner's complete history, not just this page
        // or the unscoped Node/Workspace directory. Keep response size bounded.
        const [nodeScopes,checkoutScopes]=await Promise.all([
            this.pool.query('SELECT DISTINCT n.id,n.name FROM agent_runs r JOIN nodes n ON n.id=r.node_id WHERE r.owner_key=$1 ORDER BY n.name,n.id LIMIT 201',[owner]),
            this.pool.query('SELECT DISTINCT w.id,w.name FROM agent_runs r JOIN workspaces w ON w.id=r.checkout_id WHERE r.owner_key=$1 ORDER BY w.name,w.id LIMIT 201',[owner]),
        ]);
        const more=rows.length>x.limit,visible=rows.slice(0,x.limit),last=visible.at(-1);
        return {runs:visible.map(r=>this.view(r)),next:more?{createdAt:last.cursor_created_at,runId:last.id}:null,
            scopes:{nodes:nodeScopes.rows.slice(0,200),checkouts:checkoutScopes.rows.slice(0,200),truncated:nodeScopes.rows.length>200||checkoutScopes.rows.length>200}};
    }
    private async start(x: z.infer<typeof agentSchemas.agent_start>, owner: string) {
        const digest = hash(x);
        const existing = (await this.pool.query('SELECT * FROM agent_runs WHERE id=$1',[x.runId])).rows[0];
        if (existing) {
            if (existing.owner_key !== owner || existing.request_sha256 !== digest) throw denied();
            return this.view(await this.owned(x.runId,owner));
        }
        const w = await new PostgresWorkspaceRepository(this.pool).getById(x.checkoutId);
        const runtime = await new NodeRouter(this.nodes).resolve(w.nodeId,'agent.pi');
        if (!runtime.agentCommand || !runtime.agentSessionId) throw new AtlasError('Node agent transport is unavailable.', 'CAPABILITY_UNAVAILABLE');
        const token = randomUUID();
        const r = await this.tx(async c => {
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[x.runId]);
            const prior = (await c.query('SELECT * FROM agent_runs WHERE id=$1',[x.runId])).rows[0];
            if (prior) {
                if (prior.owner_key!==owner || prior.request_sha256!==digest) throw denied();
                return { row:prior, dispatch:false };
            }
            const a = (await c.query('SELECT * FROM agent_approvals WHERE id=$1 FOR UPDATE',[x.approvalId])).rows[0];
            const current = (await c.query("SELECT * FROM workspaces WHERE id=$1 AND status='active' FOR UPDATE",[w.id])).rows[0];
            if (!a || !current || a.owner_key!==owner || a.run_id!==x.runId || a.checkout_id!==w.id ||
                a.node_id!==current.node_id || a.node_id!==w.nodeId || a.root_path!==current.root_path ||
                a.root_path!==w.rootPath || a.instruction_sha256!==hash(x.instruction) ||
                a.profile.id!==x.profileId || a.timeout_ms!==x.timeoutMs || a.revoked_at || a.consumed_at ||
                new Date(a.expires_at).getTime()<=Date.now()) throw denied();
            if (current.project_id && !(await c.query("SELECT 1 FROM projects WHERE id=$1 AND archived_at IS NULL",[current.project_id])).rowCount) throw denied();
            const row = (await c.query(`INSERT INTO agent_runs(id,approval_id,owner_key,checkout_id,node_id,project_id,
                logical_workspace_id,token,request_sha256,profile,head,branch,dispatch_session,state)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'dispatching') RETURNING *`,
                [x.runId,a.id,owner,w.id,w.nodeId,current.project_id,current.logical_workspace_id,token,digest,a.profile,a.head,a.branch,runtime.agentSessionId])).rows[0];
            await c.query('UPDATE agent_approvals SET consumed_at=now() WHERE id=$1',[a.id]);
            return { row,dispatch:true,expiresAt:new Date(a.expires_at).toISOString() };
        }).catch(e => { if (e.code==='23505') throw new AtlasError('Node already has an active or uncertain agent run.','AGENT_BUSY'); throw e; });
        if (r.dispatch) {
            try {
                if (this.nodes.runtimes.get(w.nodeId)!==runtime) throw denied();
                runtime.agentCommand({type:'agent.command',action:'start',runId:x.runId,token,expiresAt:r.expiresAt!,
                    workspace:{id:w.id,nodeId:w.nodeId,rootPath:w.rootPath,status:'active'},
                    input:{runId:x.runId,workspaceId:w.id,expectedHead:r.row.head,expectedBranch:r.row.branch,
                        prompt:x.instruction,permission:'read-only',timeoutMs:x.timeoutMs,modelProfile:x.profileId},profile:r.row.profile});
            } catch { await this.unknown(x.runId,'dispatch_uncertain'); }
        }
        return this.view(await this.owned(x.runId,owner));
    }
    private async send(nodeId: string, command: AgentCommand) {
        const runtime = await new NodeRouter(this.nodes).resolve(nodeId,'agent.pi');
        if (!runtime.agentCommand) throw denied(); runtime.agentCommand(command);
    }
    async connected(nodeId: string) {
        const session=this.nodes.runtimes.get(nodeId)?.agentSessionId;
        if(!session) return;
        await this.pool.query("UPDATE agent_runs SET state='unknown',status_reason='connection_changed' WHERE node_id=$1 AND dispatch_session<>$2 AND finished_at IS NULL",[nodeId,session]);
        const runs = (await this.pool.query('SELECT * FROM agent_runs WHERE node_id=$1 AND dispatch_session<>$2 AND finished_at IS NULL ORDER BY created_at LIMIT 64',[nodeId,session])).rows;
        for (const r of runs) await this.send(nodeId,{type:'agent.command',action:r.cancel_requested_at?'cancel':'observe',runId:r.id,token:r.token,after:r.last_cursor,profile:r.profile});
    }
    async disconnected(nodeId: string, session?:string) {
        await this.pool.query("UPDATE agent_runs SET state='unknown',status_reason='node_disconnected' WHERE node_id=$1 AND ($2::uuid IS NULL OR dispatch_session=$2) AND finished_at IS NULL",[nodeId,session??null]);
    }
    private async unknown(id: string, reason: string) {
        await this.pool.query("UPDATE agent_runs SET state='unknown',status_reason=$2 WHERE id=$1 AND finished_at IS NULL",[id,reason]);
    }
    private async receiveChild(c:PoolClient,runId:string,event:z.infer<typeof agentReportSchema>['events'][number]) {
        if(event.type==='child_start') {
            const {agentId,parentAgentId,role,requestedProfileId}=event.data;
            if(agentId===runId) throw new AtlasError('A child cannot use the root identity.','AGENT_PROTOCOL');
            const count=await c.query('SELECT count(*)::integer AS total FROM agent_children WHERE run_id=$1',[runId]);
            if(Number(count.rows[0].total)>=32) throw new AtlasError('Agent child limit exceeded.','AGENT_PROTOCOL');
            if(parentAgentId!==runId) {
                const parent=await c.query('SELECT 1 FROM agent_children WHERE run_id=$1 AND agent_id=$2 AND finished_at IS NULL',[runId,parentAgentId]);
                if(!parent.rowCount) throw new AtlasError('Unobserved parent agent.','AGENT_PROTOCOL');
            }
            await c.query(`INSERT INTO agent_children(
                run_id,agent_id,parent_agent_id,role,requested_profile_id,state,started_at,observed_at,start_cursor,last_cursor
            ) VALUES($1,$2,$3,$4,$5,'starting',$6,$6,$7,$7)`,
            [runId,agentId,parentAgentId,role,requestedProfileId,event.at,event.cursor]);
        } else if(event.type==='child_state') {
            const {agentId,state,actualProfile}=event.data;
            const updated=await c.query(`UPDATE agent_children SET state=$3,observed_at=$4,
                actual_profile=COALESCE($5::jsonb,actual_profile),last_cursor=$6
                WHERE run_id=$1 AND agent_id=$2 AND finished_at IS NULL
                  AND (state='starting' OR $3='running') RETURNING agent_id`,
                [runId,agentId,state,event.at,actualProfile??null,event.cursor]);
            if(!updated.rowCount) throw new AtlasError('Invalid child state transition.','AGENT_PROTOCOL');
        } else if(event.type==='child_terminal') {
            const {agentId,state,actualProfile}=event.data;
            if(state==='completed') {
                const active=await c.query(
                    'SELECT 1 FROM agent_children WHERE run_id=$1 AND parent_agent_id=$2 AND finished_at IS NULL LIMIT 1',
                    [runId,agentId]);
                if(active.rowCount) throw new AtlasError('Child completed with live descendants.','AGENT_PROTOCOL');
            }
            const updated=await c.query(`UPDATE agent_children SET state=$3,observed_at=$4,finished_at=$4,
                actual_profile=COALESCE($5::jsonb,actual_profile),last_cursor=$6
                WHERE run_id=$1 AND agent_id=$2 AND finished_at IS NULL RETURNING agent_id`,
                [runId,agentId,state,event.at,actualProfile??null,event.cursor]);
            if(!updated.rowCount) throw new AtlasError('Missing or completed child agent.','AGENT_PROTOCOL');
        }
    }
    async receive(nodeId: string, raw: unknown, sessionId=this.nodes.runtimes.get(nodeId)?.agentSessionId) {
        const report = agentReportSchema.parse(raw);
        let cancel:AgentCommand|undefined;
        const acknowledged=await this.tx(async c => {
            const r = (await c.query('SELECT * FROM agent_runs WHERE id=$1 AND node_id=$2 AND token=$3 FOR UPDATE',
                [report.runId,nodeId,report.token])).rows[0];
            if (!r || hash(r.profile)!==hash(report.profile)) throw denied();
            if (r.finished_at) return r.last_cursor;
            const binding=(await c.query(
                'SELECT w.node_id,w.root_path,w.status,p.archived_at AS project_archived,a.revoked_at,a.root_path AS approved_root FROM workspaces w JOIN agent_approvals a ON a.id=$2 LEFT JOIN projects p ON p.id=w.project_id WHERE w.id=$1',
                [r.checkout_id,r.approval_id])).rows[0];
            if(!r.cancel_requested_at && (!binding || binding.node_id!==nodeId || binding.root_path!==binding.approved_root ||
                binding.status!=='active' || binding.project_archived || binding.revoked_at)) {
                await c.query("UPDATE agent_runs SET cancel_requested_at=now() WHERE id=$1",[r.id]);
                r.cancel_requested_at=new Date();
            }
            // Admin-local revocation may be written by another process. Re-send only idempotent
            // cancellation after commit, never a start, until a real terminal receipt arrives.
            if(r.cancel_requested_at&&!report.receipt?.finishedAt)
                cancel={type:'agent.command',action:'cancel',runId:r.id,token:r.token,after:r.last_cursor,profile:r.profile};
            if (report.status==='missing') {
                await c.query("UPDATE agent_runs SET state='unknown',status_reason='node_run_missing',observed_at=now() WHERE id=$1",[r.id]);
                return r.last_cursor;
            }
            if (report.status==='rejected') {
                await c.query("UPDATE agent_runs SET state='failed',status_reason='node_admission_rejected',observed_at=now(),finished_at=now() WHERE id=$1",[r.id]);
                return r.last_cursor;
            }
            let cursor = r.last_cursor, gap = r.event_gap;
            const evidence = {...r.evidence};
            if (report.oldestCursor>cursor+1) { gap=true; cursor=report.oldestCursor-1; }
            for (const event of report.events) {
                if (event.cursor<=cursor) continue;
                if (event.cursor!==cursor+1) throw new AtlasError('Agent event sequence has a gap.','AGENT_PROTOCOL');
                await c.query('INSERT INTO agent_events(run_id,cursor,event) VALUES($1,$2,$3)',[r.id,event.cursor,event]);
                cursor=event.cursor;
                if (event.type==='ready') evidence.runtimeReady=true;
                if (event.type==='agent_start') evidence.agentStarted=true;
                if (event.type==='agent_settled') evidence.agentSettled=true;
                if (event.type==='result' && event.data.ok===true) evidence.piResult=true;
                if (event.type==='terminal' && event.data.state==='completed') evidence.terminalCompleted=true;
                if (event.type==='tool_execution_end') evidence.toolExecutions=(evidence.toolExecutions??0)+1;
                if(event.type.startsWith('child_')) {
                    if(!evidence.runtimeReady||!evidence.agentStarted)
                        throw new AtlasError('Child event before the parent Pi loop.','AGENT_PROTOCOL');
                    await this.receiveChild(c,r.id,event);
                }
            }
            const receipt=report.receipt;
            if(receipt && terminal.has(receipt.state)!==!!receipt.finishedAt)
                throw new AtlasError('Terminal process receipt is incomplete.','AGENT_PROTOCOL');
            if (receipt && (receipt.runId!==r.id || receipt.nodeId!==nodeId || receipt.workspaceId!==r.checkout_id ||
                receipt.head!==r.head || receipt.branch!==r.branch || receipt.lastCursor<cursor ||
                Date.parse(receipt.startedAt)>Date.now()+30_000 ||
                (receipt.finishedAt && (Date.parse(receipt.finishedAt)<Date.parse(receipt.startedAt)||Date.parse(receipt.finishedAt)>Date.now()+30_000)))) throw denied();
            let state = r.cancel_requested_at?'cancelling':receipt?.state??'dispatching';
            let finished: string|null=null, saved: unknown=null, reason: string|null=null;
            if (receipt?.finishedAt && cursor===receipt.lastCursor) {
                state=receipt.state; finished=receipt.finishedAt; saved=receipt; reason=receipt.reason??null;
                if (!terminal.has(state)) throw denied();
                if (state==='completed' && (gap || !evidence.runtimeReady || !evidence.agentStarted || !evidence.agentSettled ||
                    !evidence.piResult || !evidence.terminalCompleted || !receipt.pid || receipt.exitCode!==0 || receipt.signal!==null)) {
                    state='incomplete'; reason='completion_evidence_missing';
                }
            } else if (receipt?.finishedAt) state=r.cancel_requested_at?'cancelling':'running';
            if(state==='completed') {
                const unresolved=await c.query('SELECT 1 FROM agent_children WHERE run_id=$1 AND finished_at IS NULL LIMIT 1',[r.id]);
                if(unresolved.rowCount) {state='incomplete';reason='child_evidence_missing';}
            }
            await c.query(`UPDATE agent_runs SET state=$2,last_cursor=$3,event_gap=$4,evidence=$5,
                observed_at=now(),receipt=$6,finished_at=$7,status_reason=$8,actual_profile=$9,dispatch_session=COALESCE($10::uuid,dispatch_session),
                started_at=COALESCE(started_at,$11::timestamptz) WHERE id=$1`,
                [r.id,state,cursor,gap,evidence,saved,finished,reason,evidence.runtimeReady?r.profile:null,sessionId??null,receipt?.startedAt??null]);
            await c.query('DELETE FROM agent_events WHERE run_id=$1 AND cursor<=$2',[r.id,cursor-2000]);
            return cursor;
        });
        if(cancel) await this.send(nodeId,cancel).catch(()=>undefined);
        return acknowledged;
    }
    async close() { this.closing=true;  }
}
