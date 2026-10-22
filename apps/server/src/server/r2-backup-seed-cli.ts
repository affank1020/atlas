import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';
import { loadPortfolioConfig, requireDatabaseUrl } from './config.js';
import { R2ObjectStore } from './file-storage.js';
import { loadRecoveryR2Config } from './r2-recovery-verification.js';
import { parseR2BackupSeedArgs, previewR2BackupSeed, seedIndependentR2Backup } from './r2-backup-seeding.js';

// Trusted-host, manual-only operation. Dry-run has no R2 object requests.
// Apply is a separate, explicitly confirmed, small, append-only batch.
loadEnv({path:'apps/server/.env',quiet:true});
let pool:Pool|undefined;
try {
    const args=parseR2BackupSeedArgs(process.argv.slice(2));
    const primary=loadPortfolioConfig().r2;
    const backup=loadRecoveryR2Config(process.env,primary);
    pool=new Pool({connectionString:requireDatabaseUrl(),connectionTimeoutMillis:5000});
    const options={maxFiles:args.maxFiles,cursor:args.cursor};
    const result=args.apply
        ? await seedIndependentR2Backup({
            database:pool,primary:new R2ObjectStore(primary!),
            destination:new R2ObjectStore(backup),...options,
        })
        : await previewR2BackupSeed(pool,options);
    console.log(JSON.stringify(result,null,2));
    if (result.mode==='dry-run' && result.invalidMetadata) process.exitCode=2;
} catch {
    // Never log source/backup credentials, bucket URLs, file contents or
    // database errors containing sensitive connection details.
    console.error('Atlas independent R2 backup seeding failed or is inconclusive; inspect the backup and rerun safely.');
    process.exitCode=1;
} finally {
    await pool?.end();
}
