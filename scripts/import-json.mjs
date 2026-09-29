import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const url=process.env.DATABASE_URL;
if(!url) throw new Error("DATABASE_URL is required.");
const source=process.argv[2] ?? path.join(process.cwd(),"data","atlas-structured.json");
const state=JSON.parse(await readFile(source,"utf8"));
for(const key of ["projects","stores","records","auditEvents"]) if(!Array.isArray(state[key])) throw new Error(`Invalid Atlas JSON: '${key}' must be an array.`);
const pool=new pg.Pool({connectionString:url}); const client=await pool.connect();
try {
  await client.query("BEGIN");
  const occupied=Number((await client.query("SELECT (SELECT count(*) FROM projects)+(SELECT count(*) FROM stores)+(SELECT count(*) FROM records)+(SELECT count(*) FROM audit_events) AS count")).rows[0].count);
  if(occupied) throw new Error("Import refused: Atlas database is not empty. This prevents duplicate or partial repeated imports.");
  for(const x of state.projects) await client.query("INSERT INTO projects(id,name,description,archived_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)",[x.id,x.name,x.description??null,x.archivedAt??null,x.createdAt,x.updatedAt]);
  for(const x of state.stores){ await client.query("INSERT INTO stores(id,project_id,name,description,archived_at,current_schema_version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[x.id,x.projectId,x.name,x.description??null,x.archivedAt??null,x.schema.version,x.createdAt,x.updatedAt]); await client.query("INSERT INTO store_schemas(store_id,version,definition,created_at) VALUES($1,$2,$3,$4)",[x.id,x.schema.version,{fields:x.schema.fields},x.updatedAt]); }
  for(const x of state.records){ const store=state.stores.find((s)=>s.id===x.storeId); if(!store) throw new Error(`Record '${x.id}' refers to missing store '${x.storeId}'.`); await client.query("INSERT INTO records(id,store_id,schema_version,data,archived_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[x.id,x.storeId,store.schema.version,x.data,x.archivedAt??null,x.createdAt,x.updatedAt]); }
  for(const x of state.auditEvents) await client.query("INSERT INTO audit_events(id,client,operation,project_id,store_id,record_id,before_state,after_state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[x.id,x.client,x.operation,x.projectId??null,x.storeId??null,x.recordId??null,x.previous??null,x.resulting??null,x.occurredAt]);
  await client.query("COMMIT"); console.log(JSON.stringify({source,projects:state.projects.length,stores:state.stores.length,records:state.records.length,auditEvents:state.auditEvents.length},null,2));
} catch(error){ await client.query("ROLLBACK"); throw error; } finally { client.release(); await pool.end(); }
