import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {cleanupDatabases,databaseFixture} from './database.js';
import {validateManifest,validatePresentation,validateParams,renderTemplate} from '../src/views.js';
import {viewDocument} from '../src/view-runtime.js';
import {callAtlasTool} from '../src/tools.js';
after(cleanupDatabases);
const manifest={viewKitVersion:1 as const,capabilities:['client-script','url-params'] as ('client-script'|'url-params')[],params:{q:''}};

test('manifest and capability validation rejects unsupported features and undeclared parameters',()=>{
 for(const value of [{viewKitVersion:2},{capabilities:['arbitrary-actions']},{capabilities:['clipboard']},{unknown:true},{params:{q:''}},{capabilities:['client-script','client-script']}])assert.throws(()=>validateManifest(value));
 assert.throws(()=>validateParams(manifest,{other:'x'}),/Undeclared/);
 assert.throws(()=>validateParams(manifest,{q:42}),/string/);
 assert.throws(()=>validatePresentation('<p>Hi</p>','',undefined,'console.log(1)'),/client-script/);
 assert.throws(()=>validatePresentation('<p>{{params.q}}</p>',''),/url-params/);
 assert.throws(()=>validatePresentation('<atlas-table param="other"></atlas-table>','',manifest),/Undeclared/);
 assert.deepEqual(validateParams(manifest,{q:'LSEG'}),{q:'LSEG'});
});

test('parsed markup and script validation rejects executable markup and prohibited APIs',()=>{
 for(const html of ['<script>alert(1)</script>','<svg onload="alert(1)"></svg>','<img src=x>','<iframe></iframe>','<button onclick="x()">Go</button>','<form></form>','<meta http-equiv="refresh" content="0;url=https://example.com">'])assert.throws(()=>validatePresentation(html,'',manifest));
 for(const script of ['fetch("/api/tools/update_record")','parent.document.body','document.cookie','window.top','eval("x")','const =','import("x")','[].constructor.constructor("return this")()','const x="location"; document[x]','document.querySelector("p").setAttribute("onclick","x()")','document.querySelector("a").setAttribute("href","https://example.com")','document.querySelector("a").setAttribute("rel","opener")','document.querySelector("a").removeAttribute("rel")'])assert.throws(()=>validatePresentation('<p>Hi</p>','',manifest,script));
 validatePresentation('<label>Find<input type="search"></label><button>Toggle</button><dialog>Hello</dialog>','p{color:var(--atlas-text)}',manifest,'atlas.onReady(() => { document.querySelector("p").textContent = atlas.params.q; });');
 assert.equal(renderTemplate('{{value missing}} {{number amount}} {{percent ratio}} {{date when}}',{amount:1234,ratio:.5,when:'2027-01-01'}),'— 1,234 50% 1 Jan 2027');
});

test('external links are checked after interpolation and open with safe new-tab attributes',()=>{
 for(const href of ['https://example.com/path?q=1','http://example.org:8080/','HTTPS://example.com/']){
  const html=`<p><a href="${href}">Visit</a></p>`;
  validatePresentation(html,'',manifest);
  assert.equal(renderTemplate(html,{},manifest),`<p><a href="${href}" target="_blank" rel="noopener noreferrer">Visit</a></p>`);
 }
 const template='<a href="{{url}}">Visit</a>';
 validatePresentation(template,'',manifest);
 validatePresentation('<a href="https://example.com">Visit</a>','');
 assert.equal(renderTemplate(template,{url:'https://example.com/?a=1&b=2'},manifest),'<a href="https://example.com/?a&#x3D;1&amp;b&#x3D;2" target="_blank" rel="noopener noreferrer">Visit</a>');
 assert.equal(renderTemplate('<a href="https://one.test">One</a><a href="http://two.test">Two</a>',{},manifest),'<a href="https://one.test" target="_blank" rel="noopener noreferrer">One</a><a href="http://two.test" target="_blank" rel="noopener noreferrer">Two</a>');
 for(const href of ['javascript:alert(1)','data:text/html,hi','mailto:a@example.com','ftp://example.com','//example.com','/relative','https://','https:///example.com','https://user@example.com','https://example.com\\@evil.test','https://example.com\n.evil.test',' https://example.com','https://example.com:bad']){
  assert.throws(()=>validatePresentation(`<a href="${href}">Visit</a>`,'',manifest),/valid http/);
  assert.throws(()=>renderTemplate(template,{url:href},manifest),/valid http/);
 }
 for(const html of ['<div href="https://example.com">x</div>','<a href="https://example.com" target="_self">x</a>','<a href="https://example.com" rel="opener">x</a>','<a href="https://example.com" onclick="alert(1)">x</a>'])assert.throws(()=>validatePresentation(html,'',manifest));
});

