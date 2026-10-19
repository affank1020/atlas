/** Local disposable schemas only. Run: node --import tsx scripts/benchmark-catalogue.ts */
import { databaseFixture, cleanupDatabases } from '../test/database.js';
import { AtlasCatalog } from '../apps/server/src/catalog.js';
import type { AtlasRepository } from '../apps/server/src/core/repository.js';

try {
    const { store, catalog } = await databaseFixture();
    const p = await catalog.createProject({ name: 'Benchmark' });
    const s = await catalog.createStore({ projectId:p.id, name:'Rows',fields:[{name:'title',type:'string'}] });
    const v = await catalog.createView({ projectId:p.id,name:'Preview',slug:'preview',queries:[{name:'rows',storeId:s.id,limit:10}],html:'{{#each rows}}{{title}}{{/each}}',css:'' });
    await store.pool.query("INSERT INTO records(id,store_id,schema_version,data,created_at,updated_at) SELECT gen_random_uuid(),$1,1,jsonb_build_object('title',repeat('x',500)),now(),now() FROM generate_series(1,10000)",[s.id]);
    await store.pool.query("INSERT INTO audit_events(id,client,operation,project_id,before_state,after_state,created_at) SELECT gen_random_uuid(),'benchmark','record.updated',$1,'{}'::jsonb,jsonb_build_object('title',repeat('x',500)),now() FROM generate_series(1,2000)",[p.id]);
    await store.pool.query('ANALYZE projects; ANALYZE stores; ANALYZE store_schemas; ANALYZE records; ANALYZE views; ANALYZE audit_events');
    const legacy: AtlasRepository = {snapshot:()=>store.snapshot(),transaction:fn=>store.transaction(fn),queryRecords:(s,i)=>store.queryRecords(s,i),close:async()=>{}};
    const before = new AtlasCatalog(legacy);
    const cases: [string,()=>Promise<unknown>,()=>Promise<unknown>][] = [
        ['list_projects',()=>before.listProjects(),()=>catalog.listProjects()],
        ['get_project',()=>before.getProject(p.id),()=>catalog.getProject(p.id)],
        ['status',()=>before.status(),()=>catalog.status()],
        ['audit',()=>before.auditHistory({projectId:p.id,limit:50}),()=>catalog.auditHistory({projectId:p.id,limit:50})],
        ['standalone_view',async()=>{const view=await before.getViewBySlug(p.id,'preview');return before.renderView(p.id,view.id)},()=>catalog.views.renderStandalone(p.id,'preview')],
    ];
    const median=(values:number[])=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)]!;
    for(const [operation,oldRead,newRead] of cases){
        await oldRead();await newRead();
        const oldTimes:number[]=[],newTimes:number[]=[];
        for(let i=0;i<15;i++){
            let start=performance.now();await oldRead();oldTimes.push(performance.now()-start);
            start=performance.now();await newRead();newTimes.push(performance.now()-start);
        }
        console.log(JSON.stringify({operation,iterations:15,beforeMedianMs:+median(oldTimes).toFixed(2),afterMedianMs:+median(newTimes).toFixed(2)}));
    }
    const plan = await store.pool.query('EXPLAIN SELECT * FROM audit_events WHERE project_id=$1 ORDER BY created_at DESC,id ASC LIMIT 50',[p.id]);
    console.log('Audit plan:',plan.rows.map(row=>row['QUERY PLAN']).join('\n'));
} finally { await cleanupDatabases(); }
