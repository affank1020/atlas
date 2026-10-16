
import { z } from 'zod';
import type { Pool } from 'pg';
import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import { KNOWLEDGE_BANK_PROJECT_ID } from './knowledge-bank.js';

export const KNOWLEDGE_CARDS_STORE_ID = '6d40585b-d4d5-4043-b89f-1afaddf2266e';
export const KNOWLEDGE_PROGRESS_STORE_ID = '0158e3fa-4577-485a-9a48-4ac8669be22b';

export const studyDeckSchema = z.object({
  group: z.string().max(100).default(''),
  sourceKey: z.string().max(240).default(''),
  cardType: z.enum(['all','recall','application','critique','assessment']).default('all'),
  mode: z.enum(['due','all']).default('due'),
  limit: z.number().int().min(1).max(30).default(15),
  offset: z.number().int().min(0).max(10_000_000).default(0),
}).strict();
export const rateCardSchema = z.object({
  cardKey: z.string().min(1).max(300),
  rating: z.enum(['again','hard','good','easy'])
}).strict();
export type StudyDeckInput = z.infer<typeof studyDeckSchema>;
export type RatingInput = z.infer<typeof rateCardSchema>;

type ProgressData = {
  cardKey:string; reviews:number; streak:number; intervalDays:number; lastRating:string;
  lastReviewedAt:string; nextDueAt:string;
};

/** Extra study-layer functionality: no AI grading, no runtime examination assistance. */
export class KnowledgeStudyService {
  constructor(
    private readonly catalog: Pick<CoreService,'getProject'|'queryRecords'|'createRecord'|'updateRecord'>,
    private readonly db: Pick<Pool,'query'>,
    private readonly projectId: string = KNOWLEDGE_BANK_PROJECT_ID,
    private readonly cardsStoreId = KNOWLEDGE_CARDS_STORE_ID,
    private readonly progressStoreId = KNOWLEDGE_PROGRESS_STORE_ID
  ) {}

  async deck(raw: StudyDeckInput) {
    const input = studyDeckSchema.parse(raw);
    await this.catalog.getProject(this.projectId);
    const args: unknown[] = [this.projectId,this.cardsStoreId,this.progressStoreId];
    const bind=(value:unknown)=>{args.push(value);return '$'+args.length;};
    const where=['s.project_id=$1','s.archived_at IS NULL','r.store_id=$2','r.archived_at IS NULL',
      "r.data ->> 'status' = 'active'"];
    if(input.group) where.push(`COALESCE(r.data -> 'groupKeys','[]'::jsonb) ? ${bind(input.group)}`);
    if(input.sourceKey) where.push(`r.data ->> 'sourceKey' = ${bind(input.sourceKey)}`);
    if(input.cardType!=='all') where.push(`r.data ->> 'cardType' = ${bind(input.cardType)}`);
    if(input.mode==='due') where.push(`(progress.data IS NULL OR (progress.data ->> 'nextDueAt')::timestamptz <= now())`);
    const base=`FROM records r JOIN stores s ON s.id=r.store_id
      LEFT JOIN LATERAL (
        SELECT pr.data FROM records pr JOIN stores ps ON ps.id=pr.store_id
        WHERE pr.store_id=$3 AND pr.archived_at IS NULL AND ps.project_id=$1 AND ps.archived_at IS NULL
          AND pr.data ->> 'cardKey'=r.data ->> 'cardKey'
        ORDER BY pr.updated_at DESC, pr.id LIMIT 1
      ) progress ON TRUE`;
    const filters='WHERE '+where.join(' AND ');
    const count=await this.db.query<{total:number}>(`SELECT count(*)::int AS total ${base} ${filters}`,args);
    const limit=bind(input.limit);
    const offset=bind(input.offset);
    const found=await this.db.query<{id:string;data:Record<string,unknown>;progress:ProgressData|null}>(
      `SELECT r.id,r.data,progress.data AS progress ${base} ${filters}
       ORDER BY CASE WHEN progress.data IS NULL THEN 0 ELSE 1 END,
                COALESCE(progress.data ->> 'nextDueAt',''),lower(r.data ->> 'question'),r.id
       LIMIT ${limit} OFFSET ${offset}`,args);
    return {total:Number(count.rows[0]?.total??0),items:found.rows.map(x=>({id:x.id,...x.data,progress:x.progress})),mode:input.mode,offset:input.offset};
  }

  async rate(raw: RatingInput) {
    const input = rateCardSchema.parse(raw);
    await this.catalog.getProject(this.projectId);
    const card=await this.catalog.queryRecords({projectId:this.projectId,storeId:this.cardsStoreId,
      filters:[{field:'cardKey',operator:'eq',value:input.cardKey}],limit:2});
    if(card.items.length!==1 || card.items[0]?.data.status!=='active')
      throw new AtlasError('The study card was not found or is not active.','NOT_FOUND');
    const old=await this.catalog.queryRecords({projectId:this.projectId,storeId:this.progressStoreId,
      filters:[{field:'cardKey',operator:'eq',value:input.cardKey}],limit:2});
    if(old.items.length>1) throw new AtlasError('Duplicate study progress must be reconciled before rating.','INVALID_REQUEST');
    const prev=old.items[0]?.data as Partial<ProgressData> | undefined;
    const reviews=(prev?.reviews??0)+1;
    const streak=input.rating==='again'?0:(prev?.streak??0)+1;
    const prior=prev?.intervalDays??0;
    const days=input.rating==='again'?0:input.rating==='hard'?Math.max(1,Math.round(prior*1.2)):
      input.rating==='good'?Math.max(3,Math.round(prior*2)):Math.max(7,Math.round(prior*2.8));
    const now=new Date();
    const due=new Date(now.getTime()+(input.rating==='again'?10*60*1000:days*24*60*60*1000));
    const data:ProgressData={cardKey:input.cardKey,reviews,streak,intervalDays:days,lastRating:input.rating,
      lastReviewedAt:now.toISOString(),nextDueAt:due.toISOString()};
    if(old.items[0]) await this.catalog.updateRecord({projectId:this.projectId,storeId:this.progressStoreId,
      recordId:old.items[0].id,data,client:'Knowledge Bank Study'});
    else await this.catalog.createRecord({projectId:this.projectId,storeId:this.progressStoreId,data,client:'Knowledge Bank Study'});
    return data;
  }
}
