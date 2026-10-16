
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';
import { KnowledgeStudyService, studyDeckSchema } from '../apps/server/src/apps/knowledge-study.js';

after(cleanupDatabases);
test('study deck scales beyond 100 cards and saves per-card spaced-review state', async ()=>{
  const { catalog,store }=await databaseFixture();
  const project=await catalog.createProject({name:'Study fixture'});
  const fields=[
    {name:'cardKey',type:'string' as const,required:true},{name:'question',type:'string' as const,required:true},
    {name:'expectedAnswer',type:'string' as const,required:true},{name:'groupKeys',type:'array' as const,required:true},
    {name:'sourceKey',type:'string' as const,required:true},{name:'cardType',type:'string' as const,required:true},
    {name:'status',type:'string' as const,required:true},
  ];
  const cards=await catalog.createStore({projectId:project.id,name:'Knowledge Study Cards',fields});
  const progress=await catalog.createStore({projectId:project.id,name:'Knowledge Review Progress',fields:[
    {name:'cardKey',type:'string',required:true},{name:'reviews',type:'number',required:true},
    {name:'streak',type:'number',required:true},{name:'intervalDays',type:'number',required:true},
    {name:'lastRating',type:'string',required:true},{name:'lastReviewedAt',type:'datetime',required:true},
    {name:'nextDueAt',type:'datetime',required:true},
  ]});
  const service=new KnowledgeStudyService(catalog,store.pool,project.id,cards.id,progress.id);
  const ops=Array.from({length:125},(_,i)=>({action:'create' as const,data:{
    cardKey:'c-'+String(i).padStart(3,'0'),question:'Practice '+String(i).padStart(3,'0'),
    expectedAnswer:'Answer '+i,groupKeys:i===124?['fyp']:['ux'],
    sourceKey:i===124?'paper':'notes',cardType:i%2===0?'recall':'assessment',status:'active'
  }}));
  await catalog.bulkRecords({projectId:project.id,storeId:cards.id,operations:ops.slice(0,100)});
  await catalog.bulkRecords({projectId:project.id,storeId:cards.id,operations:ops.slice(100)});
  const initial=await service.deck(studyDeckSchema.parse({mode:'due',limit:30}));
  assert.equal(initial.total,125);
  assert.equal(initial.items.length,30);
  const tail=await service.deck(studyDeckSchema.parse({mode:'all',limit:30,offset:110}));
  assert.equal(tail.total,125);
  assert.equal(tail.items.length,15);
  assert.equal(tail.offset,110);
  const filtered=await service.deck(studyDeckSchema.parse({group:'fyp',mode:'all'}));
  assert.equal(filtered.total,1);
  assert.equal(filtered.items[0]?.cardKey,'c-124');
  const card=initial.items[0]?.cardKey as string;
  const first=await service.rate({cardKey:card,rating:'good'});
  assert.equal(first.reviews,1);
  assert.equal(first.streak,1);
  assert.equal(first.intervalDays,3);
  assert.ok(new Date(first.nextDueAt).getTime()>Date.now());
  const due=await service.deck(studyDeckSchema.parse({mode:'due',limit:30}));
  assert.equal(due.total,124);
  assert.ok(!due.items.some(x=>x.cardKey===card));
  const all=await service.deck(studyDeckSchema.parse({mode:'all',limit:30}));
  assert.equal(all.total,125);
  const again=await service.rate({cardKey:card,rating:'again'});
  assert.equal(again.reviews,2);
  assert.equal(again.streak,0);
  assert.equal(again.intervalDays,0);
  assert.ok(new Date(again.nextDueAt).getTime()>Date.now());
  const saved=await catalog.queryRecords({projectId:project.id,storeId:progress.id,filters:[
    {field:'cardKey',operator:'eq',value:card}],limit:20});
  assert.equal(saved.total,1);
  await assert.rejects(service.rate({cardKey:'nonexistent',rating:'good'}),/not found/i);
});
