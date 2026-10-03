import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { AtlasData, AtlasRecord, AuditEvent, Page, Project, RecordFilter, SortSpec, Store, View } from "./types.js";

const EMPTY_DATA: AtlasData = { schemaVersion: 1, projects: [], stores: [], records: [], views: [], auditEvents: [] };
export interface AtlasRepository { snapshot(): Promise<AtlasData>; transaction<T>(operation: (draft: AtlasData) => T | Promise<T>): Promise<T>; queryRecords(store: Store, input: { filters?: RecordFilter[]; sort?: SortSpec[]; limit?: number; offset?: number; includeArchived?: boolean }): Promise<Page<AtlasRecord>>; close(): Promise<void>; }
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const projectFromRow = (row: any): Project => ({ id: row.id, name: row.name, ...(row.description !== null && { description: row.description }), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), ...(row.archived_at && { archivedAt: iso(row.archived_at) }) });
const storeFromRow = (row: any): Store => ({ id: row.id, projectId: row.project_id, name: row.name, ...(row.description !== null && { description: row.description }), schema: { version: row.schema_version, fields: row.definition.fields }, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), ...(row.archived_at && { archivedAt: iso(row.archived_at) }) });
const recordFromRow = (row: any): AtlasRecord => ({ id: row.id, projectId: row.project_id, storeId: row.store_id, data: row.data, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), ...(row.archived_at && { archivedAt: iso(row.archived_at) }) });
const viewFromRow = (row: any): View => ({ id: row.id, projectId: row.project_id, name: row.name, ...(row.slug !== null && { slug: row.slug }), ...(row.description !== null && { description: row.description }), queries: row.queries, html: row.html, css: row.css, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), ...(row.archived_at && { archivedAt: iso(row.archived_at) }) });
const auditFromRow = (row: any): AuditEvent => ({ id: row.id, occurredAt: iso(row.created_at), client: row.client, operation: row.operation, ...(row.project_id && { projectId: row.project_id }), ...(row.store_id && { storeId: row.store_id }), ...(row.record_id && { recordId: row.record_id }), ...(row.view_id && { viewId: row.view_id }), ...(row.before_state !== null && { previous: row.before_state }), ...(row.after_state !== null && { resulting: row.after_state }) });

