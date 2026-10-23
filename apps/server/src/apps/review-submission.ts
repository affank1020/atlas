import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AtlasError } from '../shared/errors.js';
import type { AtlasData, AtlasRecord, RecordData } from '../types.js';
import type { CoreService } from '../core/service.js';
import type { ApplicationCaller } from './registry.js';
import { CODE_REVIEWS_PROJECT_ID, REVIEW_RUNS_STORE, REVIEW_FINDINGS_STORE } from './review-import.js';

const sha = z.string().regex(/^[a-fA-F0-9]{40}$/).transform(value => value.toLowerCase());
const finding = z.object({
    key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
    severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(8_000),
    filePath: z.string().min(1).max(1_024).optional(),
    line: z.number().int().min(1).max(10_000_000).optional(),
}).strict();

/** Exactly one immutable reviewer observation, with no GitHub publication side effect. */
export const structuredReviewSchema = z.object({
    submissionId: z.string().uuid().transform(value => value.toLowerCase()),
    repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/).transform(value => value.toLowerCase()),
    prNumber: z.number().int().min(1).max(1_000_000),
    headSha: sha,
    verdict: z.enum(['changes_requested', 'concerns_to_verify', 'non_blocking', 'no_findings', 'inconclusive']),
    summary: z.string().min(1).max(16_000).optional(),
    findings: z.array(finding).max(30),
}).strict().superRefine((value, ctx) => {
    const keys = new Set<string>();
    for (const item of value.findings) {
        if (keys.has(item.key)) {
            ctx.addIssue({ code: 'custom', path: ['findings'], message: 'Finding keys must be distinct.' });
            break;
        }
        keys.add(item.key);
    }
    if (value.verdict === 'no_findings' && value.findings.length)
        ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'A clean review cannot contain findings.' });
});

export type StructuredReview = z.infer<typeof structuredReviewSchema>;
type SubmissionCatalog = Pick<CoreService, 'createRecordInState'>;
type StoreIds = { runs: string; findings: string };

export function assertStructuredCaller(caller?: ApplicationCaller): asserts caller is ApplicationCaller {
    if (caller?.kind !== 'mcp-oauth' || typeof caller.subject !== 'string' || !caller.subject ||
        typeof caller.issuer !== 'string' || !caller.issuer.startsWith('https://'))
        throw new AtlasError('Structured review submissions require an authenticated MCP OAuth caller.', 'WORKSPACE_DENIED');
}

function actorMetadata(caller: ApplicationCaller) {
    return { kind: caller.kind, subject: caller.subject, issuer: caller.issuer };
}

