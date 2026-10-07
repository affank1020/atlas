import {readFile} from 'node:fs/promises';
import type {AtlasCatalog} from '../apps/server/src/catalog.js';
import type {FieldDefinition,ViewAction,ViewQuery} from '../apps/server/src/types.js';
export async function universityFixture(catalog:AtlasCatalog){
 const project=await catalog.createProject({name:'University V3 regression'});
 const schemas=JSON.parse(await readFile('apps/server/examples/views/university-store-schemas.json','utf8')) as {id:string;name:string;fields:FieldDefinition[]}[];
 const ids=new Map<string,string>();const byName=new Map<string,string>();
 for(const schema of schemas){const store=await catalog.createStore({projectId:project.id,name:schema.name,fields:schema.fields});ids.set(schema.id,store.id);byName.set(schema.name,store.id)}
 const add=(name:string,data:Record<string,unknown>)=>catalog.createRecord({projectId:project.id,storeId:byName.get(name)!,data});
 await add('Modules',{code:'MATH37011',name:'Markov Processes',academicYear:'2026–27',teachingPeriod:'semester_1',status:'active'});
 const policy=await add('Project Guidance',{scope:'Task Prioritisation Policy v1',rule:'Keep existing deterministic ranking',details:'Regression fixture; immutable policy.'});
 const first=await add('Study Tasks',{moduleCode:'MATH37011',title:'Read Markov notes',type:'reading',status:'not_started',week:1,weekStart:'2026-09-28',order:1,required:true,priority:'high'});
 const second=await add('Study Tasks',{moduleCode:'MATH37011',title:'Solve Markov exercises',type:'problem_set',status:'not_started',week:1,weekStart:'2026-09-28',order:2,required:true,priority:'high'});
 await add('Topics',{moduleCode:'MATH37011',name:'Transition probabilities',status:'learning',confidence:2});
 await add('Assessments',{moduleCode:'MATH37011',title:'Final Exam',type:'exam',status:'not_started'});
 await add('Study Activity',{moduleCode:'MATH37011',date:'2026-10-06',type:'reading',activity:'Studied transitions'});
 await add('Attempts',{moduleCode:'MATH37011',date:'2026-10-06',questionSummary:'Find the transition matrix',result:'partial'});
 const reference=JSON.parse(await readFile('apps/server/examples/views/university-v3.json','utf8'));
 reference.queries=reference.queries.map((q:ViewQuery)=>({...q,storeId:ids.get(q.storeId)!}));
 reference.actions=reference.actions.map((a:ViewAction)=>({...a,storeId:ids.get(a.storeId)!}));
 const view=await catalog.createView({projectId:project.id,...reference});
 return {project,view,first,second,policy,byName};
}
