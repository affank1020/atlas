import { extractPdfText as extractNativePdfText } from '@atlas/pdf-text';
import { AtlasError } from '../shared/errors.js';
import type { AtlasFile, AtlasFilesService } from './atlas-files.js';

const MAX_PAGES = 600;
const MAX_CACHED_BYTES = 12 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 12;
const MAX_PAGE_CHARS = 10000;

export type PdfPage = { page: number; text: string; truncated: boolean };
type PageCache = { pages: string[]; bytes: number };
type PdfFileReader = Pick<AtlasFilesService, 'metadata' | 'download'>;
type PdfExtractor = (bytes: Buffer) => Promise<string>;

/** Server only calls the bounded extractor adapter; subprocess internals are isolated. */
export async function extractPdfText(bytes: Buffer): Promise<string> {
    try {
        return await extractNativePdfText(bytes);
    } catch (error) {
        const detail = error instanceof Error ? error.message : '';
        throw new AtlasError(detail.startsWith('PDF ') ? detail : 'PDF text extraction failed.');
    }
}

function splitPages(extracted: string): string[] {
    if (!extracted.trim()) throw new AtlasError(
        'No selectable text was found in this PDF; scanned pages require OCR.');
    const pages = extracted.replace(/\r\n?/g, '\n').split('\f');
    if (pages.length > 1 && pages[pages.length - 1]!.trim() === '') pages.pop();
    if (pages.length > MAX_PAGES) throw new AtlasError('PDF exceeds the supported page count.');
    return pages.map(page => page.trim());
}

/**
 * Project scoping is checked before every cache lookup. A cache hit never
 * bypasses active-file metadata checks, including after archive/restore.
 * In-memory entries are ephemeral and keyed by owner, file and checksum.
 */
export class ProjectPdfService {
    private readonly cached = new Map<string, PageCache>();
    private readonly pending = new Map<string, Promise<string[]>>();
    private cachedBytes = 0;
    constructor(private readonly files: PdfFileReader,
        private readonly extractor: PdfExtractor = extractPdfText) {}

    private async document(projectId: string, fileId: string):
        Promise<{ file: AtlasFile; pages: string[] }> {
        const owner = { kind: 'project' as const, id: projectId };
        const file = await this.files.metadata(owner, fileId);
        if (file.mimeType !== 'application/pdf' || !file.fileName.toLowerCase().endsWith('.pdf'))
            throw new AtlasError('Only PDF Project files can be read as PDF text.');
        const key = [projectId.toLowerCase(), fileId.toLowerCase(), file.checksum].join(':');
        const hit = this.cached.get(key);
        if (hit) {
            this.cached.delete(key);
            this.cached.set(key, hit); // LRU, bounded memory.
            return { file, pages: hit.pages };
        }
        let loading = this.pending.get(key);
        if (!loading) {
            // Bound simultaneous 25-MiB downloads and native parser processes.
            if (this.pending.size >= 2)
                throw new AtlasError('Too many concurrent PDF extractions; retry later.');
            loading = (async () => {
                const downloaded = await this.files.download(owner, fileId);
                // The Files service verifies object byte count and SHA-256.
                if (downloaded.file.checksum !== file.checksum)
                    throw new AtlasError('Project file changed during PDF extraction.');
                if (downloaded.bytes.subarray(0, 5).toString('ascii') !== '%PDF-')
                    throw new AtlasError('File does not contain a valid PDF header.');
                const pages = splitPages(await this.extractor(downloaded.bytes));
                const size = pages.reduce((sum, page) => sum + Buffer.byteLength(page), 0);
                if (size <= MAX_CACHED_BYTES) {
                    this.cached.set(key, { pages, bytes: size });
                    this.cachedBytes += size;
                    while (this.cached.size > MAX_CACHE_ENTRIES || this.cachedBytes > MAX_CACHED_BYTES) {
                        const oldest = this.cached.keys().next().value as string;
                        const discarded = this.cached.get(oldest)!;
                        this.cachedBytes -= discarded.bytes;
                        this.cached.delete(oldest);
                    }
                }
                return pages;
            })().finally(() => this.pending.delete(key));
            this.pending.set(key, loading);
        }
        return { file, pages: await loading };
    }

    async read(projectId: string, fileId: string, startPage = 1, pageCount = 3) {
        if (!Number.isSafeInteger(startPage) || startPage < 1 ||
            !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 5)
            throw new AtlasError('Invalid PDF page selection (maximum five pages per call).');
        const { file, pages } = await this.document(projectId, fileId);
        if (startPage > pages.length) throw new AtlasError('Requested PDF page is out of range.');
        const selected: PdfPage[] = pages.slice(startPage - 1, startPage - 1 + pageCount)
            .map((text, i) => ({
                page: startPage + i,
                text: text.slice(0, MAX_PAGE_CHARS),
                truncated: text.length > MAX_PAGE_CHARS,
            }));
        return {
            file: { id: file.id, fileName: file.fileName, checksum: file.checksum },
            totalPages: pages.length,
            pages: selected,
            nextPage: startPage + selected.length <= pages.length ? startPage + selected.length : null,
            note: 'PDF text extraction may not preserve mathematical notation; inspect the source PDF for equations.',
        };
    }

    async search(projectId: string, fileId: string, query: string, limit = 10, offset = 0) {
        if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200)
            throw new AtlasError('PDF search query must contain 2–200 characters.');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
            !Number.isSafeInteger(offset) || offset < 0 || offset > 10000)
            throw new AtlasError('Invalid PDF search pagination.');
        const { file, pages } = await this.document(projectId, fileId);
        const needle = query.trim().toLowerCase();
        const matches: { page: number; occurrences: number; snippet: string }[] = [];
        pages.forEach((page, index) => {
            const lower = page.toLowerCase();
            const first = lower.indexOf(needle);
            if (first === -1) return;
            let occurrences = 0;
            let at = first;
            while (at !== -1) {
                occurrences++;
                at = lower.indexOf(needle, at + needle.length);
            }
            const from = Math.max(0, first - 130);
            const to = Math.min(page.length, first + needle.length + 130);
            matches.push({ page: index + 1, occurrences,
                snippet: (from ? '…' : '') + page.slice(from, to) + (to < page.length ? '…' : '') });
        });
        return {
            file: { id: file.id, fileName: file.fileName, checksum: file.checksum },
            query: query.trim(), totalPages: pages.length, totalMatchingPages: matches.length,
            matches: matches.slice(offset, offset + limit),
            hasMore: offset + limit < matches.length,
        };
    }
}
