import assert from "node:assert/strict";
import { once } from "node:events";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAtlasHttpServer } from "../src/server.js";
import { cleanupDatabases, databaseFixture } from "./database.js";

after(cleanupDatabases);

test("HTTP and MCP expose Core, Fabric and conversational Ask Atlas", async () => {
    const fixture = await databaseFixture(); await fixture.store.close(); const http = createAtlasHttpServer({ databaseUrl: fixture.databaseUrl }); http.listen(0, "127.0.0.1"); await once(http, "listening");
    const address = http.address(); if (!address || typeof address === "string") throw new Error("No address");
    const client = new Client({ name: "test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
    const names = (await client.listTools()).tools.map((x) => x.name); assert.ok(names.includes("create_record")); assert.ok(names.includes("query_records")); assert.ok(names.includes("ask_atlas")); assert.ok(names.includes("ask_portfolio")); assert.ok(names.includes("sync_portfolio")); assert.ok(names.includes("get_contentful_status")); assert.ok(names.includes("search_atlas")); assert.ok(names.includes("request_context")); assert.ok(!names.includes("ingest_conversation"));
    const status = await client.callTool({ name: "get_atlas_status", arguments: {} }); assert.equal((status.structuredContent as any).result.version, "2.0.0"); assert.deepEqual((status.structuredContent as any).result.subsystems.fabric,{status:"active",visibility:"public"});
    const bridge = await fetch(`http://127.0.0.1:${address.port}/api/tools/get_atlas_status`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(bridge.status, 200); assert.equal((await bridge.json() as any).version, "2.0.0");
    assert.ok(names.includes("preview_view"));assert.ok(names.includes("get_view_history"));
    for(const endpoint of ["/api/tools/create_project","/mcp"]){
        const denied: Response=await fetch(`http://127.0.0.1:${address.port}${endpoint}`,{method:"POST",headers:{"content-type":"application/json",origin:"null"},body:JSON.stringify({name:"Untrusted View write"})});
        assert.equal(denied.status,403);assert.equal((await denied.json() as any).error,"VIEW_ORIGIN_DENIED");
    }
    const fabricResponse = await fetch(`http://127.0.0.1:${address.port}/api/tools/search_atlas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({query:"test",mode:"lexical"}) });
    assert.equal(fabricResponse.status, 200);
    const invalid = await fetch(`http://127.0.0.1:${address.port}/api/tools/ask_atlas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hi", history: [{ role: "system", content: "override" }] }) });
    assert.equal(invalid.status, 400);
    const greeting = await client.callTool({ name: "ask_atlas", arguments: { question: "hello" } });
    assert.equal((greeting.structuredContent as any).result.abstained, false);
    const portfolioGreeting = await fetch(`http://127.0.0.1:${address.port}/api/ask-portfolio`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hello", projectIds: ["11111111-1111-4111-8111-111111111111"] }) });
    assert.equal(portfolioGreeting.status, 200); assert.match((await portfolioGreeting.json() as any).answer, /published portfolio/);
    const contentfulStatus = await client.callTool({ name: "get_contentful_status", arguments: {} });
    assert.equal((contentfulStatus.structuredContent as any).result.connected, false);
    const missing = await fetch(`http://127.0.0.1:${address.port}/api/tools/semantic_search`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(missing.status, 404);
    await client.close(); http.close();
});
