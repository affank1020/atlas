import { z } from 'zod';
import type { Pool } from 'pg';
import type { CoreService } from '../core/service.js';
import type { ApplicationDefinition, ApplicationTool } from './registry.js';
import { studyDeckSchema, rateCardSchema, type KnowledgeStudyService } from './knowledge-study.js';

/**
 * A read-only, server-backed browser over the existing Atlas Core stores.
 * Ingestion stays ChatGPT -> Core records; no shadow index or second database.
 */
export const KNOWLEDGE_BANK_PROJECT_ID = 'f5091ee1-3d72-4654-8192-37ccfe8608a7';

export const KNOWLEDGE_STORE_IDS = {
    entries: 'c06e106f-7507-4cad-9881-3774917ee580',
    sources: '0a079819-044a-402e-854f-f14d200b3796',
    sections: '9e8ab094-f3c7-4eb2-8481-be55b019d5b7',
    relations: '1d238fe1-c6ed-41ac-99ba-89ed052f2a7e',
    groups: '4ecdd6c1-6807-456b-9151-cc13a9c31b34',
} as const;

export const browseSchema = z.object({
    collection: z.enum(['entries', 'sources', 'sections', 'relations']).default('entries'),
    q: z.string().max(300).default(''),
    group: z.string().max(120).default(''),
    sourceKey: z.string().max(240).default(''),
    sourceType: z.string().max(100).default(''),
    entryKind: z.string().max(100).default(''),
    tag: z.string().max(120).default(''),
    offset: z.number().int().min(0).max(10_000_000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
}).strict();
export type BrowseInput = z.infer<typeof browseSchema>;

type Db = Pick<Pool, 'query'>;

export class KnowledgeBankService {
    constructor(private readonly catalog: Pick<CoreService, 'getProject'>, private readonly db: Db,
        private readonly projectId = KNOWLEDGE_BANK_PROJECT_ID,
        private readonly storeIds: typeof KNOWLEDGE_STORE_IDS = KNOWLEDGE_STORE_IDS) {}

    async overview() {
        await this.catalog.getProject(this.projectId);
        const counts = await this.db.query<{ name: string; total: number }>(
            `SELECT s.name, count(r.id)::int AS total
               FROM stores s LEFT JOIN records r ON r.store_id = s.id AND r.archived_at IS NULL
              WHERE s.project_id = $1 AND s.archived_at IS NULL AND s.id = ANY($2::uuid[])
              GROUP BY s.id, s.name`,
            [this.projectId, Object.values(this.storeIds)]
        );
        const groups = await this.db.query<{ id: string; data: Record<string, unknown> }>(
            `SELECT r.id, r.data
               FROM records r JOIN stores s ON s.id = r.store_id
              WHERE s.project_id = $1 AND s.archived_at IS NULL
                AND r.store_id = $2 AND r.archived_at IS NULL
              ORDER BY lower(r.data ->> 'name'), r.id`,
            [this.projectId, this.storeIds.groups]
        );
        return {
            counts: Object.fromEntries(counts.rows.map(row => [row.name, Number(row.total)])),
            groups: groups.rows.map(row => ({ id: row.id, ...row.data })),
        };
    }

    async browse(raw: BrowseInput) {
        const input = browseSchema.parse(raw);
        await this.catalog.getProject(this.projectId);
        const collection = input.collection;
        const values: unknown[] = [this.projectId, this.storeIds[collection]];
        const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
        const conditions = [
            's.project_id = $1',
            's.archived_at IS NULL',
            'r.store_id = $2',
            'r.archived_at IS NULL',
        ];
        // Resolve source metadata from the same Core record set. Each source
        // identity is independent; never merge two papers' extracted claims.
        const isSource = collection === 'sources';
        const isRelation = collection === 'relations';
        const entryJoin = isRelation
            ? `LEFT JOIN LATERAL (
                 SELECT e.data FROM records e JOIN stores es ON es.id=e.store_id
                  WHERE e.store_id = '${this.storeIds.entries}'::uuid AND e.archived_at IS NULL
                    AND es.project_id=$1 AND es.archived_at IS NULL
                    AND e.data ->> 'entryKey' = r.data ->> 'fromEntryKey'
                  ORDER BY e.created_at, e.id LIMIT 1
              ) related_entry ON true`
            : '';
        const keyExpr = isRelation
            ? `COALESCE(related_entry.data ->> 'sourceKey', r.data ->> 'evidenceSourceKey')`
            : `r.data ->> 'sourceKey'`;
        const sourceJoin = isSource ? '' : `LEFT JOIN LATERAL (
                SELECT sr.id, sr.data FROM records sr JOIN stores ss ON ss.id=sr.store_id
                 WHERE sr.store_id = '${this.storeIds.sources}'::uuid AND sr.archived_at IS NULL
                   AND ss.project_id=$1 AND ss.archived_at IS NULL
                   AND sr.data ->> 'sourceKey' = ${keyExpr}
                 ORDER BY sr.created_at, sr.id LIMIT 1
            ) src ON true`;
        const sourceData = isSource ? 'r.data' : 'src.data';
        const groupData = isRelation ? 'related_entry.data' : 'r.data';
        const base = `FROM records r JOIN stores s ON s.id=r.store_id ${entryJoin} ${sourceJoin}`;

        if (input.group) conditions.push(`COALESCE(${groupData} -> 'groupKeys', '[]'::jsonb) ? ${bind(input.group)}`);
        if (input.sourceKey) conditions.push(`${keyExpr} = ${bind(input.sourceKey)}`);
        if (input.sourceType) conditions.push(`${sourceData} ->> 'sourceType' = ${bind(input.sourceType)}`);
        if (input.entryKind) conditions.push(collection === 'entries'
            ? `r.data ->> 'kind' = ${bind(input.entryKind)}`
            : 'false');
        if (input.tag) {
            const tag = bind(input.tag.trim().toLowerCase());
            conditions.push(`(EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(r.data -> 'tags','[]'::jsonb)) t
                          WHERE strpos(lower(t), ${tag}) > 0)
                      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${sourceData} -> 'tags','[]'::jsonb)) t
                          WHERE strpos(lower(t), ${tag}) > 0))`);
        }
        if (input.q.trim()) {
            const phrase = bind(input.q.trim().toLowerCase());
            conditions.push(`strpos(lower(concat_ws(' ',
                   r.data ->> 'title', r.data ->> 'name', r.data ->> 'summary',
                   r.data ->> 'detail', r.data ->> 'sourceExcerpt',
                   r.data ->> 'rationale', r.data ->> 'description',
                   r.data ->> 'sectionLabel', r.data ->> 'locator',
                   r.data ->> 'entryKey', r.data ->> 'sourceKey',
                   r.data ->> 'fromEntryKey', r.data ->> 'toEntryKey',
                   r.data ->> 'tags', ${sourceData} ->> 'title',
                   ${sourceData} ->> 'authors')), ${phrase}) > 0`);
        }
        const where = `WHERE ${conditions.join(' AND ')}`;
        const count = await this.db.query<{ total: number }>(`SELECT count(*)::int AS total ${base} ${where}`, values);
        const limit = bind(input.limit);
        const offset = bind(input.offset);
        const page = await this.db.query<{ id: string; data: Record<string, unknown>; source_title: string | null; source_type: string | null; source_id: string | null; source_original_url: string | null }>(
            `SELECT r.id, r.data, ${sourceData} ->> 'title' AS source_title,
                    ${sourceData} ->> 'sourceType' AS source_type,
                    ${isSource ? 'r.id' : 'src.id'} AS source_id,
                    ${sourceData} ->> 'originalUrl' AS source_original_url
               ${base} ${where}
              ORDER BY lower(COALESCE(r.data ->> 'title',r.data ->> 'name',r.data ->> 'sectionLabel',r.data ->> 'relationKey', '')), r.id
              LIMIT ${limit} OFFSET ${offset}`, values
        );
        return {
            items: page.rows.map(row => ({ id: row.id, ...row.data,
                sourceTitle: row.source_title, sourceTypeResolved: row.source_type, sourceRecordId: row.source_id,
                sourceOriginalUrl: row.source_original_url })),
            total: Number(count.rows[0]?.total ?? 0),
            limit: input.limit,
            offset: input.offset,
        };
    }
}

export function knowledgeBankApplication(service: Pick<KnowledgeBankService, 'browse' | 'overview'>, study?: Pick<KnowledgeStudyService,'deck'|'rate'>): ApplicationDefinition {
    const tools: ApplicationTool[] = [
        {
            name: 'knowledge_bank_overview',
            description: 'List shared Knowledge Bank groups and corpus-wide record counts. No 100-record View limitation.',
            inputSchema: {},
            invoke: () => service.overview(),
        },
        {
            name: 'knowledge_bank_browse',
            description: 'Search and page through the complete shared Knowledge Bank with optional group, source, source type, knowledge kind and topic tag filters. Read-only.',
            inputSchema: browseSchema.shape,
            invoke: input => service.browse(input),
        },
    ];
    if (study) tools.push(
        { name:'knowledge_bank_study_deck',description:'Retrieve due or all source-linked study flashcards and lecturer self-assessment practice prompts. Supports group and source filters.',inputSchema:studyDeckSchema.shape,invoke:input=>study.deck(input) },
        { name:'knowledge_bank_rate_card',description:'Record a self-rated flashcard review and compute its next practice date. Not automatic grading.',inputSchema:rateCardSchema.shape,invoke:input=>study.rate(input) },
    );
    return {
        type: 'knowledge-bank',
        slug: 'knowledge-bank',
        name: 'Knowledge Bank',
        description: 'Search papers, notes, concepts and cited passages across your research library.',
        projectId: KNOWLEDGE_BANK_PROJECT_ID,
        tools,
    };
}
