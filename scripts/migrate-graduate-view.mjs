// Explicit, repeatable reference migration through MCP. Query definitions and IDs are preserved.
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const [projectId, viewId] = process.argv.slice(2);
if (!projectId || !viewId) throw new Error('Usage: node scripts/migrate-graduate-view.mjs PROJECT_ID VIEW_ID');
const client = new Client({name:'Atlas View Kit reference migration',version:'1.0.0'});
try {
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp')));
 const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error(JSON.stringify(result.content));return result.structuredContent.result};
 const view=await call('get_view',{projectId,viewId});
 if(view.name!=='Graduate Applications Dashboard'||!view.queries.some(q=>q.name==='applications'))throw new Error('Expected Graduate Applications Dashboard with applications binding.');
 const definition=JSON.parse(await readFile(new URL('../apps/server/examples/views/graduate-applications.json',import.meta.url),'utf8'));
 await call('preview_view',{projectId,queries:view.queries,...definition});
 await call('update_view',{projectId,viewId,expectedUpdatedAt:view.updatedAt,...definition});
 const rendered=await call('render_view',{projectId,viewId});
 console.log(JSON.stringify({view:rendered.view,manifest:rendered.manifest,queries:rendered.diagnostics.queries}));
} finally { await client.close(); }
