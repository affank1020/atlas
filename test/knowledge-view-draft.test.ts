import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, {after} from 'node:test';
import {cleanupDatabases,databaseFixture} from './database.js';
import {validatePresentation} from '../apps/server/src/views.js';

after(cleanupDatabases);

test('staged Knowledge Bank View passes sandbox and renders with server-side declared filters',async()=>{
 const draft=JSON.parse(readFileSync(new URL('../docs/knowledge-bank-view-server-search.json',import.meta.url),'utf8'));
 assert.deepEqual(Object.keys(draft.manifest.params).sort(),[
  'entryOffset','group','kind','q','relationOffset','sectionOffset','source','sourceOffset','sourceType','tag'
 ].sort());
 validatePresentation(draft.html,draft.css,draft.manifest,draft.script);
 const {catalog}=await databaseFixture();
 const project=await catalog.createProject({name:'View draft verification'});
 const groups=await catalog.createStore({projectId:project.id,name:'Groups',fields:[
  {name:'name',type:'string'},{name:'key',type:'string'}
 ]});
 const sources=await catalog.createStore({projectId:project.id,name:'Sources',fields:[
  {name:'title',type:'string'},{name:'sourceKey',type:'string'}, {name:'sourceType',type:'enum',enumValues:['lecture_notes','paper']},
  {name:'groupKeys',type:'array'},{name:'tags',type:'array'}
 ]});
 const sections=await catalog.createStore({projectId:project.id,name:'Sections',fields:[
  {name:'title',type:'string'},{name:'groupKeys',type:'array'},{name:'sourceKey',type:'string'},{name:'tags',type:'array'}
 ]});
 const entries=await catalog.createStore({projectId:project.id,name:'Entries',fields:[
  {name:'title',type:'string'},{name:'kind',type:'enum',enumValues:['concept','example']},
  {name:'summary',type:'string'},{name:'sourceExcerpt',type:'string'},
  {name:'groupKeys',type:'array'},{name:'sourceKey',type:'string'},{name:'tags',type:'array'}
 ]});
 const relations=await catalog.createStore({projectId:project.id,name:'Relations',fields:[
  {name:'evidenceSourceKey',type:'string'},{name:'tags',type:'array'}
 ]});
 await catalog.createRecord({projectId:project.id,storeId:entries.id,data:{
  title:'Critical user testing',kind:'concept',summary:'Question assumptions',
  sourceExcerpt:'Always ask why',groupKeys:['ux'],sourceKey:'core-notes',tags:['critical-thinking']
 }});
 const known=new Map([
  ['groups',groups.id],['sources',sources.id],['sections',sections.id],
  ['entries',entries.id],['relations',relations.id]
 ]);
 const queries=draft.queries.map((q:any)=>({...q,storeId:known.get(q.name)}));
 const v=await catalog.previewView({projectId:project.id,queries,manifest:draft.manifest,
  html:draft.html,css:draft.css,script:draft.script,params:{q:'Always ask',group:'ux'}});
 assert.equal(v.data.entriesPage[0]?.total,1);
 assert.equal(v.data.entries[0]?.title,'Critical user testing');
 assert.match(v.renderedHtml,/Original notes/);
 assert.match(v.renderedHtml,/Always ask why/);
 assert.match(v.renderedHtml,/Search all records/);
 assert.match(v.document,/kb-reader/);
});
