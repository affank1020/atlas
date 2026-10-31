import { config as loadEnv } from "dotenv";
import { Pool } from "pg";
import { loadPortfolioConfig, requireDatabaseUrl } from "./config.js";
import { LocalObjectStore, R2ObjectStore } from "./file-storage.js";
import { createR2SeedPrimarySource } from "./r2-backup-seeding.js";
import { loadRecoveryR2Config } from "./r2-recovery-verification.js";
import { parseProjectCutoverArgs } from "./project-cutover-args.js";
import { assessProjectCutover } from "./project-cutover-readiness.js";

// Operator-only read-only preflight. No API, migration, PUT, DELETE, key
// flip, transaction write, approval toggle, scheduling or retention action.
loadEnv({path:"apps/server/.env",quiet:true});
let pool:Pool|undefined;
try{
    const command=parseProjectCutoverArgs(process.argv.slice(2));
    pool=new Pool({connectionString:requireDatabaseUrl(),connectionTimeoutMillis:5000});
    if(command.mode==="plan"){
        // No object-store configuration needed; exact metadata-only assessment.
        const result=await assessProjectCutover({database:pool,...command});
        console.log(JSON.stringify(result,null,2));
        if(result.blockers.length||result.remaining)process.exitCode=2;
    }else{
        const config=loadPortfolioConfig();
        if(!config.r2)throw new Error("Primary R2 is not configured.");
        const live=new R2ObjectStore(config.r2);
        const recovery=new R2ObjectStore(loadRecoveryR2Config(process.env,config.r2));
        const effectiveSource=createR2SeedPrimarySource(live,new LocalObjectStore(config.mediaRoot));
        const result=await assessProjectCutover({database:pool,...command,
            oldSource:effectiveSource,versionedPrimary:live,independentBackup:recovery});
        console.log(JSON.stringify(result,null,2));
        // Passing a page does not imply verified whole-catalogue coverage.
        // Neither status is permission for production metadata cutover.
        if(result.blockers.length||result.remaining||result.byteVerification!=="passed-page")
            process.exitCode=2;
    }
}catch{
    // SQL errors and R2 signed requests may contain private identifiers or
    // credentials. Error class only, never raw exception text.
    console.error("Project cutover preflight failed or was inconclusive. No storage or database changes were made.");
    process.exitCode=1;
}finally{await pool?.end();}
