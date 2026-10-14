import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpTransport } from '../apps/server/src/api/mcp/index.js';
import { footballTrainingApplication } from '../apps/server/src/apps/football-training.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';

test('MCP exposes generalist benchmark tools within first 100 and preserves typed dispatch', async () => {
    const invocations: Array<{ action: string; input: unknown }> = [];
    const applications = new ApplicationRegistry([footballTrainingApplication({
        call: async (action: string, input: Record<string, unknown>) => {
            invocations.push({ action, input });
            return { accepted: true, action };
        },
    })]);
    const server = createMcpTransport({
        applications,
        dispatch: async (name: string, input: unknown) => applications.invoke(name, input),
    } as any);
    const client = new Client({ name: 'connector-priority-test', version: '1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const names = (await client.listTools()).tools.map(tool => tool.name);
        const prioritized = [
            'football_generalist_evaluate',
            'football_generalist_baseline',
            'football_generalist_status',
            'football_generalist_evaluation_detail',
            'football_generalist_policies',
        ];
        assert.deepEqual(names.slice(0, prioritized.length), prioritized);
        for (const name of prioritized) {
            assert.equal(names.filter(item => item === name).length, 1, name);
            assert.ok(names.slice(0, 100).includes(name), name);
        }
        assert.ok(names.includes('football_run_evaluation'), 'legacy evaluation must stay available');
        const candidate = 'generalist-atlas-generalist-5461afae5e39';
        const started = await client.callTool({
            name: 'football_generalist_evaluate',
            arguments: { policyId: candidate, scenario: 's0-contact-varied-v1', seed: 717, episodes: 100 },
        });
        assert.equal(started.isError, undefined);
        assert.deepEqual(invocations.at(-1), {
            action: 'generalist_evaluate',
            input: { policyId: candidate, scenario: 's0-contact-varied-v1', seed: 717, episodes: 100 },
        });
        await client.callTool({
            name: 'football_generalist_baseline',
            arguments: { scenario: 's0-contact-varied-v1', seed: 717, episodes: 100 },
        });
        assert.equal(invocations.at(-1)?.action, 'generalist_baseline');
        await client.callTool({
            name: 'football_generalist_status',
            arguments: { runId: '27c2460d-830a-4f1a-8c06-88184bb365ef' },
        });
        assert.equal(invocations.at(-1)?.action, 'generalist_status');
        const count = invocations.length;
        const invalid = await client.callTool({
            name: 'football_generalist_evaluate',
            arguments: { policyId: '../legacy', scenario: 's0-contact-varied-v1', seed: 717, episodes: 100 },
        });
        assert.equal(invalid.isError, true, 'invalid policy must not dispatch to node');
        assert.equal(invocations.length, count);
    } finally {
        await client.close();
        await server.close();
    }
});
