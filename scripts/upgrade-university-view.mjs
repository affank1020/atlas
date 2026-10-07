import {readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const projectId='54b51649-1be2-4c54-bb15-11c825939a6f';
const viewId='f97b76e9-a4a5-4662-adb9-138810b0e102';
const client=new Client({name:'University Views V3 migration',version:'1'});
try{
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp')));
 const call=async(name,args)=>{const response=await client.callTool({name,arguments:args});if(response.isError)throw new Error(JSON.stringify(response.content));return response.structuredContent.result};
 const current=await call('get_view',{projectId,viewId});
 const before=JSON.parse(await readFile(new URL('../apps/server/examples/views/university-v2-reference.json',import.meta.url),'utf8'));
 const next=JSON.parse(await readFile(new URL('../apps/server/examples/views/university-v3.json',import.meta.url),'utf8'));
 if(current.slug!==next.slug)throw new Error('Unexpected University View slug.');
 if(current.script!==before.script&&current.script!==next.script)throw new Error('Dashboard changed after inspection; inspect before migrating.');
 if(JSON.stringify(current.queries)!==JSON.stringify(before.queries)&&JSON.stringify(current.queries)!==JSON.stringify(next.queries))throw new Error('Queries changed after inspection.');
 const policyBefore=await call('list_records',{projectId,storeId:'9ad508b8-6d86-4d2c-8d3e-23682fc7b894',limit:100});
 const preview=await call('preview_view',{projectId,...next});
 await call('update_view',{projectId,viewId,...next,expectedUpdatedAt:current.updatedAt});
 const policyAfter=await call('list_records',{projectId,storeId:'9ad508b8-6d86-4d2c-8d3e-23682fc7b894',limit:100});
 if(JSON.stringify(policyBefore)!==JSON.stringify(policyAfter))throw new Error('Guidance changed during migration; inspect concurrent edits.');
 console.log(JSON.stringify({viewId,standalone:preview.standalonePath??`/projects/${projectId}/views/${next.slug}`,queries:preview.diagnostics.queries,policyUnchanged:true},null,2));
}finally{await client.close()}
