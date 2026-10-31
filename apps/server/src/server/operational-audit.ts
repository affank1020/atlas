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
    };
    await db.query(`INSERT INTO audit_events(id,client,operation,after_state,created_at)
        VALUES(gen_random_uuid(),'atlas-backup-cli','backup.r2_seed_observed',$1::jsonb,now())`,
        [JSON.stringify(safe)]);
}
