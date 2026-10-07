// Generate a real-browser regression page; the deliberately hostile script bypasses
// authoring validation so these checks exercise the browser boundary itself.
// npm run build && node test/view-browser-fixture.mjs ../atlas-ui/public/__view-runtime-test.html
import {writeFile} from 'node:fs/promises';
import {viewDocument} from '../dist/src/view-runtime.js';
const target=process.argv[2];if(!target)throw new Error('Provide an output HTML path');
const script=String.raw`
atlas.onReady(async () => {
 const results=[];const check=(name,pass)=>results.push({name,pass});
 check('Query data supplied',atlas.data.items[0].company==='LSEG');
 check('URL parameter supplied',atlas.params.q==='LSEG');
 check('Shared component',document.querySelector('atlas-header h1').textContent==='Boundary test');
 check('Custom CSS',getComputedStyle(document.querySelector('#custom')).color==='rgb(1, 2, 3)');
 let parentBlocked=false;try{parent.document.body}catch{parentBlocked=true}check('Parent DOM blocked',parentBlocked);
 let cookiesBlocked=false;try{document.cookie}catch{cookiesBlocked=true}check('Cookies blocked',cookiesBlocked);
 let storageBlocked=false;try{localStorage.getItem('x')}catch{storageBlocked=true}check('Storage blocked',storageBlocked);
 let networkBlocked=false;try{await fetch('http://127.0.0.1:3000/api/tools/__view_security_probe__',{method:'POST',body:'{}'})}catch{networkBlocked=true}check('Direct Atlas request blocked',networkBlocked);
 const workerBlocked=await new Promise(resolve=>{try{const worker=new Worker('data:text/javascript,postMessage(1)');worker.onerror=event=>{event.preventDefault();worker.terminate();resolve(true)};worker.onmessage=()=>{worker.terminate();resolve(false)}}catch{resolve(true)}});check('Worker blocked',workerBlocked);
 let evalBlocked=false;try{eval('1+1')}catch{evalBlocked=true}check('Eval blocked',evalBlocked);
 check('No mutation API',typeof atlas.updateRecord==='undefined');
 atlas.setParam('q','interview');check('Parameter state updates',atlas.params.q==='interview');
 let unknownBlocked=false;try{atlas.setParam('other','x')}catch{unknownBlocked=true}check('Unknown parameter blocked',unknownBlocked);
 const output=document.createElement('pre');output.id='boundary-results';output.textContent=JSON.stringify(results,null,2);document.body.append(output);
 parent.postMessage({type:'boundary-results',results},'*');
});`;
const doc=viewDocument({html:'<atlas-page><atlas-header title="Boundary test"></atlas-header><p id="custom">Custom CSS</p><atlas-tabs label="Samples"><section label="First">First panel</section><section label="Second">Second panel</section></atlas-tabs><atlas-progress label="Coverage" value="80"></atlas-progress><atlas-table sortable filterable><table><thead><tr><th>Company</th></tr></thead><tbody><tr><td>Macquarie</td></tr><tr><td>LSEG</td></tr></tbody></table></atlas-table></atlas-page>',css:'#custom{color:rgb(1,2,3)}',script,manifest:{viewKitVersion:1,capabilities:['client-script','url-params'],params:{q:''}},data:{items:[{company:'LSEG'}]},params:{q:'LSEG'}});
const encoded=JSON.stringify(doc).replaceAll('<','\\u003c');
await writeFile(target,`<!doctype html><html><head><title>Atlas View browser regression</title></head><body><h1>Atlas View browser regression</h1><p id="status">Running…</p><iframe id="test" title="View security test" sandbox="allow-scripts" style="width:100%;height:850px"></iframe><pre id="results"></pre><script>const frame=document.getElementById('test');let param=false;addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!=='null')return;if(event.data.type==='atlas-view-param')param=event.data.key==='q'&&event.data.value==='interview';if(event.data.type==='boundary-results'){const results=[...event.data.results,{name:'Opaque-origin parameter bridge',pass:param}];document.getElementById('status').textContent=results.every(r=>r.pass)?'PASS: '+results.length+' browser checks':'FAIL';document.getElementById('results').textContent=JSON.stringify(results,null,2)}});frame.srcdoc=${encoded};</script></body></html>`);
console.log(target);
