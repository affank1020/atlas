import { PROJECT_RECOVERY_CAPTURE_CONFIRM, PROJECT_RECOVERY_SEED_CONFIRM } from "./project-independent-recovery.js";
export type RecoveryCommand={
    mode:"capture"|"dry-run"|"seed"|"isolated-verify";
    projectId:string;runId?:string;versionedRunId?:string;fromOrdinal?:number;maxFiles:number;
};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function parseProjectRecoveryArgs(args:string[]):RecoveryCommand{
    const modes=["--capture","--dry-run","--seed","--isolated-verify"];
    const allowed=[...modes,"--project","--run","--versioned-run","--from","--max-files","--confirm"];
    const flags=new Map<string,string>();
    for(const a of args){
        const parts=a.split("="),name=parts[0]!;
        if(!allowed.includes(name)||flags.has(name)||
            (modes.includes(name)?parts.length!==1:parts.length!==2))
            throw new Error("Invalid Project recovery command arguments.");
        flags.set(name,parts[1]??"");
    }
    const selected=modes.filter(x=>flags.has(x));
    if(selected.length!==1)throw new Error("Choose exactly one Project recovery mode.");
    const mode=selected[0]!.slice(2) as RecoveryCommand["mode"];
    const projectId=flags.get("--project")??"",runId=flags.get("--run");
    const versionedRunId=flags.get("--versioned-run");
    if(!UUID.test(projectId)||runId!==undefined&&!UUID.test(runId)||
       versionedRunId!==undefined&&!UUID.test(versionedRunId))
        throw new Error("Project recovery identity must be a canonical UUID.");
    if(mode==="capture"?
        Boolean(runId)||flags.has("--from")||flags.has("--max-files")||
        flags.get("--confirm")!==PROJECT_RECOVERY_CAPTURE_CONFIRM:
        !runId||versionedRunId!==undefined||
        (mode==="seed"?flags.get("--confirm")!==PROJECT_RECOVERY_SEED_CONFIRM:
          flags.has("--confirm")))
        throw new Error("Project recovery mode requires an exact scoped run and confirmation.");
    const maxFiles=flags.has("--max-files")?Number(flags.get("--max-files")):
        mode==="isolated-verify"?100:3;
    const max=mode==="isolated-verify"?2000:5;
    if(!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>max)
        throw new Error("Invalid bounded Project recovery page size.");
    const fromOrdinal=flags.has("--from")?Number(flags.get("--from")):undefined;
    if(fromOrdinal!==undefined&&(!Number.isSafeInteger(fromOrdinal)||fromOrdinal<0))
        throw new Error("Invalid Project recovery cursor ordinal.");
    return {mode,projectId,maxFiles,...(runId?{runId}:{}),
        ...(versionedRunId?{versionedRunId}:{}),
        ...(fromOrdinal!==undefined?{fromOrdinal}:{})};
}
