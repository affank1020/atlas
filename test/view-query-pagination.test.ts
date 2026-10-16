import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { cleanupDatabases, databaseFixture } from './database.js';

after(cleanupDatabases);

test('native Views query all records with bounded server pages, URL-param search and filters',async()=>{
 const {catalog}=await databaseFixture();
 const project=await catalog.createProject({name:'Knowledge View search fixture'});
 const store=await catalog.createStore({projectId:project.id,name:'Knowledge Entries',fields:[
  {name:'entryKey',type:'string',required:true},{name:'title',type:'string',required:true},
  {name:'summary',type:'string'},{name:'groupKeys',type:'array',required:true},
  {name:'sourceKey',type:'string',required:true},{name:'tags',type:'array'}]});
 const operations=Array.from({length:145},(_,i)=>({action:'create' as const,data:{
   entryKey:'key-'+i,title:'Concept '+String(i).padStart(3,'0'),
   summary:i===144?'unique hidden evidence':'ordinary theory notes',
   groupKeys:i%2===0?['ux']:['fyp'],sourceKey:i%2===0?'ux-book':'fyp-paper',
   tags:i===144?['rare-topic']:['general'],
 }}));
 await catalog.bulkRecords({projectId:project.id,storeId:store.id,operations:operations.slice(0,100)});
 await catalog.bulkRecords({projectId:project.id,storeId:store.id,operations:operations.slice(100)});
 const manifest={viewKitVersion:1 as const,capabilities:['url-params' as const],
  params:{q:'',offset:'0',group:'',source:'',tag:''}};
 const queries=[{name:'entries',storeId:store.id,limit:25,
  searchParam:'q',offsetParam:'offset',sort:[{field:'title',direction:'asc' as const}],
  paramFilters:[{param:'group',field:'groupKeys',operator:'contains' as const},
  {param:'source',field:'sourceKey',operator:'eq' as const},
  {param:'tag',field:'tags',operator:'contains' as const}]}];
 const view=await catalog.createView({projectId:project.id,name:'Knowledge',slug:'knowledge',
  queries,manifest,html:'{{#each entries}}<p>{{title}}</p>{{/each}}',css:''});
 const first=await catalog.renderView(project.id,view.id);
 assert.equal(first.data.entries.length,25);
 assert.deepEqual(first.data.entriesPage[0],{total:145,offset:0,limit:25,pageStart:1,pageEnd:25,hasNext:true,hasPrevious:false});
 const next=await catalog.renderView(project.id,view.id,{offset:'125'});
 assert.equal(next.data.entries.length,20);
 assert.equal(next.data.entries[19]?.title,'Concept 144');
 assert.equal(next.data.entriesPage[0]?.total,145);
 const match=await catalog.renderView(project.id,view.id,{q:'unique hidden evidence'});
 assert.equal(match.data.entries.length,1);
 assert.equal(match.data.entries[0]?.title,'Concept 144');
 const filtered=await catalog.renderView(project.id,view.id,{group:'ux',tag:'rare-topic'});
 assert.equal(filtered.data.entries.length,1);
 assert.equal(filtered.data.entries[0]?.title,'Concept 144');
 const source=await catalog.renderView(project.id,view.id,{source:'fyp-paper'});
 assert.equal(source.data.entriesPage[0]?.total,72);
 const escaped=await catalog.renderView(project.id,view.id,{q:"%' OR 1=1 --"});
 assert.equal(escaped.data.entries.length,0);
 const invalidOffset=await catalog.renderView(project.id,view.id,{offset:'-100'});
 assert.equal(invalidOffset.data.entriesPage[0]?.offset,0);
 await assert.rejects(catalog.createView({projectId:project.id,name:'Invalid Param Query',
  queries:[{name:'entries',storeId:store.id,searchParam:'q'}],
  html:'<p>invalid</p>',css:''}),/declared|manifest/i);
});
