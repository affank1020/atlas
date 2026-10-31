import { Pool } from "pg";
import { R2ObjectStore } from "./file-storage.js";
import { loadIsolatedRecoveryConfig } from "./project-recovery-isolation.js";
import { parseIsolatedLegacyFilesArgs } from "./isolated-legacy-files-args.js";
import { verifyIsolatedLegacyFiles } from "./isolated-legacy-files-recovery.js";

// No dotenv, primary R2 connection, local Files fallback or data mutation.
// The existing isolated recovery config requires a local restored database,
// a different Cloudflare account and explicit recovery-host approval.
const args=parseIsolatedLegacyFilesArgs(process.argv.slice(2));
let database:Pool|undefined;
try{
    const configuration=loadIsolatedRecoveryConfig(process.env);
    database=new Pool({connectionString:configuration.databaseUrl,connectionTimeoutMillis:5000});
    const report=await verifyIsolatedLegacyFiles({
        restoredDatabase:database,backup:new R2ObjectStore(configuration.r2),
        maxRecords:args.maxRecords,
    });
    console.log(JSON.stringify(report,null,2));
    // Empty is an exact zero-inventory result, NOT evidence that any bytes
    // were restored. Partial or failed never counts as full verification.
    if(report.status!=="passed"&&report.status!=="empty")process.exitCode=2;
}catch{
    // Never print database URLs, account credentials or signed requests.
    console.error("Isolated legacy Files verification failed or was inconclusive. No source or recovery objects were changed.");
    process.exitCode=1;
}finally{await database?.end();}
