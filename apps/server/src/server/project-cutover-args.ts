export type CutoverCommand={
    mode:"plan"|"verify";projectId:string;keyRunId:string;recoveryRunId:string;
    fromOrdinal:number;maxFiles:number;
};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function parseProjectCutoverArgs(args:string[]):CutoverCommand{
    const mode=["--plan","--verify"],allowed=[...mode,"--project","--key-run","--recovery-run","--from","--max-files"];
    const values=new Map<string,string>();
    for(const arg of args){
        const p=arg.split("="),flag=p[0]!;
        if(!allowed.includes(flag)||values.has(flag)||
           (mode.includes(flag)?p.length!==1:p.length!==2))
            throw new Error("Invalid cutover preflight arguments.");
        values.set(flag,p[1]??"");
    }
    if(values.has("--plan")&&values.has("--verify"))
        throw new Error("Choose one cutover preflight mode.");
    const projectId=values.get("--project")??"";
    const keyRunId=values.get("--key-run")??"";
    const recoveryRunId=values.get("--recovery-run")??"";
    if(![projectId,keyRunId,recoveryRunId].every(x=>UUID.test(x)))
        throw new Error("Project and both immutable run IDs are required.");
    const fromOrdinal=values.has("--from")?Number(values.get("--from")):0;
    const maxFiles=values.has("--max-files")?Number(values.get("--max-files")):3;
    if(!Number.isSafeInteger(fromOrdinal)||fromOrdinal<0||
       !Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>5)
        throw new Error("Cutover page must be a bounded nonnegative ordinal and 1-5 objects.");
    return {mode:values.has("--verify")?"verify":"plan",
        projectId,keyRunId,recoveryRunId,fromOrdinal,maxFiles};
}
