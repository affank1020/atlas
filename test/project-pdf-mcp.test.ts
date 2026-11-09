import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectPdfService } from '../apps/server/src/server/project-pdf.js';
import { createDispatcher } from '../apps/server/src/server/dispatch.js';
import type { AtlasFile, AtlasFilesService } from '../apps/server/src/server/atlas-files.js';

const projectId = '54b51649-1be2-4c54-bb15-11c825939a6f';
const otherProject = 'ce09dbe0-0755-4bd8-9376-e4a3152d59f7';
const fileId = 'e0aa1111-2222-4333-8444-555555555555';
const authorized = { kind: 'mcp-oauth' as const, subject: 'owner', issuer: 'https://issuer.example/' };
const documentText = 'Markov chains\fStationary distribution πP = π\nDetailed balance\fRecurrent states\f';
const pdfBytes = Buffer.from('%PDF-1.7\nmock');

function fixture() {
    let reads = 0;
    let extractionCount = 0;
    let inactive = false;
    let currentChecksum = 'a'.repeat(64);
    const file = (): AtlasFile => ({
        id: fileId, owner: { kind: 'project', id: projectId },
        fileName: 'MATH37011_full_notes.pdf', mimeType: 'application/pdf',
        byteSize: pdfBytes.length, checksum: currentChecksum,
        visibility: 'private', status: 'active', folderId: null,
        createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z',
    });
    const files = {
        async metadata(owner: { kind: string; id: string }, id: string) {
            reads++;
            if (inactive || owner.kind !== 'project' || owner.id !== projectId || id !== fileId)
                throw Error('Atlas file was not found.');
            return file();
        },
        async download(owner: { kind: string; id: string }, id: string) {
            if (inactive || owner.id !== projectId || id !== fileId)
                throw Error('Atlas file was not found.');
            return { file: file(), bytes: pdfBytes };
        },
    } as unknown as Pick<AtlasFilesService, 'metadata' | 'download'>;
    const service = new ProjectPdfService(files, async () => {
        extractionCount++;
        return documentText;
    });
    return {
        service, setArchived: (value: boolean) => { inactive = value; },
        setChecksum: (value: string) => { currentChecksum = value; },
        reads: () => reads, extractions: () => extractionCount,
    };
}

test('PDF page reading preserves original 1-based page indices and page bounds', async () => {
    const { service } = fixture();
    const result = await service.read(projectId, fileId, 2, 2);
    assert.equal(result.totalPages, 3);
    assert.deepEqual(result.pages.map(page => page.page), [2, 3]);
    assert.match(result.pages[0]!.text, /Stationary distribution/);
    assert.equal(result.nextPage, null);
    await assert.rejects(service.read(projectId, fileId, 4), /out of range/);
    await assert.rejects(service.read(projectId, fileId, 1, 6), /page selection/);
    await assert.rejects(service.read(projectId, fileId, 0, 1), /page selection/);
});

test('PDF phrase search returns page numbers, snippets, counts and pagination', async () => {
    const { service } = fixture();
    const one = await service.search(projectId, fileId, 'STATE', 1);
    assert.equal(one.totalPages, 3);
    assert.equal(one.totalMatchingPages, 1);
    assert.equal(one.matches[0]!.page, 3);
    const all = await service.search(projectId, fileId, 'distribution');
    assert.equal(all.matches[0]!.page, 2);
    assert.match(all.matches[0]!.snippet, /πP = π/);
    const none = await service.search(projectId, fileId, 'nonexistent');
    assert.equal(none.totalMatchingPages, 0);
    assert.equal(none.hasMore, false);
    await assert.rejects(service.search(projectId, fileId, 'x'), /query/);
    await assert.rejects(service.search(projectId, fileId, 'state', 21), /pagination/);
});

