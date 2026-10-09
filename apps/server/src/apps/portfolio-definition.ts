import { z } from 'zod';
import { askAtlasInputSchema } from '../ai/ask-atlas/input.js';
import { PORTFOLIO_CONTENT_TYPES, PORTFOLIO_PROJECT_ID, type PortfolioService, type PortfolioMediaService } from '../portfolio/index.js';
import type { AskPortfolioService } from '../portfolio/ask/index.js';
import type { ContentfulPortfolioIntegration } from '../integrations/contentful.js';
import type { ApplicationDefinition, ApplicationTool } from './registry.js';

/** Preserve the published Portfolio operation names while moving registration into the Application. */
export function portfolioApplication(services: {
    portfolio?: PortfolioService;
    media?: PortfolioMediaService;
    askPortfolio: AskPortfolioService;
    contentful: ContentfulPortfolioIntegration;
}): ApplicationDefinition {
    const { portfolio, media, askPortfolio, contentful } = services;
    const client = { client: z.string().optional() };
    const recordId = z.string().uuid();
    const contentType = z.enum(Object.keys(PORTFOLIO_CONTENT_TYPES) as [keyof typeof PORTFOLIO_CONTENT_TYPES, ...(keyof typeof PORTFOLIO_CONTENT_TYPES)[]]);
    const tools: ApplicationTool[] = [
        { name: 'ask_portfolio', description: 'Chat about the public portfolio corpus. Scope is fixed server-side and cannot be widened by callers.', inputSchema: askAtlasInputSchema.shape, invoke: x => askPortfolio.ask(x) },
        { name: 'get_contentful_status', description: 'Report the Contentful portfolio integration and derived Fabric corpus status.', inputSchema: {}, invoke: () => contentful.status() },
        { name: 'sync_portfolio', description: 'Fully reconcile the published Contentful portfolio corpus into Fabric.', inputSchema: {}, invoke: () => contentful.syncPortfolio('manual') },
    ];
    if (portfolio && media) tools.push(
        { name: 'get_portfolio_dashboard', description: 'Read Portfolio draft, publication, and media counts.', inputSchema: {}, invoke: () => portfolio.dashboard() },
        { name: 'get_portfolio_schemas', description: 'List the canonical Portfolio content types and fields.', inputSchema: {}, invoke: () => portfolio.schemas() },
        { name: 'list_portfolio_entries', description: 'List Portfolio drafts and publication state.', inputSchema: { contentType: contentType.optional() }, invoke: x => portfolio.listEntries(x.contentType) },
        { name: 'get_portfolio_entry', description: 'Read one Portfolio draft and its publication state.', inputSchema: { recordId }, invoke: x => portfolio.getEntry(x.recordId) },
        { name: 'save_portfolio_draft', description: 'Create or replace a Portfolio draft. This never publishes it.', inputSchema: { contentType, recordId: recordId.optional(), data: z.record(z.string(), z.unknown()), ...client }, invoke: x => portfolio.saveDraft(x) },
        { name: 'publish_portfolio_entry', description: 'Validate and explicitly publish an immutable Portfolio revision.', inputSchema: { recordId, ...client }, invoke: x => portfolio.publish(x.recordId, x.client) },
        { name: 'unpublish_portfolio_entry', description: 'Remove an entry from the public Portfolio corpus without deleting its draft.', inputSchema: { recordId }, invoke: x => portfolio.unpublish(x.recordId) },
        { name: 'archive_portfolio_entry', description: 'Archive a Portfolio draft and remove it from publication.', inputSchema: { recordId, ...client }, invoke: x => portfolio.archive(x.recordId, x.client) },
        { name: 'list_portfolio_revisions', description: 'List immutable publication revisions for a Portfolio entry.', inputSchema: { recordId }, invoke: x => portfolio.revisions(x.recordId) },
        { name: 'restore_portfolio_revision', description: 'Copy an immutable revision back into the editable draft without publishing it.', inputSchema: { recordId, revisionId: z.string().uuid(), ...client }, invoke: x => portfolio.restore(x.recordId, x.revisionId, x.client) },
        { name: 'rebuild_portfolio_index', description: 'Fully reconcile published Portfolio revisions into Fabric.', inputSchema: {}, invoke: () => portfolio.rebuildPublishedIndex() },
        { name: 'list_portfolio_media', description: 'List Portfolio media metadata and local delivery URLs.', inputSchema: {}, invoke: () => media.list() },
        { name: 'upload_portfolio_media', description: 'Upload an image or PDF as base64; images receive thumbnail and preview variants.', inputSchema: { fileName: z.string().min(1), mimeType: z.string(), base64: z.string().min(1), altText: z.string().optional(), caption: z.string().optional(), ...client }, invoke: x => media.upload(x) },
        { name: 'update_portfolio_media', description: 'Update media alt text, caption, or archive state.', inputSchema: { assetId: recordId, altText: z.string().nullable().optional(), caption: z.string().nullable().optional(), status: z.enum(['active', 'archived']).optional() }, invoke: x => media.update(x.assetId, x) },
    );
    return { type: 'portfolio', slug: 'portfolio', name: 'Portfolio', description: 'Manage portfolio content, media, drafts and publication.', projectId: PORTFOLIO_PROJECT_ID, tools };
}
