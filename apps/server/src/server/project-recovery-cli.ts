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

/** An isolated recovery-only configuration MUST NOT load the server .env,
 * primary R2 credentials, primary database, or local Files fallback.
 * This still requires a physically isolated recovery host and restored DB. */
export function loadIsolatedRecoveryConfig(env:NodeJS.ProcessEnv){
    if(env.DATABASE_URL||env.ATLAS_R2_ACCESS_KEY_ID||env.ATLAS_R2_SECRET_ACCESS_KEY||
       env.ATLAS_R2_BUCKET||env.ATLAS_R2_ENDPOINT)
        throw new Error("Production database/R2 variables are forbidden in isolated verification.");
    if(env.ATLAS_RECOVERY_HOST_APPROVED!=="1"||!env.ATLAS_RESTORED_DATABASE_URL)
        throw new Error("Explicit isolated recovery host and restored database required.");
    const primaryId=env.ATLAS_R2_PRIMARY_ACCOUNT_ID??"";
    const endpoint=env.ATLAS_R2_RECOVERY_ENDPOINT??"";
    if(!/^[a-f0-9]{32}$/.test(primaryId))
        throw new Error("Expected original Cloudflare account ID is required.");
    const url=new URL(endpoint);
    const account=/^([a-f0-9]{32})\.(?:(?:eu|us|fedramp)\.)?r2\.cloudflarestorage\.com$/.exec(url.hostname);
    if(url.protocol!=="https:"||url.username||url.password||url.port||url.pathname!=="/"||
        url.search||url.hash||!account||account[1]===primaryId)
        throw new Error("Recovery R2 must use a different identifiable Cloudflare account.");
    const bucket=env.ATLAS_R2_RECOVERY_BUCKET??"";
    const accessKeyId=env.ATLAS_R2_RECOVERY_ACCESS_KEY_ID??"";
    const secretAccessKey=env.ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY??"";
    if(!bucket||!accessKeyId||!secretAccessKey)
        throw new Error("Independent recovery R2 configuration is incomplete.");
    return {databaseUrl:env.ATLAS_RESTORED_DATABASE_URL,
        r2:{endpoint,bucket,accessKeyId,secretAccessKey}};
}

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
