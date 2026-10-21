import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { AtlasCatalog } from '../apps/server/src/catalog.js';
import type { AtlasRepository } from '../apps/server/src/core/repository.js';
import { databaseFixture, cleanupDatabases } from './database.js';
after(cleanupDatabases);

test('targeted reads match snapshot compatibility, without reading records or audits', async () => {
    const { catalog, store } = await databaseFixture();
    const p = await catalog.createProject({ name: 'Active' });
    const other = await catalog.createProject({ name: 'Other' });
    const s = await catalog.createStore({ projectId: p.id, name: 'Rows', fields: [{ name: 'title', type: 'string' }] });
    const v = await catalog.createView({ projectId: p.id, name: 'View', slug: 'example', queries: [{ name: 'rows', storeId: s.id }], html: '{{#each rows}}{{title}}{{/each}}', css: '' });
    await catalog.createRecord({ projectId: p.id, storeId: s.id, data: { title: 'hello' } });
    await catalog.archiveProject(other.id);
    const legacy: AtlasRepository = { snapshot: () => store.snapshot(), transaction: fn => store.transaction(fn), queryRecords: (s, i) => store.queryRecords(s,i), close: async () => {} };
    const baseline = new AtlasCatalog(legacy);
    for (const archived of [false, true]) {
        assert.deepEqual(await catalog.listProjects(archived), await baseline.listProjects(archived));
        assert.deepEqual(await catalog.getProject(p.id, archived), await baseline.getProject(p.id, archived));
        assert.deepEqual(await catalog.listStores(p.id, archived), await baseline.listStores(p.id, archived));
        assert.deepEqual(await catalog.getStore(p.id,s.id, archived), await baseline.getStore(p.id,s.id, archived));
        assert.deepEqual(await catalog.listViews(p.id, archived), await baseline.listViews(p.id, archived));
        assert.deepEqual(await catalog.getView(p.id,v.id, archived), await baseline.getView(p.id,v.id, archived));
    }
    assert.deepEqual(await catalog.status(), await baseline.status());
    for (const input of [{}, { projectId:p.id }, { storeId:s.id, limit:1 }, { operation:'view.created' as const }]) {
        assert.deepEqual(await catalog.auditHistory(input), await baseline.auditHistory(input));
    }
    assert.deepEqual(await catalog.viewHistory(p.id,v.id), await baseline.viewHistory(p.id,v.id));
    const scoped = await store.readCatalogue({ projectId: p.id, stores: s.id, views: v.id });
    assert.equal(scoped.records.length,0); assert.equal(scoped.auditEvents.length,0);
    store.snapshot = async () => { throw new Error('Catalogue read fell back to snapshot'); };
    await Promise.all([catalog.status(),catalog.listProjects(),catalog.getProject(p.id),catalog.listStores(p.id),catalog.getStore(p.id,s.id),catalog.listViews(p.id),catalog.getView(p.id,v.id),catalog.auditHistory({}),catalog.viewHistory(p.id,v.id),catalog.queryRecords({projectId:p.id,storeId:s.id}),catalog.renderView(p.id,v.id),catalog.views.renderStandalone(p.id,'example')]);
    for (const read of [() => catalog.getProject('invalid'), () => catalog.getStore(p.id,'invalid'), () => catalog.getView(p.id,'invalid'), () => catalog.getStore(other.id,s.id)]) {
        await assert.rejects(read, { code:'NOT_FOUND' });
    }
    await assert.rejects(() => catalog.getProject(other.id), { code: 'NOT_FOUND' });
});

test('per-project resource counts use grouped active totals and support archived visibility', async () => {
    const { catalog, store } = await databaseFixture();
    const project = await catalog.createProject({ name: 'With resources' });
    const empty = await catalog.createProject({ name: 'Empty resources' });
    const collection = await catalog.createStore({ projectId: project.id, name: 'Items', fields: [{ name: 'name', type: 'string' }] });
    await catalog.createRecord({ projectId: project.id, storeId: collection.id, data: { name: 'One' } });
    const archivedRecord = await catalog.createRecord({ projectId: project.id, storeId: collection.id, data: { name: 'Two' } });
    await catalog.createView({ projectId: project.id, name: 'Snapshot', queries: [{ name: 'items', storeId: collection.id }], html: '{{#each items}}{{name}}{{/each}}', css: '' });

    assert.deepEqual((await catalog.countProjectResources())[project.id], { stores: 1, records: 2, views: 1 });
    assert.equal((await catalog.countProjectResources())[empty.id], undefined);
    await catalog.archiveRecord(project.id, collection.id, archivedRecord.id);
    assert.deepEqual((await catalog.countProjectResources())[project.id], { stores: 1, records: 1, views: 1 });
    await catalog.archiveStore(project.id, collection.id);
    assert.deepEqual((await catalog.countProjectResources())[project.id], { stores: 0, records: 0, views: 1 });
    assert.deepEqual((await catalog.countProjectResources(true))[project.id], { stores: 1, records: 2, views: 1 });

    const fallback: AtlasRepository = { snapshot: () => store.snapshot(), transaction: fn => store.transaction(fn), queryRecords: (s, i) => store.queryRecords(s, i), close: async () => {} };
    assert.deepEqual((await new AtlasCatalog(fallback).countProjectResources())[project.id], { stores: 0, records: 0, views: 1 });
});

test('bounded concurrent View reads preserve query order and actions remain atomic', async () => {
    const { catalog, store } = await databaseFixture();
    const p = await catalog.createProject({ name:'Parallel' });
    const s = await catalog.createStore({ projectId:p.id, name:'Rows', fields:[{name:'value',type:'string'}] });
    const v = await catalog.createView({ projectId:p.id,name:'Parallel',queries:Array.from({length:6},(_,i)=>({name:`rows${i}`,storeId:s.id})),html:'test',css:'' });
    let concurrent=0, maximum=0;
    const original = store.queryRecords.bind(store);
    store.queryRecords = async (...args) => {
        concurrent++; maximum=Math.max(maximum,concurrent);
        try { await new Promise(resolve=>setTimeout(resolve,5)); return await original(...args); }
        finally { concurrent--; }
    };
    const rendered = await catalog.renderView(p.id,v.id);
    assert.ok(maximum>1 && maximum<=4);
    assert.deepEqual(rendered.diagnostics.queries.map(q=>q.name),v.queries.map(q=>q.name));
    await Promise.all(Array.from({length:4},()=>catalog.createRecord({projectId:p.id,storeId:s.id,data:{}})));
    assert.equal((await catalog.queryRecords({projectId:p.id,storeId:s.id})).total,4);
});
