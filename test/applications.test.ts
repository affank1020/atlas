import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { portfolioApplication } from '../apps/server/src/apps/portfolio-definition.js';

const definition = {
    type: 'example',
    slug: 'example-app',
    name: 'Example',
    description: 'Example Application',
    projectId: 'project-1',
    tools: [{
        name: 'example_echo',
        description: 'Echo a validated value.',
        inputSchema: { value: z.string() },
        invoke: ({ value }: { value: string }) => ({ value }),
    }],
};

test('Application registry lists only the owning Project and does not leak tools in manifests', () => {
    const apps = new ApplicationRegistry([definition]);
    assert.deepEqual(apps.list('project-2'), []);
    assert.deepEqual(apps.list('project-1'), [{
        type: 'example', slug: 'example-app', name: 'Example',
        description: 'Example Application', projectId: 'project-1',
    }]);
    assert.deepEqual(apps.get('project-1', 'example-app'), apps.list('project-1')[0]);
    assert.throws(() => apps.get('project-2', 'example-app'), /not found/i);
    assert.equal(apps.tools()[0].name, 'example_echo');
});

test('Application tools validate inputs and reject unknown operations', async () => {
    const apps = new ApplicationRegistry([definition]);
    assert.deepEqual(await apps.invoke('example_echo', { value: 'ok' }), { value: 'ok' });
    await assert.rejects(apps.invoke('example_echo', { value: 12 }));
    await assert.rejects(apps.invoke('missing_tool', {}), /Unknown Application operation/);
});

test('Application registry rejects duplicate slugs and conflicting MCP operation names', () => {
    assert.throws(() => new ApplicationRegistry([definition, definition]), /Duplicate Atlas Application/);
    assert.throws(() => new ApplicationRegistry([definition, {
        ...definition, slug: 'other-app', tools: [{ ...definition.tools[0] }],
    }]), /Duplicate Atlas Application operation/);
});

test('Portfolio remains an Application with the existing MCP tool names', async () => {
    const services = {
        portfolio: { dashboard: async () => ({ total: 3 }), getEntry: async () => ({contentType:'projects'}), patchDraft: async (x:unknown) => x, previewEntry: async () => ({validation:{valid:true}}) },
        media: { list: async () => [], resolveAssets: async () => ['f72eaf65-982e-49cb-8624-1a3f8ab4cf4e'] },
        askPortfolio: { ask: async () => ({ answer: 'published only' }) },
        contentful: { status: async () => ({ available: true }), syncPortfolio: async () => ({ ok: true }) },
    };
    const application = portfolioApplication(services as any);
    const apps = new ApplicationRegistry([application]);
    assert.equal(application.slug, 'portfolio');
    assert.equal(application.projectId, 'd99a6c45-a4ec-5ef6-8f22-c07d31f8bb38');
    for (const name of ['ask_portfolio', 'get_contentful_status', 'sync_portfolio', 'get_portfolio_dashboard', 'get_portfolio_schemas', 'save_portfolio_draft', 'patch_portfolio_entry', 'preview_portfolio_entry', 'set_portfolio_media', 'publish_portfolio_entry', 'list_portfolio_media', 'upload_portfolio_media']) {
        assert.ok(apps.hasTool(name), `Portfolio MCP tool ${name} is missing`);
    }
    assert.deepEqual(await apps.invoke('get_portfolio_dashboard', {}), { total: 3 });
    assert.deepEqual(await apps.invoke('list_portfolio_media', {}), []);
    await assert.rejects(apps.invoke('publish_portfolio_entry', { recordId: 'not-a-uuid' }));
    const recordId='690e05f7-7926-4156-b702-2b0fb57821dc';
    const updatedAt='2026-10-19T22:23:25.264Z';
    const assigned=await apps.invoke('set_portfolio_media', {recordId,expectedUpdatedAt:updatedAt,slot:'gallery',assets:['logo.png']}) as any;
    assert.deepEqual(assigned.changes,{galleryAssetIds:['f72eaf65-982e-49cb-8624-1a3f8ab4cf4e']});
    await assert.rejects(apps.invoke('set_portfolio_media', {recordId,expectedUpdatedAt:updatedAt,slot:'cv',assets:[]}),/not available for projects/);
    await assert.rejects(apps.invoke('set_portfolio_media', {recordId,expectedUpdatedAt:updatedAt,slot:'image',assets:['one.png','two.png']}),/Only the gallery/);
    assert.deepEqual(await apps.invoke('preview_portfolio_entry', {recordId}),{validation:{valid:true}});
    await assert.rejects(apps.invoke('patch_portfolio_entry', {recordId,changes:{summary:'missing version'}}));
});
