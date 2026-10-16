import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cleanupDatabases, databaseFixture } from './database.js';
import { KnowledgeBankService, browseSchema } from '../apps/server/src/apps/knowledge-bank.js';

after(cleanupDatabases);

test('Knowledge Bank searches the complete corpus past the View 100-record limit with accurate filters and totals', async () => {
    const { catalog, store } = await databaseFixture();
    const project = await catalog.createProject({ name: 'Knowledge Bank search fixture' });
    const projectId = project.id;
    async function makeStore(name: string, fields: { name: string; type: 'string' | 'array'; required?: boolean }[]) {
        return catalog.createStore({ projectId, name, fields });
    }
    const groups = await makeStore('Knowledge Groups', [{name:'key',type:'string',required:true},{name:'name',type:'string',required:true}]);
    const sources = await makeStore('Knowledge Sources', [
        { name:'sourceKey',type:'string',required:true },{name:'title',type:'string',required:true},
        {name:'sourceType',type:'string',required:true},{name:'groupKeys',type:'array',required:true},{name:'tags',type:'array'},
    ]);
    const sections = await makeStore('Knowledge Sections', [{name:'sectionKey',type:'string',required:true}]);
    const entries = await makeStore('Knowledge Entries', [
        {name:'entryKey',type:'string',required:true},{name:'sourceKey',type:'string',required:true},
        {name:'groupKeys',type:'array',required:true},{name:'title',type:'string',required:true},
        {name:'summary',type:'string',required:true},{name:'kind',type:'string',required:true},
        {name:'tags',type:'array'},
    ]);
    const relations = await makeStore('Knowledge Relationships', [{name:'relationKey',type:'string',required:true}]);

    await catalog.createRecord({projectId,storeId:groups.id,data:{key:'ux',name:'UX'}});
    await catalog.bulkRecords({projectId,storeId:sources.id,operations:[
        {action:'create',data:{sourceKey:'ux-book',title:'UX Book',sourceType:'lecture_notes',groupKeys:['ux'],tags:['methods']}},
        {action:'create',data:{sourceKey:'fyp-paper',title:'FYP Paper',sourceType:'paper',groupKeys:['fyp'],tags:['agents']}},
    ]});

    const operations = Array.from({length:145},(_,i) => ({
        action: 'create' as const,
        data: {entryKey:'ux:'+i,sourceKey:'ux-book',groupKeys:['ux'],title:'UX term '+String(i).padStart(3,'0'),
            summary:i===144?'Highly specific interaction nuance':'Study notes for user interactions',
            kind: i%2===0?'concept':'example', tags:i===144?['critical']:['methods']},
    }));
    await catalog.bulkRecords({projectId,storeId:entries.id,operations:operations.slice(0,100)});
    await catalog.bulkRecords({projectId,storeId:entries.id,operations:operations.slice(100)});
    await catalog.createRecord({projectId,storeId:entries.id,data:{
        entryKey:'fyp:1',sourceKey:'fyp-paper',groupKeys:['fyp'],title:'Multiagent RL',
        summary:'Cooperative policy behaviour',kind:'finding',tags:['agents'],
    }});
    const service = new KnowledgeBankService(catalog,store.pool,projectId,{
        groups:groups.id,sources:sources.id,sections:sections.id,entries:entries.id,relations:relations.id,
    });
    const full = await service.browse(browseSchema.parse({collection:'entries',limit:25,offset:125}));
    assert.equal(full.total,146);
    assert.equal(full.offset,125);
    assert.equal(full.items.length,21);
    assert.equal(full.items.at(-1)?.entryKey,'ux:144'); // alphabetical ordering, past the first 100
    const ux = await service.browse(browseSchema.parse({group:'ux',offset:100,limit:30}));
    assert.equal(ux.total,145);
    assert.equal(ux.items.length,30);
    assert.ok(ux.items.every(item => (item.groupKeys as string[]).includes('ux')));
    const match = await service.browse(browseSchema.parse({q:'specific interaction nuance',tag:'critical',group:'ux'}));
    assert.equal(match.total,1);
    assert.equal(match.items[0]?.entryKey,'ux:144');
    assert.equal(match.items[0]?.sourceTitle,'UX Book');
    const paper = await service.browse(browseSchema.parse({sourceType:'paper',collection:'entries'}));
    assert.equal(paper.total,1);
    assert.equal(paper.items[0]?.sourceKey,'fyp-paper');
    const byKey = await service.browse(browseSchema.parse({sourceKey:'ux-book',entryKind:'example'}));
    assert.equal(byKey.total,72);
    const sourcesQuery = await service.browse(browseSchema.parse({collection:'sources',q:'FYP'}));
    assert.equal(sourcesQuery.total,1);
    const overview = await service.overview();
    assert.equal(overview.counts['Knowledge Entries'],146);
    assert.equal(overview.groups.length,1);
});
