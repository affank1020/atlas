import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpTransport, RELAY_READ_TOOLS } from '../apps/server/src/api/mcp/index.js';
import type { TransportServices } from '../apps/server/src/server/dispatch.js';

test('Relay service MCP sees only Atlas read tools and cannot dispatch mutations', async () => {
  const names=['football_generalist_evaluate','football_generalist_baseline',
    'football_generalist_status','football_generalist_evaluation_detail',
    'football_generalist_policies','football_generalist_assessments'];
  const dispatched:string[]=[];
  const services={applications:{tools:()=>names.map(name=>({name,description:name,inputSchema:{}}))},
    dispatch:async (name:string)=>{dispatched.push(name);return {ok:true};}} as unknown as TransportServices;
  const server=createMcpTransport(services,'atlas:relay:read',
    {kind:'mcp-oauth',subject:'relayClientTest12345@clients',issuer:'https://issuer.example/'},RELAY_READ_TOOLS);
  const client=new Client({name:'relay-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);await client.connect(clientTransport);
    const tools=(await client.listTools()).tools.map(t=>t.name);
    assert.deepEqual(new Set(tools),RELAY_READ_TOOLS);
    for(const denied of ['create_project','update_record','workspace_run_dev_task',
      'revoke_node','football_generalist_evaluate','code_reviews_submit_structured'])
      assert.ok(!tools.includes(denied),denied);
    const r=await client.callTool({name:'get_atlas_status',arguments:{}});
    assert.equal(r.isError,undefined);
    assert.deepEqual(dispatched,['get_atlas_status']);
    await assert.rejects(client.callTool({name:'create_project',arguments:{name:'forbidden'}}));
    assert.deepEqual(dispatched,['get_atlas_status']);
  } finally {await client.close();await server.close();}
});
