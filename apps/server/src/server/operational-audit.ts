import type { Pool } from 'pg';
import type { SeedReport } from './r2-backup-seeding.js';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** An operator CLI observation, not a transaction with R2 and not a
 * cryptographic restore attestation. Never record object keys, file IDs,
 * filenames, local paths, R2 endpoints or operator-supplied identities. */
export async function recordR2SeedObservation(
    db: Pick<Pool, 'query'>, runId: string, report: SeedReport,
): Promise<void> {
    if (!RUN_ID.test(runId)) throw new Error('Invalid backup run ID.');
    const safe = {
        runId, source: 'operator-cli',
        mode: report.mode, status: report.status, checked: report.checked,
        existingVerified: report.existingVerified, planned: report.planned,
        createdVerified: report.createdVerified, racedVerified: report.racedVerified,
        invalidMetadata: report.invalidMetadata, primaryMissing: report.primaryMissing,
        primaryCorrupt: report.primaryCorrupt, backupCorrupt: report.backupCorrupt,
        writesAttempted: report.writesAttempted,
        remaining: report.remaining, entireCatalogChecked: report.entireCatalogChecked,
        ...(['failed', 'empty'].includes(report.status) ? { outcome: 'failed' } : {}),
    };
    await db.query(`INSERT INTO audit_events(id,client,operation,after_state,created_at)
        VALUES(gen_random_uuid(),'atlas-backup-cli','backup.r2_seed_observed',$1::jsonb,now())`,
        [JSON.stringify(safe)]);
}


/** A thrown R2/DB read or write leaves the copy outcome unknown. Never infer
 * the last successfully copied object or persist raw exception details. */
export async function recordR2SeedAborted(
    db: Pick<Pool, 'query'>, runId: string, mode: SeedReport['mode'],
): Promise<void> {
    if (!RUN_ID.test(runId) || !['apply', 'dry-run'].includes(mode))
        throw new Error('Invalid backup observation.');
    await db.query(`INSERT INTO audit_events(id,client,operation,after_state,created_at)
        VALUES(gen_random_uuid(),'atlas-backup-cli','backup.r2_seed_observed',$1::jsonb,now())`,
        [JSON.stringify({ runId, source: 'operator-cli', mode,
            status: 'aborted', outcome: 'failed' })]);
}

export type R2SeedRunResult =
    | { kind: 'reported'; report: SeedReport; auditRecorded: boolean }
    | { kind: 'aborted'; auditRecorded: boolean };

/** The CLI uses this exact path for both returned and thrown seed outcomes.
 * Audit failures are reported separately and never reclassified as a failed
 * R2 operation; an aborted external PUT may already have written bytes. */
export async function runObservedR2Seed(
    db: Pick<Pool, 'query'>, runId: string, mode: SeedReport['mode'],
    seed: () => Promise<SeedReport>,
): Promise<R2SeedRunResult> {
    let report: SeedReport;
    try {
        report = await seed();
    } catch {
        try {
            await recordR2SeedAborted(db, runId, mode);
            return { kind: 'aborted', auditRecorded: true };
        } catch {
            return { kind: 'aborted', auditRecorded: false };
        }
    }
    try {
        await recordR2SeedObservation(db, runId, report);
        return { kind: 'reported', report, auditRecorded: true };
    } catch {
        return { kind: 'reported', report, auditRecorded: false };
    }
}
