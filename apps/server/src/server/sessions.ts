import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AtlasError } from '../shared/errors.js';

const id = z.string().uuid();
const auth = { sessionId: id, participantId: id, credential: z.string().regex(/^[0-9a-f]{64}$/) };
const body = z.string().trim().min(1).max(8000);
export const sessionSchemas = {
  sessions_create: z.object({ title: z.string().trim().min(1).max(160), objective: body, summary: z.string().max(8000).optional() }),
  sessions_list: z.object({ includeClosed: z.boolean().optional() }),
  sessions_get: z.object({sessionId:id}),
  sessions_join: z.object({sessionId:id, label:z.string().trim().min(1).max(80).optional()}),
  sessions_sync: z.object(auth),
  sessions_updates: z.object({...auth,afterEventId:z.string().regex(/^\d+$/).optional()}),
  sessions_claim: z.object(auth),
  sessions_assign: z.object({...auth,title:z.string().trim().min(1).max(160),brief:body,priority:z.number().int().min(-100).max(100).optional()}),
  sessions_submit: z.object({...auth,assignmentId:id,status:z.enum(['blocked','submitted']),report:body}),
  sessions_review: z.object({...auth,assignmentId:id,decision:z.enum(['accepted','requeue']),feedback:body}),
  sessions_requeue: z.object({...auth,assignmentId:id,reason:body}),
  sessions_message: z.object({...auth,body}),
  sessions_set_summary: z.object({...auth,summary:z.string().max(8000)}),
  sessions_close: z.object(auth)
};
export type SessionToolName = keyof typeof sessionSchemas;
export const sessionDescriptions: Record<SessionToolName,string> = {
  sessions_create: 'Create an Atlas Session. First participant is coordinator. Keep returned participantId and credential in this chat; call sessions_sync when resuming.',
  sessions_list: 'Find active sessions so a new chat can join. If ambiguous, ask which session.',
  sessions_get: 'Read public session state, assignments and recent events. Does not disclose participant credentials.',
  sessions_join: 'Register as worker and atomically claim highest-priority queued assignment. Keep returned participantId and credential in this chat.',
  sessions_sync: 'Rehydrate current role, assignments and changes before continuing work. Chats cannot wake each other automatically.',
  sessions_updates: 'Read paginated session events after a known cursor so no handoffs are silently missed.',
  sessions_claim: 'Worker only. Atomically claim another queued task if none is already active, blocked, or submitted.',
  sessions_assign: 'Coordinator only. Add a scoped assignment with deliverables and acceptance criteria.',
  sessions_submit: 'Worker only. Report a blocker or submit a result for coordinator review.',
  sessions_review: 'Coordinator only. Accept submitted work or requeue it with feedback.',
  sessions_requeue: 'Coordinator only. Recover a stalled or lost worker by unassigning an unfinished task, with an explicit reason.',
  sessions_message: 'Post persistent message visible on the next sync. Does not wake other chats.',
  sessions_set_summary: 'Coordinator only. Save authoritative compact context and decisions.',
  sessions_close: 'Coordinator only. Close and freeze session.'
};
type Identity = {sessionId:string;participantId:string;credential:string};
const hash=(credential:string)=>createHash('sha256').update(credential).digest('hex');
const secret=()=>randomBytes(32).toString('hex');
const fail=(message:string,code:string):never=>{throw new AtlasError(message,code);};
export class SessionService {
  constructor(private readonly pool:Pool){}
  private async tx<T>(fn:(db:PoolClient)=>Promise<T>):Promise<T>{
    const db=await this.pool.connect();
    try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}
    catch(err){await db.query('ROLLBACK').catch(()=>undefined);throw err;}
    finally{db.release();}
  }
  private async lock(db:PoolClient,sessionId:string){
    const r=await db.query('SELECT status FROM atlas_sessions WHERE id=$1 FOR UPDATE',[sessionId]);
    if(!r.rows[0]) fail('Session not found.','NOT_FOUND');
    if(r.rows[0].status!=='active') fail('Session is closed.','INVALID_STATE');
  }
  private async authenticate(db:PoolClient,input:Identity,role?:'coordinator'|'worker'){
    await this.lock(db,input.sessionId);
    const r=await db.query('SELECT role FROM session_participants WHERE session_id=$1 AND id=$2 AND credential_hash=$3',[input.sessionId,input.participantId,hash(input.credential)]);
    if(!r.rows[0]||(role&&r.rows[0].role!==role)) fail('Invalid session participant or role.','FORBIDDEN');
    await db.query('UPDATE session_participants SET last_seen_at=now() WHERE id=$1',[input.participantId]);
  }
  private async event(db:PoolClient,sessionId:string,participantId:string,kind:string,message:string){
    await db.query('INSERT INTO session_events(session_id,participant_id,kind,body) VALUES($1,$2,$3,$4)',[sessionId,participantId,kind,message]);
    await db.query('UPDATE atlas_sessions SET revision=revision+1,updated_at=now() WHERE id=$1',[sessionId]);
  }
  async list(includeClosed=false){
    return (await this.pool.query("SELECT id,title,objective,status,revision,created_at AS \"createdAt\",updated_at AS \"updatedAt\" FROM atlas_sessions WHERE ($1 OR status='active') ORDER BY updated_at DESC LIMIT 100",[includeClosed])).rows;
  }
  async get(sessionId:string){
    const s=await this.pool.query('SELECT id,title,objective,summary,status,revision,coordinator_id AS "coordinatorId",created_at AS "createdAt",updated_at AS "updatedAt" FROM atlas_sessions WHERE id=$1',[sessionId]);
    if(!s.rows[0]) fail('Session not found.','NOT_FOUND');
    const [p,a,e]=await Promise.all([
      this.pool.query('SELECT id,role,label,joined_at AS "joinedAt",last_seen_at AS "lastSeenAt" FROM session_participants WHERE session_id=$1 ORDER BY joined_at,id',[sessionId]),
      this.pool.query('SELECT id,title,brief,priority,status,assignee_id AS "assigneeId",result,created_at AS "createdAt",updated_at AS "updatedAt" FROM session_assignments WHERE session_id=$1 ORDER BY priority DESC,created_at,id',[sessionId]),
      this.pool.query('SELECT id,participant_id AS "participantId",kind,body,created_at AS "createdAt" FROM session_events WHERE session_id=$1 ORDER BY id DESC LIMIT 50',[sessionId])
    ]);
    return {...s.rows[0],participants:p.rows,assignments:a.rows,events:e.rows.reverse()};
  }
  private async briefing(sessionId:string,participantId:string){
    const s=await this.get(sessionId);
    return {session:{id:s.id,title:s.title,objective:s.objective,summary:s.summary,status:s.status,revision:s.revision},
      participant:s.participants.find((p:any)=>p.id===participantId),
      currentAssignments:s.assignments.filter((a:any)=>a.assigneeId===participantId && ['active','blocked','submitted'].includes(a.status)),
      recentEvents:s.events.slice(-15),
      protocol:'Operate within your assigned role, sync when resuming, and publish checkpoints. Atlas cannot force ChatGPT to remember or autonomously resume.'};
  }
  async create(input:z.infer<typeof sessionSchemas.sessions_create>){
    const credential=secret();
    const {sessionId,participantId}=await this.tx(async db=>{
      const s=await db.query('INSERT INTO atlas_sessions(title,objective,summary) VALUES($1,$2,$3) RETURNING id',[input.title,input.objective,input.summary??'']);
      const sessionId=s.rows[0].id as string;
      const p=await db.query("INSERT INTO session_participants(session_id,role,label,credential_hash) VALUES($1,'coordinator','Coordinator',$2) RETURNING id",[sessionId,hash(credential)]);
      const participantId=p.rows[0].id as string;
      await db.query('UPDATE atlas_sessions SET coordinator_id=$2 WHERE id=$1',[sessionId,participantId]);
      await this.event(db,sessionId,participantId,'created','Coordinator started session.');
      return {sessionId,participantId};
    });
    return {sessionId,participantId,credential,briefing:await this.briefing(sessionId,participantId)};
  }
  async join(input:z.infer<typeof sessionSchemas.sessions_join>){
    const credential=secret();
    const participantId=await this.tx(async db=>{
      await this.lock(db,input.sessionId);
      const r=await db.query("SELECT count(*)::int AS total FROM session_participants WHERE session_id=$1 AND role='worker'",[input.sessionId]);
      const label=input.label??'Worker '+(r.rows[0].total+1);
      const p=await db.query("INSERT INTO session_participants(session_id,role,label,credential_hash) VALUES($1,'worker',$2,$3) RETURNING id",[input.sessionId,label,hash(credential)]);
      const id=p.rows[0].id as string;
      const q=await db.query("SELECT id FROM session_assignments WHERE session_id=$1 AND status='queued' ORDER BY priority DESC,created_at,id LIMIT 1 FOR UPDATE",[input.sessionId]);
      if(q.rows[0]){
        await db.query("UPDATE session_assignments SET assignee_id=$2,status='active',updated_at=now() WHERE id=$1",[q.rows[0].id,id]);
        await this.event(db,input.sessionId,id,'assigned','Worker claimed queued assignment '+q.rows[0].id);
      }else await this.event(db,input.sessionId,id,'joined','Worker joined, awaiting assignment.');
      return id;
    });
    return {sessionId:input.sessionId,participantId,credential,briefing:await this.briefing(input.sessionId,participantId)};
  }
  async sync(input:Identity){
    await this.tx(async db=>{await this.authenticate(db,input);});
    return this.briefing(input.sessionId,input.participantId);
  }
  async updates(input:z.infer<typeof sessionSchemas.sessions_updates>){
    await this.tx(async db=>{await this.authenticate(db,input);});
    const rows=await this.pool.query('SELECT id,participant_id AS "participantId",kind,body,created_at AS "createdAt" FROM session_events WHERE session_id=$1 AND id>$2::bigint ORDER BY id ASC LIMIT 101',[input.sessionId,input.afterEventId??'0']);
    const events=rows.rows.slice(0,100);
    return {events,nextCursor:events.length?String(events[events.length-1].id):(input.afterEventId??'0'),hasMore:rows.rows.length>100};
  }
  async assign(input:z.infer<typeof sessionSchemas.sessions_assign>){
    const assignmentId=await this.tx(async db=>{
      await this.authenticate(db,input,'coordinator');
      const q=await db.query('INSERT INTO session_assignments(session_id,title,brief,priority) VALUES($1,$2,$3,$4) RETURNING id',[input.sessionId,input.title,input.brief,input.priority??0]);
      await this.event(db,input.sessionId,input.participantId,'assigned','Coordinator queued: '+input.title);
      return q.rows[0].id as string;
    });
    return {assignmentId,briefing:await this.briefing(input.sessionId,input.participantId)};
  }
  async claim(input:Identity){
    const assignmentId=await this.tx(async db=>{
      await this.authenticate(db,input,'worker');
      const active=await db.query("SELECT id FROM session_assignments WHERE session_id=$1 AND assignee_id=$2 AND status IN ('active','blocked','submitted') LIMIT 1",[input.sessionId,input.participantId]);
      if(active.rows[0]) fail('Complete or resolve your current assignment first.','INVALID_STATE');
      const q=await db.query("SELECT id FROM session_assignments WHERE session_id=$1 AND status='queued' ORDER BY priority DESC,created_at,id LIMIT 1 FOR UPDATE",[input.sessionId]);
      if(!q.rows[0]) return null;
      await db.query("UPDATE session_assignments SET status='active',assignee_id=$2,updated_at=now() WHERE id=$1",[q.rows[0].id,input.participantId]);
      await this.event(db,input.sessionId,input.participantId,'assigned','Worker claimed assignment '+q.rows[0].id);
      return q.rows[0].id as string;
    });
    return {assignmentId,briefing:await this.briefing(input.sessionId,input.participantId)};
  }
  async submit(input:z.infer<typeof sessionSchemas.sessions_submit>){
    await this.tx(async db=>{
      await this.authenticate(db,input,'worker');
      const q=await db.query("UPDATE session_assignments SET status=$4,result=$5,updated_at=now() WHERE id=$1 AND session_id=$2 AND assignee_id=$3 AND status IN ('active','blocked') RETURNING id",[input.assignmentId,input.sessionId,input.participantId,input.status,input.report]);
      if(!q.rowCount) fail('Assignment does not belong to this worker or transition is invalid.','INVALID_STATE');
      await this.event(db,input.sessionId,input.participantId,input.status==='submitted'?'submitted':'updated',input.status+': '+input.report);
    });
    return {briefing:await this.briefing(input.sessionId,input.participantId)};
  }
  async review(input:z.infer<typeof sessionSchemas.sessions_review>){
    await this.tx(async db=>{
      await this.authenticate(db,input,'coordinator');
      const status=input.decision==='accepted'?'accepted':'queued';
      const q=await db.query("UPDATE session_assignments SET status=$3,assignee_id=CASE WHEN $3='queued' THEN NULL ELSE assignee_id END,updated_at=now() WHERE id=$1 AND session_id=$2 AND status='submitted' RETURNING id",[input.assignmentId,input.sessionId,status]);
      if(!q.rowCount) fail('Only submitted work can be reviewed.','INVALID_STATE');
      await this.event(db,input.sessionId,input.participantId,'reviewed',input.decision+': '+input.feedback);
    });
    return {briefing:await this.briefing(input.sessionId,input.participantId)};
  }
  async requeue(input:z.infer<typeof sessionSchemas.sessions_requeue>){
    await this.tx(async db=>{
      await this.authenticate(db,input,'coordinator');
      const q=await db.query("UPDATE session_assignments SET status='queued',assignee_id=NULL,updated_at=now() WHERE id=$1 AND session_id=$2 AND status IN ('active','blocked','submitted') RETURNING id",[input.assignmentId,input.sessionId]);
      if(!q.rowCount) fail('Assignment is not recoverable.','INVALID_STATE');
      await this.event(db,input.sessionId,input.participantId,'reviewed','Coordinator requeued '+input.assignmentId+': '+input.reason);
    });
    return {briefing:await this.briefing(input.sessionId,input.participantId)};
  }
  async message(input:z.infer<typeof sessionSchemas.sessions_message>){
    await this.tx(async db=>{await this.authenticate(db,input);await this.event(db,input.sessionId,input.participantId,'message',input.body);});
    return {briefing:await this.briefing(input.sessionId,input.participantId)};
  }
  async setSummary(input:z.infer<typeof sessionSchemas.sessions_set_summary>){
    await this.tx(async db=>{
      await this.authenticate(db,input,'coordinator');
      await db.query('UPDATE atlas_sessions SET summary=$2 WHERE id=$1',[input.sessionId,input.summary]);
      await this.event(db,input.sessionId,input.participantId,'decision','Coordinator updated shared context.');
    });
    return {briefing:await this.briefing(input.sessionId,input.participantId)};
  }
  async close(input:Identity){
    await this.tx(async db=>{
      await this.authenticate(db,input,'coordinator');
      await this.event(db,input.sessionId,input.participantId,'closed','Coordinator closed session.');
      await db.query("UPDATE atlas_sessions SET status='closed' WHERE id=$1",[input.sessionId]);
    });
    return this.get(input.sessionId);
  }
  async call(name:SessionToolName,raw:unknown):Promise<unknown>{
    const input=sessionSchemas[name].parse(raw) as any;
    switch(name){
      case 'sessions_create':return this.create(input);
      case 'sessions_list':return this.list(input.includeClosed);
      case 'sessions_get':return this.get(input.sessionId);
      case 'sessions_join':return this.join(input);
      case 'sessions_sync':return this.sync(input);
      case 'sessions_updates':return this.updates(input);
      case 'sessions_claim':return this.claim(input);
      case 'sessions_assign':return this.assign(input);
      case 'sessions_submit':return this.submit(input);
      case 'sessions_review':return this.review(input);
      case 'sessions_requeue':return this.requeue(input);
      case 'sessions_message':return this.message(input);
      case 'sessions_set_summary':return this.setSummary(input);
      case 'sessions_close':return this.close(input);
    }
  }
}
