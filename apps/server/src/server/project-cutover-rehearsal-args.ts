export type CutoverRehearsalArgs={
    projectId:string;keyRunId:string;recoveryRunId:string;
};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const CUTOVER_REHEARSAL_CONFIRM="SIMULATE_PROJECT_CUTOVER_ROLLBACK";
export function parseCutoverRehearsalArgs(args:string[]):CutoverRehearsalArgs{
    const allowed=["--simulate","--project","--key-run","--recovery-run","--confirm"];
    const values=new Map<string,string>();
    for(const item of args){
        const parts=item.split("="),flag=parts[0]!;
        if(!allowed.includes(flag)||values.has(flag)||
           (flag==="--simulate"?parts.length!==1:parts.length!==2))
            throw new Error("Invalid Project cutover rehearsal arguments.");
        values.set(flag,parts[1]??"");
    }
    const projectId=values.get("--project")??"",
        keyRunId=values.get("--key-run")??"",
        recoveryRunId=values.get("--recovery-run")??"";
    if(!values.has("--simulate")||values.get("--confirm")!==CUTOVER_REHEARSAL_CONFIRM||
       ![projectId,keyRunId,recoveryRunId].every(x=>UUID.test(x)))
        throw new Error("Rehearsal requires exact Project/run scope and simulation confirmation.");
    return {projectId,keyRunId,recoveryRunId};
}
/** No main DB URL, server .env, primary R2 endpoint or remote PostgreSQL
 * URL is permitted. A localhost port forward can still target elsewhere:
 * this is a defence in depth check, NOT a proof of physical isolation. */
export function loadCutoverRehearsalConfig(env:NodeJS.ProcessEnv){
    if(env.ATLAS_CUTOVER_REHEARSAL_ENABLED!=="1"||env.DATABASE_URL||
       env.ATLAS_R2_SECRET_ACCESS_KEY||env.ATLAS_R2_ACCESS_KEY_ID||
       env.ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY)
        throw new Error("Production DB/R2 environment or simulation gate is not acceptable.");
    const raw=env.ATLAS_CUTOVER_REHEARSAL_DATABASE_URL??"";
    let url:URL;
    try{url=new URL(raw);}catch{throw new Error("A local disposable rehearsal database URL is required.");}
    if(!["postgres:","postgresql:"].includes(url.protocol)||
       !["localhost","127.0.0.1","[::1]"].includes(url.hostname)||
       !/^\/atlas_cutover_rehearsal(?:_[a-z0-9_]+)?$/.test(url.pathname)||
       url.search||url.hash)
        throw new Error("Only local disposable atlas_cutover_rehearsal databases are allowed.");
    return {databaseUrl:raw};
}