test('private PDF cache is checksum-bound, active-file-gated and never cross-project readable', async () => {
    const f = fixture();
    await f.service.read(projectId, fileId);
    await f.service.search(projectId, fileId, 'stationary');
    assert.equal(f.extractions(), 1, 'same checksum should only be extracted once');
    assert.equal(f.reads(), 2, 'every cache hit must check current file metadata');
    await assert.rejects(f.service.read(otherProject, fileId), /not found/);
    assert.equal(f.extractions(), 1);
    f.setArchived(true);
    await assert.rejects(f.service.read(projectId, fileId), /not found/);
    f.setArchived(false);
    f.setChecksum('b'.repeat(64));
    await f.service.read(projectId, fileId);
    assert.equal(f.extractions(), 2, 'checksum changed, old extracted pages are not reused');
});

test('PDF reader rejects wrong MIME/header, missing text and excessive pages', async () => {
    const base = fixture();
    const fake = {
        metadata: async () => ({ ...(await base.service.read(projectId, fileId)).file,
            mimeType: 'image/png', fileName: 'notes.png' }),
        download: async () => ({ bytes: pdfBytes }),
    } as unknown as Pick<AtlasFilesService, 'metadata' | 'download'>;
    await assert.rejects(new ProjectPdfService(fake).read(projectId, fileId), /Only PDF/);
    const empty = new ProjectPdfService({
        metadata: async () => ({
            id: fileId, fileName: 'notes.pdf', mimeType: 'application/pdf',
            checksum: 'a'.repeat(64),
        }),
        download: async () => ({ file: { checksum: 'a'.repeat(64) }, bytes: pdfBytes }),
    } as unknown as Pick<AtlasFilesService, 'metadata' | 'download'>,
    async () => '\n\f\n');
    await assert.rejects(empty.read(projectId, fileId), /No selectable text/);
    const badHeader = new ProjectPdfService({
        metadata: async () => ({
            id: fileId, fileName: 'notes.pdf', mimeType: 'application/pdf',
            checksum: 'a'.repeat(64),
        }),
        download: async () => ({
            file: { checksum: 'a'.repeat(64) }, bytes: Buffer.from('NOTPDF'),
        }),
    } as unknown as Pick<AtlasFilesService, 'metadata' | 'download'>,
    async () => documentText);
    await assert.rejects(badHeader.read(projectId, fileId), /PDF header/);
    const tooLong = new ProjectPdfService({
        metadata: async () => ({ id: fileId, fileName: 'notes.pdf',
            mimeType: 'application/pdf', checksum: 'a'.repeat(64) }),
        download: async () => ({ file: { checksum: 'a'.repeat(64) }, bytes: pdfBytes }),
    } as unknown as Pick<AtlasFilesService, 'metadata' | 'download'>,
    async () => 'page\f'.repeat(601));
    await assert.rejects(tooLong.read(projectId, fileId), /page count/);
});

test('PDF MCP dispatch enforces owner OAuth and Project activity before touching the reader', async () => {
    const calls: string[] = [];
    const service = {
        catalog: { getProject: async (id: string) => {
            calls.push('project:' + id);
            if (id === otherProject) throw Error('Archived project');
        } },
        projectPdf: {
            read: async () => { calls.push('read'); return { pages: [] }; },
            search: async () => { calls.push('search'); return { matches: [] }; },
        },
        diagnostics: { record: () => undefined },
    };
    const dispatch = createDispatcher(service as unknown as Parameters<typeof createDispatcher>[0]);
    for (const action of ['read_project_file', 'search_project_file']) {
        for (const caller of [undefined, { kind: 'relay' }]) {
            await assert.rejects(dispatch(action, { projectId, fileId, query: 'markov' },
                'atlas-mcp', caller as never), /Owner OAuth/);
            assert.deepEqual(calls, []);
        }
    }
    await dispatch('read_project_file', { projectId, fileId }, 'atlas-mcp', authorized);
    await dispatch('search_project_file', { projectId, fileId, query: 'markov' }, 'atlas-mcp', authorized);
    assert.deepEqual(calls, ['project:' + projectId, 'read', 'project:' + projectId, 'search']);
    await assert.rejects(dispatch('read_project_file', { projectId: otherProject, fileId },
        'atlas-mcp', authorized), /Archived project/);
    assert.equal(calls.at(-1), 'project:' + otherProject);
});
