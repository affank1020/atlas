import assert from "node:assert/strict";
import test,{after} from "node:test";
import {createFabric} from "../apps/server/src/fabric/index.js";
import {projectRecord} from "../apps/server/src/fabric/projection.js";
import {cleanupDatabases,databaseFixture} from "./database.js";
after(cleanupDatabases);

test("Stage 1.5 fixed deterministic retrieval regression matrix",async()=>{
 const fixture=await databaseFixture();const fabric=createFabric(fixture.databaseUrl,null);const {catalog}=fixture;
 try{
  const one=await catalog.createProject({name:"Career Systems"});const two=await catalog.createProject({name:"Personal Context"});
  const fields=[{name:"title",type:"string" as const,required:true},{name:"details",type:"string" as const},{name:"sourceReference",type:"string" as const},{name:"link",type:"string" as const},{name:"nested",type:"object" as const},{name:"tags",type:"array" as const},{name:"active",type:"boolean" as const},{name:"score",type:"number" as const}];
  const applications=await catalog.createStore({projectId:one.id,name:"Opportunities",fields});const profile=await catalog.createStore({projectId:two.id,name:"Working Notes",fields});
  const oa=await catalog.createRecord({projectId:one.id,storeId:applications.id,data:{title:"OA Received",details:"Macquarie assessment preparation",sourceReference:"abc1234567890xyz9876543210",link:"https://example.test/noisy/oa/path?id=42",nested:{currentState:"submitted"},tags:["graduate","assessment"],active:true,score:9}});
  const noise=await catalog.createRecord({projectId:one.id,storeId:applications.id,data:{title:"Board review",details:"Unrelated planning",sourceReference:"xxoa1234567890machineopaque99",link:"https://example.test/oa",active:false,score:1}});
  const systems=await catalog.createRecord({projectId:two.id,storeId:profile.id,data:{title:"Systems thinking",details:"Memory visibility and current active threads",tags:["graduate","job","search"]}});
  const duplicateSmall=await catalog.createRecord({projectId:one.id,storeId:applications.id,data:{title:"LSEG OA completed",details:"Graduate software engineer London submitted assessment completed",tags:["LSEG","graduate"]}});
  const duplicateRich=await catalog.createRecord({projectId:two.id,storeId:profile.id,data:{title:"LSEG OA completed",details:"Graduate software engineer London submitted assessment completed",tags:["LSEG","graduate","career"],nested:{currentState:"Online assessment completed and recorded"}}});

  const projection=projectRecord(oa.data);assert.match(projection.displayText,/abc1234567890xyz9876543210/);assert.doesNotMatch(projection.searchableText,/abc1234567890xyz9876543210/);assert.doesNotMatch(projection.searchableText,/https:\/\//);assert.ok(projection.displayOnlyFields.some((x)=>x.path==="sourceReference"&&x.reason==="opaque-identifier"));assert.ok(projection.displayOnlyFields.some((x)=>x.path==="link"&&x.reason==="url"));
  assert.equal((await fabric.search.search({query:"Macquarie assessment"})).results[0]?.record.id,oa.id);assert.equal((await fabric.search.search({query:"MEMORY VISIBILITY"})).results[0]?.record.id,systems.id);assert.equal((await fabric.search.search({query:"systems thinking"})).results[0]?.record.id,systems.id);
  const short=await fabric.search.search({query:"OA"});assert.ok(short.results.some((x)=>x.record.id===oa.id));assert.ok(short.results.every((x)=>x.record.id!==noise.id));assert.ok(short.results.every((x)=>x.reasons.includes("token-boundary term coverage")));
  assert.equal((await fabric.search.search({query:"abc1234567890xyz9876543210"})).results.length,0);assert.equal((await fabric.search.search({query:"example.test/noisy"})).results.length,0);assert.equal((await fabric.search.search({query:"totally nonexistent quasar"})).results.length,0);
  const cross=await fabric.search.search({query:"graduate"});assert.equal(new Set(cross.results.map((x)=>x.project.id)).size,2);const filtered=await fabric.search.search({query:"graduate",projectIds:[two.id]});assert.ok(filtered.results.every((x)=>x.project.id===two.id));
  const order1=(await fabric.search.search({query:"graduate",limit:20})).results.map((x)=>x.record.id);const order2=(await fabric.search.search({query:"graduate",limit:20})).results.map((x)=>x.record.id);assert.deepEqual(order1,order2);assert.ok((await fabric.search.search({query:"graduate",limit:2})).results.length<=2);
  const floor=await fabric.context.request({query:"Macquarie assessment irrelevant absent",maxRecords:10});assert.ok(floor.selections.length<10);assert.ok(floor.diagnostics.relevanceFloorRejected>0);
  const diversified=await fabric.context.request({query:"LSEG OA completed",maxRecords:5});assert.ok(diversified.selections.some((x)=>x.record.id===duplicateRich.id));assert.ok(diversified.selections.every((x)=>x.record.id!==duplicateSmall.id));assert.ok(diversified.diagnostics.redundancyRejected>=1);assert.ok(diversified.selections.length<=5);
  await catalog.updateRecord({projectId:one.id,storeId:applications.id,recordId:oa.id,data:{title:"Interview scheduled",details:"New phase"},replace:true});assert.ok((await fabric.search.search({query:"Macquarie assessment"})).results.every((x)=>x.record.id!==oa.id));assert.equal((await fabric.search.search({query:"Interview scheduled"})).results[0]?.record.id,oa.id);await catalog.archiveRecord(one.id,applications.id,oa.id);assert.ok((await fabric.search.search({query:"Interview scheduled"})).results.every((x)=>x.record.id!==oa.id));
 }finally{await fabric.repository.close();}
});
