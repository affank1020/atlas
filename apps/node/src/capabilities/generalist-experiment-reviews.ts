import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AtlasError } from '@atlas/protocol/errors';
import type { Workspace } from '@atlas/protocol/workspace';

const phases = new Set(['g05', 'g1', 'g2', 'g3', 'g4', 'g5']);
const verdicts = new Set(['pending', 'keep', 'adopt', 'revise', 'stop']);
const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const sha = /^[a-f0-9]{64}$/;
const safeText = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

export type ExperimentReview = {
    phase: string; scenario: string; variant: string; verdict: string; note: string; visual_evidence?: string;
    policy_id?: string; run_id?: string; evaluation_ticket?: string; watch_ticket?: string;
    contract_sha256?: string; scenario_sha256?: string; updated_at: string;
};

function fileFor(workspace: Workspace) {
    return path.join(workspace.rootPath, 'validation', 'generalist', 'atlas-experiment-reviews.json');
}

// Protect the entire storage path, not only the final JSON file. An existing
// validation/ or generalist/ symlink must not redirect writes outside the workspace.
function reviewDirectory(workspace: Workspace, create: boolean): boolean {
    const root = realpathSync(workspace.rootPath);
    let directory = workspace.rootPath;
    for (const segment of ['validation', 'generalist']) {
        directory = path.join(directory, segment);
        if (create) mkdirSync(directory, { recursive: true });
        let resolved;
        try { resolved = realpathSync(directory); }
        catch (error) {
            if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
        }
        if (!resolved.startsWith(root + path.sep) || !statSync(resolved).isDirectory())
            throw new AtlasError('Unsafe experiment review directory.', 'INVALID_ARGUMENT');
    }
    return true;
}

export function readExperimentReviews(workspace: Workspace): ExperimentReview[] {
    if (!reviewDirectory(workspace, false)) return [];
    const file = fileFor(workspace);
    let info;
    try { info = lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024)
        throw new AtlasError('Unsafe experiment review file.', 'INVALID_ARGUMENT');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.schema_version !== 1 || !Array.isArray(parsed.reviews) || parsed.reviews.length > 200 ||
        parsed.reviews.some((review: ExperimentReview) => !review || !phases.has(review.phase) ||
            !id.test(review.scenario) || !safeText(review.variant, 80) || !verdicts.has(review.verdict) ||
            !safeText(review.note, 2000) || (review.visual_evidence !== undefined && !safeText(review.visual_evidence, 300)) || typeof review.updated_at !== 'string'))
        throw new AtlasError('Invalid experiment review file.', 'INVALID_ARGUMENT');
    return parsed.reviews;
}

export function writeExperimentReview(workspace: Workspace, input: Omit<ExperimentReview, 'updated_at'>): ExperimentReview {
    if (!phases.has(input.phase) || !id.test(input.scenario) || !safeText(input.variant, 80) ||
        !verdicts.has(input.verdict) || !safeText(input.note, 2000) ||
        (input.verdict !== 'pending' && !safeText(input.visual_evidence, 300)) ||
        (input.verdict !== 'pending' && ![input.run_id, input.evaluation_ticket, input.watch_ticket].some(Boolean)))
        throw new AtlasError('Review requires a valid phase, scenario, variant, note and evidence for a decision.', 'INVALID_ARGUMENT');
    for (const key of ['policy_id', 'run_id'] as const)
        if (input[key] !== undefined && !id.test(input[key]!)) throw new AtlasError('Invalid review reference.', 'INVALID_ARGUMENT');
    for (const key of ['evaluation_ticket', 'watch_ticket'] as const)
        if (input[key] !== undefined && !/^[a-f0-9-]{36}$/.test(input[key]!)) throw new AtlasError('Invalid review ticket.', 'INVALID_ARGUMENT');
    for (const key of ['contract_sha256', 'scenario_sha256'] as const)
        if (input[key] !== undefined && !sha.test(input[key]!)) throw new AtlasError('Invalid review fingerprint.', 'INVALID_ARGUMENT');
    const reviews = readExperimentReviews(workspace);
    const next: ExperimentReview = { ...input, variant: input.variant.trim(), note: input.note.trim(),
        ...(input.visual_evidence ? { visual_evidence: input.visual_evidence.trim() } : {}), updated_at: new Date().toISOString() };
    const existing = reviews.findIndex(review => review.phase === next.phase && review.scenario === next.scenario && review.variant === next.variant);
    if (existing < 0 && reviews.length >= 200) throw new AtlasError('Experiment review limit reached.', 'INVALID_ARGUMENT');
    if (existing < 0) reviews.push(next); else reviews[existing] = next;
    reviewDirectory(workspace, true);
    const file = fileFor(workspace);
    try { if (lstatSync(file).isSymbolicLink()) throw new AtlasError('Unsafe experiment review file.', 'INVALID_ARGUMENT'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = path.join(path.dirname(file), '.atlas-experiment-reviews-' + randomUUID() + '.tmp');
    writeFileSync(temporary, JSON.stringify({ schema_version: 1, reviews }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
    return next;
}
