import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAtlasHttpServer } from "../src/server.js";

test("HTTP MCP exposes only the structured Atlas tool surface", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-mcp-")); const http = createAtlasHttpServer({ dataFile: path.join(directory, "data.json") }); http.listen(0, "127.0.0.1"); await once(http, "listening");
    const address = http.address(); if (!address || typeof address === "string") throw new Error("No address");
    const client = new Client({ name: "test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
    const names = (await client.listTools()).tools.map((x) => x.name); assert.ok(names.includes("create_record")); assert.ok(names.includes("query_records")); assert.ok(!names.includes("ingest_conversation"));
    const status = await client.callTool({ name: "get_atlas_status", arguments: {} }); assert.equal((status.structuredContent as any).result.version, "2.0.0");
    const bridge = await fetch(`http://127.0.0.1:${address.port}/api/tools/get_atlas_status`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(bridge.status, 200); assert.equal((await bridge.json() as any).version, "2.0.0");
    const missing = await fetch(`http://127.0.0.1:${address.port}/api/tools/semantic_search`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(missing.status, 404);
    await client.close(); http.close();
});