test('Stage 2 roundtrip, preview, data, params, revisions, concurrency and archive preserve contracts',async()=>{
 const {catalog}=await databaseFixture();const project=await catalog.createProject({name:'Stage 2'});const store=await catalog.createStore({projectId:project.id,name:'Applications',fields:[{name:'company',type:'string'},{name:'status',type:'string'}]});
 await catalog.createRecord({projectId:project.id,storeId:store.id,data:{company:'LSEG',status:'active'}});
 const input={projectId:project.id,name:'Dashboard',queries:[{name:'applications',storeId:store.id}],template:'<atlas-page><atlas-header title="{{params.q}}"></atlas-header>{{#each applications}}<atlas-card>{{company}}</atlas-card>{{/each}}</atlas-page>',css:'atlas-card{padding:2rem}',script:'atlas.onReady(() => { document.body.dataset.count = String(atlas.data.applications.length); });',manifest};
 const preview=await callAtlasTool(catalog,'preview_view',{...input,params:{q:'Search'}}) as any;
 assert.equal((await catalog.listViews(project.id)).length,0);assert.match(preview.renderedHtml,/Search/);assert.equal(preview.data.applications[0].company,'LSEG');assert.equal(preview.data.applications[0].status,'active');assert.equal(preview.data.applications[0]._atlas.storeId,store.id);
 const view=await catalog.createView(input);const rendered=await catalog.renderView(project.id,view.id,{q:'Search'});
 assert.match(rendered.document,/customElements.define/);assert.match(rendered.document,/--atlas-space/);assert.match(rendered.document,/atlas-card\{padding:2rem\}/);assert.match(rendered.document,/script-src 'sha256-/);assert.match(rendered.document,/connect-src 'none'/);assert.match(rendered.document,/worker-src 'none'/);
 const updated=await catalog.updateView({projectId:project.id,viewId:view.id,script:'atlas.onReady(() => {});',expectedUpdatedAt:view.updatedAt});
 assert.equal(updated.id,view.id);assert.deepEqual((await catalog.getView(project.id,view.id)).manifest,manifest);
 await assert.rejects(()=>catalog.updateView({projectId:project.id,viewId:view.id,css:'',expectedUpdatedAt:view.updatedAt}),/changed since/);
 const history=await catalog.viewHistory(project.id,view.id);assert.equal((history[0]!.previous as any).script,input.script);assert.deepEqual((history[0]!.resulting as any).manifest,manifest);
 await catalog.archiveView(project.id,view.id);await assert.rejects(()=>catalog.renderView(project.id,view.id),/archived/);assert.equal((await catalog.listViews(project.id)).length,0);assert.equal((await catalog.viewHistory(project.id,view.id)).length,3);
});

test('Graduate dashboard reference renders live and empty data and retains legacy HTML callers',async()=>{
 const {catalog}=await databaseFixture();const project=await catalog.createProject({name:'Reference'});const store=await catalog.createStore({projectId:project.id,name:'Applications',fields:[{name:'company',type:'string'},{name:'status',type:'string'}]});
 const definition=JSON.parse(await readFile('examples/views/graduate-applications.json','utf8'));
 const input={projectId:project.id,queries:[{name:'applications',storeId:store.id}],...definition};
 assert.match((await catalog.previewView(input)).renderedHtml,/No applications yet/);
 await catalog.createRecord({projectId:project.id,storeId:store.id,data:{company:'Macquarie',status:'active'}});
 const live=await catalog.previewView(input);assert.match(live.renderedHtml,/Macquarie/);assert.match(live.renderedHtml,/atlas-table sortable filterable/);assert.match(live.renderedHtml,/—/);
 const legacy=await catalog.createView({projectId:project.id,name:'Legacy',queries:input.queries,html:'{{#each applications}}<p>{{company}}</p>{{/each}}',css:'p{color:green}'});
 const result=await catalog.renderView(project.id,legacy.id);assert.equal(result.renderedHtml,'<p>Macquarie</p>');assert.match(result.document,/p\{color:green\}/);assert.doesNotMatch(result.document,/customElements.define/);
});

test('query data cannot close its JSON script boundary or inject unapproved script',()=>{
 const doc=viewDocument({html:'<p>Safe</p>',css:'',data:{items:['</script><script>alert(1)</script>']},params:{},manifest:{}});
 assert.match(doc,/\\u003c\/script>/);assert.equal((doc.match(/<script>/g)||[]).length,1);
});