export class PostgresRepository implements AtlasRepository {
    readonly pool: Pool;
    constructor(config: string | PoolConfig) { this.pool = new Pool(typeof config === "string" ? { connectionString: config } : config); }
    async close() { await this.pool.end(); }
    async snapshot(): Promise<AtlasData> { const client = await this.pool.connect(); try { return await this.read(client); } finally { client.release(); } }
    async queryRecords(store: Store, input: { filters?: RecordFilter[]; sort?: SortSpec[]; limit?: number; offset?: number; includeArchived?: boolean }): Promise<Page<AtlasRecord>> {
        const values: unknown[]=[store.id]; const parameter=(value:unknown)=>{values.push(value); return `$${values.length}`;}; const where=["r.store_id=$1"];
        if(!input.includeArchived) where.push("r.archived_at IS NULL");
        const fields=new Map(store.schema.fields.map((field)=>[field.name,field]));
        for(const filter of input.filters??[]){ const key=parameter(filter.field); const definition=fields.get(filter.field)!; const text=`r.data ->> ${key}`; const json=`r.data -> ${key}`;
            switch(filter.operator){
                case "eq": where.push(`${json} = ${parameter(JSON.stringify(filter.value))}::jsonb`); break;
                case "neq": where.push(`${json} IS DISTINCT FROM ${parameter(JSON.stringify(filter.value))}::jsonb`); break;
                case "in": { if(!Array.isArray(filter.value)) throw new Error(`Filter 'in' for '${filter.field}' requires an array value.`); const choices=filter.value.map((x)=>`${json} = ${parameter(JSON.stringify(x))}::jsonb`); where.push(`(${choices.length?choices.join(" OR "):"false"})`); break; }
                case "contains": where.push(definition.type==="array"?`${json} @> ${parameter(JSON.stringify([filter.value]))}::jsonb`:`strpos(${text}, ${parameter(String(filter.value))}) > 0`); break;
                default: { const operator={gt:">",gte:">=",lt:"<",lte:"<="}[filter.operator]; const expression=definition.type==="number"?`(${text})::double precision`:text; const comparison=definition.type==="number"?parameter(filter.value):parameter(String(filter.value)); where.push(`${expression} ${operator} ${comparison}`); }
            }
        }
        const ordering=(input.sort?.length?input.sort:[{field:"createdAt",direction:"asc" as const}]).map((sort)=>{ const direction=sort.direction==="desc"?"DESC":"ASC"; if(sort.field==="createdAt") return `r.created_at ${direction}`; if(sort.field==="updatedAt") return `r.updated_at ${direction}`; const definition=fields.get(sort.field)!; const key=parameter(sort.field); return `${definition.type==="number"?`(r.data ->> ${key})::double precision`:`r.data ->> ${key}`} ${direction} NULLS FIRST`; });
        ordering.push("r.id ASC"); const limit=Math.min(Math.max(input.limit??50,1),100); const offset=Math.max(input.offset??0,0); const limitParameter=parameter(limit); const offsetParameter=parameter(offset);
        const result=await this.pool.query(`SELECT r.*,s.project_id,count(*) OVER()::int AS total FROM records r JOIN stores s ON s.id=r.store_id WHERE ${where.join(" AND ")} ORDER BY ${ordering.join(",")} LIMIT ${limitParameter} OFFSET ${offsetParameter}`,values);
        return {items:result.rows.map(recordFromRow),total:result.rows[0]?.total??(offset?await this.countRecords(store,input):0),limit,offset};
    }
    private async countRecords(store:Store,input:{filters?:RecordFilter[];includeArchived?:boolean}) { const page=await this.queryRecords(store,{...input,limit:1,offset:0}); return page.total; }
    async transaction<T>(operation: (draft: AtlasData) => T | Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try { await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock($1)", [0x41544c41]); const before = await this.read(client); const draft = structuredClone(before); const result = await operation(draft); await this.writeChanges(client, before, draft); await client.query("COMMIT"); return structuredClone(result); }
        catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
        finally { client.release(); }
    }
    private async read(client: PoolClient): Promise<AtlasData> {
        const projects = await client.query("SELECT * FROM projects ORDER BY created_at, id");
        const stores = await client.query("SELECT s.*,ss.version AS schema_version,ss.definition FROM stores s JOIN store_schemas ss ON ss.store_id=s.id AND ss.version=s.current_schema_version ORDER BY s.created_at,s.id");
        const records = await client.query("SELECT r.*,s.project_id FROM records r JOIN stores s ON s.id=r.store_id ORDER BY r.created_at,r.id");
        const views = await client.query("SELECT * FROM views ORDER BY created_at,id");
        const audits = await client.query("SELECT * FROM audit_events ORDER BY created_at,id");
        return { ...EMPTY_DATA, projects: projects.rows.map(projectFromRow), stores: stores.rows.map(storeFromRow), records: records.rows.map(recordFromRow), views: views.rows.map(viewFromRow), auditEvents: audits.rows.map(auditFromRow) };
    }
    private async writeChanges(client: PoolClient, before: AtlasData, after: AtlasData) {
        const oldStores = new Map(before.stores.map((x) => [x.id,x])); const oldRecords = new Map(before.records.map((x) => [x.id,x])); const oldViews = new Map(before.views.map((x) => [x.id,x])); const oldProjects = new Set(before.projects.map((x) => x.id)); const oldAudits = new Set(before.auditEvents.map((x) => x.id));
        for (const x of after.projects) if (!oldProjects.has(x.id)) await client.query("INSERT INTO projects(id,name,description,archived_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)",[x.id,x.name,x.description??null,x.archivedAt??null,x.createdAt,x.updatedAt]); else await client.query("UPDATE projects SET name=$2,description=$3,archived_at=$4,updated_at=$5 WHERE id=$1",[x.id,x.name,x.description??null,x.archivedAt??null,x.updatedAt]);
        for (const x of after.stores) { const old=oldStores.get(x.id); if (!old) { await client.query("INSERT INTO stores(id,project_id,name,description,archived_at,current_schema_version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[x.id,x.projectId,x.name,x.description??null,x.archivedAt??null,x.schema.version,x.createdAt,x.updatedAt]); await this.insertSchema(client,x); } else { await client.query("UPDATE stores SET name=$2,description=$3,archived_at=$4,current_schema_version=$5,updated_at=$6 WHERE id=$1",[x.id,x.name,x.description??null,x.archivedAt??null,x.schema.version,x.updatedAt]); if(old.schema.version!==x.schema.version) await this.insertSchema(client,x); } }
        for (const x of after.records) { const old=oldRecords.get(x.id); const version=after.stores.find((s)=>s.id===x.storeId)!.schema.version; if(!old) await client.query("INSERT INTO records(id,store_id,schema_version,data,archived_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[x.id,x.storeId,version,x.data,x.archivedAt??null,x.createdAt,x.updatedAt]); else if(JSON.stringify(old)!==JSON.stringify(x)) await client.query("UPDATE records SET schema_version=$2,data=$3,archived_at=$4,updated_at=$5 WHERE id=$1",[x.id,version,x.data,x.archivedAt??null,x.updatedAt]); }
        for (const x of after.views) { const old=oldViews.get(x.id); if(!old) await client.query("INSERT INTO views(id,project_id,name,slug,description,queries,html,css,archived_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)",[x.id,x.projectId,x.name,x.slug??null,x.description??null,JSON.stringify(x.queries),x.html,x.css,x.archivedAt??null,x.createdAt,x.updatedAt]); else if(JSON.stringify(old)!==JSON.stringify(x)) await client.query("UPDATE views SET name=$2,slug=$3,description=$4,queries=$5::jsonb,html=$6,css=$7,archived_at=$8,updated_at=$9 WHERE id=$1",[x.id,x.name,x.slug??null,x.description??null,JSON.stringify(x.queries),x.html,x.css,x.archivedAt??null,x.updatedAt]); }
        for (const x of after.auditEvents) if(!oldAudits.has(x.id)) await client.query("INSERT INTO audit_events(id,client,operation,project_id,store_id,record_id,view_id,before_state,after_state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[x.id,x.client,x.operation,x.projectId??null,x.storeId??null,x.recordId??null,x.viewId??null,x.previous??null,x.resulting??null,x.occurredAt]);
    }
    private async insertSchema(client: PoolClient,x:Store){ await client.query("INSERT INTO store_schemas(store_id,version,definition,created_at) VALUES($1,$2,$3,$4)",[x.id,x.schema.version,{fields:x.schema.fields},x.updatedAt]); }
}
export class AtlasStore extends PostgresRepository {}
export function requireDatabaseUrl(value=process.env.DATABASE_URL){ if(!value?.trim()) throw new Error("DATABASE_URL is required. Atlas uses PostgreSQL and does not fall back to JSON storage."); return value; }
