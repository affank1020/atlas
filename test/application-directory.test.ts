import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';

test('Application registry lists project applications and standalone applications together', () => {
    const registry = new ApplicationRegistry([
        { type: 'first', slug: 'portfolio', name: 'Portfolio', description: 'Content', projectId: 'project-one', tools: [] },
        { type: 'second', slug: 'football-training', name: 'Football Training', description: 'Research', projectId: 'project-two', tools: [] },
        { type: 'third', slug: 'notes', name: 'Notes', description: 'Standalone', tools: [] },
    ]);
    assert.deepEqual(registry.listAll().map(app => [app.slug, app.projectId]), [
        ['portfolio', 'project-one'],
        ['football-training', 'project-two'],
        ['notes', null],
    ]);
    assert.deepEqual(registry.list('project-one').map(app => app.slug), ['portfolio']);
    assert.equal(registry.get(null, 'notes').name, 'Notes');
    assert.equal(registry.get('project-two', 'football-training').projectId, 'project-two');
    assert.throws(() => registry.get('project-one', 'notes'), /Application not found/);
    assert.throws(() => registry.get(null, 'portfolio'), /Application not found/);
});

test('Application registry prevents duplicate standalone slugs and reserved discovery operations', () => {
    assert.throws(() => new ApplicationRegistry([
        { type: 'x', slug: 'notes', name: 'Notes', description: '', tools: [] },
        { type: 'y', slug: 'notes', name: 'Other', description: '', projectId: null, tools: [] },
    ]), /Duplicate Atlas Application/);
    assert.throws(() => new ApplicationRegistry([{
        type: 'x', slug: 'notes', name: 'Notes', description: '',
        tools: [{ name: 'list_all_applications', description: '', inputSchema: {}, invoke: () => [] }],
    }]), /Duplicate Atlas Application operation/);
});
