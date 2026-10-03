import "dotenv/config";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client=new Client({name:"fabric-live-verifier",version:"1"});await client.connect(new StreamableHTTPClientTransport(new URL(process.env.ATLAS_URL??"http://127.0.0.1:3000/mcp")));
const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error(result.content?.[0]?.text);return result.structuredContent.result;};
const queries=["Macquarie assessment","memory visibility","Atlas decisions","graduate job search","systems thinking"];
const searches=[];for(const query of queries){const response=await call("search_atlas",{query,limit:3});searches.push({query,diagnostics:response.diagnostics,results:response.results.map((x)=>({project:x.project.name,store:x.store.name,recordId:x.record.id,key:Object.values(x.record.data).filter((v)=>typeof v==="string").slice(0,3),score:x.score,reasons:x.reasons,ranking:x.ranking}))});}
const context=await call("request_context",{query:"What context would another AI need to understand my current graduate job search?",maxRecords:10});
console.log(JSON.stringify({searches,context:{diagnostics:context.diagnostics,projects:[...new Set(context.selections.map((x)=>x.project.name))],stores:[...new Set(context.selections.map((x)=>x.store.name))],selections:context.selections.map((x)=>({project:x.project.name,store:x.store.name,recordId:x.record.id,score:x.score,reasons:x.reasons}))}},null,2));await client.close();
import "dotenv/config";