function fingerprint(input: StructuredReview) {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function locate(state: AtlasData, stores: StoreIds, submissionId: string): AtlasRecord | undefined {
    const matches = state.records.filter(record =>
        record.storeId === stores.runs && record.data.coverage &&
        typeof record.data.coverage === 'object' &&
        !Array.isArray(record.data.coverage) &&
        (record.data.coverage as RecordData).source === 'atlas_structured_submission' &&
        (record.data.coverage as RecordData).submissionId === submissionId);
    if (matches.length > 1) throw new AtlasError('Duplicate structured review submission receipts.', 'CONFLICT');
    return matches[0];
}

function receipt(state: AtlasData, stores: StoreIds, run: AtlasRecord, input: StructuredReview, created: boolean, caller: ApplicationCaller) {
    const metadata = run.data.coverage as RecordData | undefined;
    if (run.archivedAt || !metadata || metadata.payloadSha256 !== fingerprint(input))
        throw new AtlasError('Structured review submission ID already belongs to another payload or an archived run.', 'CONFLICT');
    const actor = metadata.authenticatedCaller as RecordData | undefined;
    if (!actor || actor.kind !== caller.kind || actor.subject !== caller.subject || actor.issuer !== caller.issuer)
        throw new AtlasError('Structured review receipt belongs to a different authenticated caller.', 'WORKSPACE_DENIED');
    const findings = state.records.filter(record => record.storeId === stores.findings &&
        record.data.reviewRunId === run.id);
    const byKey = new Map(findings.map(record => [record.data.findingKey, record]));
    if (findings.some(item => item.archivedAt) ||
        findings.length !== input.findings.length ||
        findings.length !== metadata.findingCount ||
        byKey.size !== findings.length)
        throw new AtlasError('Previously submitted structured review has missing or altered findings.', 'CONFLICT');
    // PostgreSQL reloads rows by created_at then UUID. For tied timestamps that
    // can differ from input order; always reconstruct the exact original mapping.
    const findingReceipts = input.findings.map(item => {
        const record = byKey.get(`structured:${input.submissionId}:${item.key}`);
        if (!record) throw new AtlasError('Previously submitted structured review has missing or altered findings.', 'CONFLICT');
        return { key: item.key, id: record.id };
    });
    return {
        submissionId: metadata.submissionId,
        runId: run.id,
        findingIds: findingReceipts.map(item => item.id),
        findingReceipts,
        repository: run.data.repository,
        prNumber: run.data.prNumber,
        headSha: run.data.headSha,
        reviewedAt: run.data.reviewedAt,
        created,
        publishedToGitHub: false,
    };
}

/** Unique submission ID is checked inside the serialized PostgreSQL transaction.
 * Retries return the original receipt, even if the PR head has advanced.
 */
export function existingStructuredReview(state: AtlasData, stores: StoreIds, input: StructuredReview, caller: ApplicationCaller) {
    const run = locate(state, stores, input.submissionId);
    return run ? receipt(state, stores, run, input, false, caller) : undefined;
}

export function saveStructuredReview(catalog: SubmissionCatalog, state: AtlasData,
    stores: StoreIds, input: StructuredReview, verifiedHeadSha: string, verifiedAt: string, caller: ApplicationCaller) {
    const previous = existingStructuredReview(state, stores, input, caller);
    if (previous) return previous;
    if (verifiedHeadSha !== input.headSha)
        throw new AtlasError('PR head changed before review submission; re-review the latest commit.', 'CONFLICT');
    if (!state.projects.some(project => project.id === CODE_REVIEWS_PROJECT_ID && !project.archivedAt) ||
        !state.stores.some(store => store.id === stores.runs && store.projectId === CODE_REVIEWS_PROJECT_ID &&
            store.name === REVIEW_RUNS_STORE && !store.archivedAt) ||
        !state.stores.some(store => store.id === stores.findings && store.projectId === CODE_REVIEWS_PROJECT_ID &&
            store.name === REVIEW_FINDINGS_STORE && !store.archivedAt))
        throw new AtlasError('Code Reviews Project or Stores are unavailable.', 'CAPABILITY_UNAVAILABLE');
    const digest = fingerprint(input);
    const counts = { sev1: 0, sev2: 0, sev3: 0, sev4: 0 };
    for (const item of input.findings) counts[item.severity]++;
    const reviewedAt = new Date().toISOString();
    const run = catalog.createRecordInState(state, {
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: stores.runs,
        client: 'atlas-structured-review-submission',
        data: {
            repository: input.repository, prNumber: input.prNumber, headSha: input.headSha,
            // Not a GitHub account identity; verified publishing belongs to a later stage.
            reviewer: 'atlas-structured-review',
            verdict: input.verdict, reviewedAt, schemaVersion: 1, counts,
            coverage: {
                source: 'atlas_structured_submission', submissionId: input.submissionId,
                payloadSha256: digest, findingCount: input.findings.length,
                ...(input.summary !== undefined && { summary: input.summary }),
                githubHeadVerifiedAt: verifiedAt,
                publisherIdentityVerified: false, publication: 'not_published',
                authenticatedCaller: actorMetadata(caller),
            },
        },
    });
    for (const item of input.findings) {
        catalog.createRecordInState(state, {
            projectId: CODE_REVIEWS_PROJECT_ID, storeId: stores.findings,
            client: 'atlas-structured-review-submission',
            data: {
                reviewRunId: run.id, findingKey: `structured:${input.submissionId}:${item.key}`,
                severity: item.severity, title: item.title, description: item.description,
                state: 'new', schemaVersion: 1,
                ...(item.filePath !== undefined && { filePath: item.filePath }),
                ...(item.line !== undefined && { line: item.line }),
                evidence: { source: 'atlas_structured_submission', localKey: item.key },
            },
        });
    }
    return receipt(state, stores, run, input, true, caller);
}
