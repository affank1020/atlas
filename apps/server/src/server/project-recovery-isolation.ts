/** An isolated recovery-only configuration MUST NOT load the server .env,
 * primary R2 credentials, primary database, or local Files fallback.
 * This still requires a physically isolated recovery host and restored DB. */
export function loadIsolatedRecoveryConfig(env:NodeJS.ProcessEnv){
    if(env.DATABASE_URL||env.ATLAS_R2_ACCESS_KEY_ID||env.ATLAS_R2_SECRET_ACCESS_KEY||
       env.ATLAS_R2_BUCKET||env.ATLAS_R2_ENDPOINT)
        throw new Error("Production database/R2 variables are forbidden in isolated verification.");
    if(env.ATLAS_RECOVERY_HOST_APPROVED!=="1"||!env.ATLAS_RESTORED_DATABASE_URL)
        throw new Error("Explicit isolated recovery host and restored database required.");
    const restored=new URL(env.ATLAS_RESTORED_DATABASE_URL);
    if(!["postgres:","postgresql:"].includes(restored.protocol) ||
       !["localhost","127.0.0.1","[::1]"].includes(restored.hostname) ||
       !/^\/atlas_recovery(?:_[a-z0-9_]+)?$/.test(restored.pathname) ||
       restored.search||restored.hash)
        throw new Error("Isolated verification requires a local disposable atlas_recovery database.");
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

