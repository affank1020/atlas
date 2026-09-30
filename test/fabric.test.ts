import assert from "node:assert/strict";
import test,{after} from "node:test";
import {createFabric} from "../src/fabric/index.js";
import {projectRecord,queryTerms} from "../src/fabric/projection.js";
import {cleanupDatabases,databaseFixture} from "./database.js";
after(cleanupDatabases);

test("generic projection preserves field meaning and heterogeneous scalar values",()=>{
 const projection=projectRecord({displayName:"Alpha, Inc.",score:4.5,active:true,due:"2026-10-01",tags:["One","Two"],nested:{memoryVisibility:"Private"},nothing:null,empty:[]});
 assert.match(projection.searchableText,/display name: Alpha, Inc\./); assert.match(projection.searchableText,/score: 4.5/); assert.match(projection.searchableText,/active: true/); assert.match(projection.searchableText,/tags: One/); assert.match(projection.searchableText,/nested memory visibility: Private/); assert.match(projection.displayText,/nothing: null/); assert.match(projection.displayText,/empty: \[\]/);
 assert.deepEqual(queryTerms("  ALPHA, alpha! Memory-Visibility  "),["alpha","memory","visibility"]);
});

test("Fabric searches generically, ranks, filters projects, and stays lifecycle-consistent",async()=>{
 const fixture=await databaseFixture(); const fabric=createFabric(fixture.databaseUrl,null); const {catalog}=fixture;
 try{
  const p1=await catalog.createProject({name:"Research"}); const p2=await catalog.createProject({name:"Operations"});
  const fields=[{name:"title",type:"string" as const,required:true},{name:"details",type:"object" as const},{name:"tags",type:"array" as const}];
  const s1=await catalog.createStore({projectId:p1.id,name:"Reading Notes",fields}); const s2=await catalog.createStore({projectId:p2.id,name:"Action Queue",fields});
  const relevant=await catalog.createRecord({projectId:p1.id,storeId:s1.id,data:{title:"Distributed systems",details:{currentState:"Consensus research"},tags:["systems","reliability"]}});
  await catalog.createRecord({projectId:p1.id,storeId:s1.id,data:{title:"Gardening",details:{topic:"soil"}}}); await catalog.createRecord({projectId:p2.id,storeId:s2.id,data:{title:"Systems review",details:{priority:"active"}}});
  const exact=await fabric.search.search({query:"distributed systems"}); assert.equal(exact.results[0]?.record.id,relevant.id); assert.equal(exact.results[0]?.ranking.exactPhrase,true); assert.ok(exact.results[0]?.matchedFields.includes("title")); assert.equal(exact.diagnostics.searchedProjects,2); assert.equal(exact.diagnostics.searchedStores,2);
  assert.equal((await fabric.search.search({query:"READING notes"})).results[0]?.store.name,"Reading Notes"); assert.ok((await fabric.search.search({query:"distribut"})).results.length>0); assert.equal((await fabric.search.search({query:"missing-unrelated-zebra"})).results.length,0);
  const filtered=await fabric.search.search({query:"systems",projectIds:[p2.id]}); assert.ok(filtered.results.every((x)=>x.project.id===p2.id));
  await catalog.updateRecord({projectId:p1.id,storeId:s1.id,recordId:relevant.id,data:{title:"Queue theory"},replace:true}); assert.equal((await fabric.search.search({query:"distributed"})).results.length,0); assert.equal((await fabric.search.search({query:"queue theory"})).results[0]?.record.id,relevant.id);
  await catalog.updateStore({projectId:p1.id,storeId:s1.id,name:"Knowledge Archive"}); assert.equal((await fabric.search.search({query:"Reading Notes"})).results.length,0); assert.equal((await fabric.search.search({query:"Knowledge Archive"})).results[0]?.store.name,"Knowledge Archive");
  await catalog.updateProject({projectId:p1.id,name:"Learning"}); assert.equal((await fabric.search.search({query:"Research"})).results.length,0); assert.equal((await fabric.search.search({query:"Learning"})).results[0]?.project.name,"Learning");
  await catalog.archiveRecord(p1.id,s1.id,relevant.id); assert.ok((await fabric.search.search({query:"queue theory"})).results.every((x)=>x.record.id!==relevant.id));
 }finally{await fabric.repository.close();}
});

test("context is bounded, cross-project, cross-store, and diagnostic",async()=>{
 const fixture=await databaseFixture(); const fabric=createFabric(fixture.databaseUrl,null); const {catalog}=fixture;
 try{for(const [projectName,storeName,title] of [["One","Notes","shared priority alpha"],["Two","Tasks","shared priority beta"],["Two","Archive","irrelevant"]]){let project=(await catalog.listProjects()).find((x)=>x.name===projectName);if(!project)project=await catalog.createProject({name:projectName});const store=await catalog.createStore({projectId:project.id,name:storeName,fields:[{name:"title",type:"string",required:true}]});await catalog.createRecord({projectId:project.id,storeId:store.id,data:{title}});}
  const context=await fabric.context.request({query:"shared priority",maxRecords:2}); assert.equal(context.selections.length,2); assert.equal(new Set(context.selections.map((x)=>x.project.id)).size,2); assert.equal(new Set(context.selections.map((x)=>x.store.id)).size,2); assert.equal(context.diagnostics.selectedCount,2); assert.equal(context.diagnostics.maxRecords,2); assert.ok(context.diagnostics.candidateCount>=2);
 }finally{await fabric.repository.close();}
});

test("Core remains writable when Fabric derived state is unavailable",async()=>{
 const fixture=await databaseFixture(); const fabric=createFabric(fixture.databaseUrl,null);
 try{await fabric.repository.pool.query("DROP TABLE fabric_search_documents");const project=await fixture.catalog.createProject({name:"Core Independence"});assert.equal((await fixture.catalog.getProject(project.id)).name,"Core Independence");await assert.rejects(()=>fabric.search.search({query:"anything"}));}finally{await fabric.repository.close();}
});
