import { config as loadEnv } from "dotenv";
import { Pool } from "pg";
import { loadPortfolioConfig, requireDatabaseUrl } from "./config.js";
import { LocalObjectStore, R2ObjectStore } from "./file-storage.js";
import { createR2SeedPrimarySource } from "./r2-backup-seeding.js";
import { loadRecoveryR2Config } from "./r2-recovery-verification.js";
import { parseProjectRecoveryArgs } from "./project-recovery-args.js";
import {
    captureProjectRecoveryManifest,seedProjectRecovery,verifyIsolatedProjectRecovery,
} from "./project-independent-recovery.js";

import { loadIsolatedRecoveryConfig } from "./project-recovery-isolation.js";

const args=parseProjectRecoveryArgs(process.argv.slice(2));
if(args.mode!=="isolated-verify")
    loadEnv({path:"apps/server/.env",quiet:true});
let pool:Pool|undefined;
try{
    if(args.mode==="isolated-verify"){
        const config=loadIsolatedRecoveryConfig(process.env);
        pool=new Pool({connectionString:config.databaseUrl,connectionTimeoutMillis:5000});
        const result=await verifyIsolatedProjectRecovery({restoredDatabase:pool,
            backup:new R2ObjectStore(config.r2),runId:args.runId!,
            projectId:args.projectId,fromOrdinal:args.fromOrdinal,maxFiles:args.maxFiles});
        console.log(JSON.stringify(result,null,2));
        if(result.status!=="passed")process.exitCode=2;
    }else{
        if(args.mode==="capture"&&process.env.ATLAS_PROJECT_RECOVERY_CAPTURE_ENABLED!=="1")
            throw new Error("Explicit Project recovery manifest capture gate disabled.");
        if(args.mode==="seed"&&process.env.ATLAS_PROJECT_RECOVERY_SEED_ENABLED!=="1")
            throw new Error("Independent Project recovery seed gate disabled.");
        const files=loadPortfolioConfig();
        if(!files.r2)throw new Error("Primary R2 must be configured.");
        const primary=new R2ObjectStore(files.r2);
        const source=createR2SeedPrimarySource(primary,new LocalObjectStore(files.mediaRoot));
        pool=new Pool({connectionString:requireDatabaseUrl(),connectionTimeoutMillis:5000});
        if(args.mode==="capture"){
            const result=await captureProjectRecoveryManifest({database:pool,source,
                projectId:args.projectId,versionedRunId:args.versionedRunId});
            console.log(JSON.stringify({runId:result.id,projectId:result.projectId,
                catalogSha256:result.catalogSha256,manifestSha256:result.manifestSha256,
                entries:result.entries.length,versionedCopyRunId:result.versionedCopyRunId,
                capturedAt:result.capturedAt},null,2));
        }else{
            const recovery=new R2ObjectStore(loadRecoveryR2Config(process.env,files.r2));
            const result=await seedProjectRecovery({database:pool,source,backup:recovery,
                runId:args.runId!,projectId:args.projectId,
                apply:args.mode==="seed",fromOrdinal:args.fromOrdinal,maxFiles:args.maxFiles});
            console.log(JSON.stringify(result,null,2));
            if(result.status==="partial")process.exitCode=2;
        }
    }
}catch{
    // External errors may contain signed URLs, identifiers, secrets or SQL.
    console.error("Project recovery operation failed or is inconclusive; sources remain unchanged. Review scope and destination before retrying.");
    process.exitCode=1;
}finally{await pool?.end();}
