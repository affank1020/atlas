import assert from "node:assert/strict";
import test,{after} from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import {createFabric} from "../apps/server/src/fabric/index.js";
import {PortfolioMediaService,PortfolioService,PORTFOLIO_SOURCE_TYPE} from "../apps/server/src/apps/portfolio/index.js";
import {cleanupDatabases,databaseFixture} from "./database.js";

after(cleanupDatabases);

test("Portfolio drafts stay out of Fabric until an immutable revision is published",async()=>{
 const fixture=await databaseFixture();const fabric=createFabric(fixture.databaseUrl,null);const portfolio=new PortfolioService(fixture.catalog,fabric.repository,fixture.databaseUrl);
 try{
  const draft=await portfolio.saveDraft({contentType:"projects",data:{title:"Atlas Portfolio Engine",slug:"atlas-portfolio-engine",summary:"An Atlas-native publishing system",tags:["Atlas"]}});
  assert.equal(draft.status,"draft");
  assert.equal((await fabric.search.search({query:"Atlas Portfolio Engine",mode:"lexical"})).results.length,0);
  await portfolio.publish(draft.id,"test-suite");
  const published=await portfolio.getEntry(draft.id);assert.equal(published.status,"published");assert.equal(published.publishedRevision,1);
  const visible=await fabric.search.search({query:"Atlas Portfolio Engine",mode:"lexical",sourceTypes:[PORTFOLIO_SOURCE_TYPE]});assert.equal(visible.results.length,1);assert.equal(visible.results[0]?.record.data.slug,"atlas-portfolio-engine");
  const delivery=await portfolio.publicContent();assert.equal(delivery.work[0]?.title,"Atlas Portfolio Engine");
  await portfolio.saveDraft({contentType:"projects",recordId:draft.id,data:{...draft.data,title:"Changed private title",body:"quasaronlydrafttoken"}});assert.equal((await portfolio.getEntry(draft.id)).status,"changed");assert.equal((await fabric.search.search({query:"quasaronlydrafttoken",mode:"lexical"})).results.length,0);
  assert.equal((await fabric.search.search({query:"Atlas Portfolio Engine",mode:"lexical"})).results.length,1);
  await portfolio.unpublish(draft.id);assert.equal((await fabric.search.search({query:"Atlas Portfolio Engine",mode:"lexical",sourceTypes:[PORTFOLIO_SOURCE_TYPE]})).results.length,0);
 }finally{await portfolio.close();await fabric.repository.close();}
});

test("Portfolio media stores originals and creates image delivery variants",async()=>{
 const fixture=await databaseFixture();const directory=await mkdtemp(path.join(os.tmpdir(),"atlas-media-test-"));const media=new PortfolioMediaService(fixture.databaseUrl,directory);
 try{
  const png=(await sharp({create:{width:2,height:2,channels:4,background:{r:38,g:91,b:62,alpha:1}}}).png().toBuffer()).toString("base64");
  const asset=await media.upload({fileName:"pixel.png",mimeType:"image/png",base64:png,altText:"A single test pixel",client:"test-suite"});
  assert.equal(asset.mimeType,"image/png");assert.equal(asset.altText,"A single test pixel");assert.ok(asset.thumbnailUrl);assert.ok((await media.file(asset.id,"thumbnail")).bytes.length>0);assert.equal((await media.file(asset.id,"original")).mimeType,"image/png");
 }finally{await media.close();await rm(directory,{recursive:true,force:true});}
});
