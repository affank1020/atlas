export type ProjectKeyCutoverArgs = {
    mode: "status" | "apply" | "rollback";
    projectId: string;
    keyRunId?: string;
};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const APPLY_CONFIRM="APPLY_PROJECT_STORAGE_KEY_CUTOVER";
export const ROLLBACK_CONFIRM="ROLLBACK_PROJECT_STORAGE_KEY_CUTOVER";

export function parseProjectKeyCutoverArgs(args:string[]):ProjectKeyCutoverArgs {
    const flags=new Map<string,string>();
    for(const arg of args){
        const [name,...value]=arg.split("=");
        if(!["--status","--apply","--rollback","--project","--key-run","--confirm"].includes(name!) ||
            flags.has(name!) ||
            (["--status","--apply","--rollback"].includes(name!) ? value.length!==0 : value.length!==1))
            throw new Error("Invalid Project Storage cutover arguments.");
        flags.set(name!,value[0]??"");
    }
    const modes=["--status","--apply","--rollback"].filter(f=>flags.has(f));
    if(modes.length!==1 || !UUID.test(flags.get("--project")??""))
        throw new Error("Exactly one mode and a valid Project UUID are required.");
    const mode=modes[0]==="--status"?"status":modes[0]==="--apply"?"apply":"rollback";
    const keyRunId=flags.get("--key-run"),confirmation=flags.get("--confirm");
    if(mode==="apply"&&(!keyRunId||!UUID.test(keyRunId)||confirmation!==APPLY_CONFIRM) ||
       mode==="rollback"&&(keyRunId!==undefined||confirmation!==ROLLBACK_CONFIRM) ||
       mode==="status"&&(confirmation!==undefined||keyRunId!==undefined))
        throw new Error("Project Storage cutover requires exact scope and mode-specific confirmation.");
    return {mode,projectId:flags.get("--project")!,...(keyRunId?{keyRunId}:{})};
}
