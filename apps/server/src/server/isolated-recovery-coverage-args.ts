import type { RecoveryRunScope } from "./isolated-recovery-coverage.js";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function parseIsolatedRecoveryCoverageArgs(args:string[]):{
    projectRuns:RecoveryRunScope[];expectNoLegacy:boolean;expectNoProjects:boolean;
}{
    let verify=false,expectNoLegacy=false,expectNoProjects=false;
    const projectRuns:RecoveryRunScope[]=[],projects=new Set<string>(),runs=new Set<string>();
    for(const arg of args){
        if(arg==="--verify-all"){
            if(verify)throw new Error("Duplicate all-owner recovery mode.");
            verify=true;
        }else if(arg==="--expect-no-legacy"){
            if(expectNoLegacy)throw new Error("Duplicate zero-legacy acknowledgement.");
            expectNoLegacy=true;
        }else if(arg==="--expect-no-projects"){
            if(expectNoProjects)throw new Error("Duplicate zero-Project acknowledgement.");
            expectNoProjects=true;
        }else if(arg.startsWith("--project-run=")){
            const value=arg.slice("--project-run=".length);
            const parts=value.split(":");
            if(parts.length!==2||!UUID.test(parts[0]!)||!UUID.test(parts[1]!)||
               projects.has(parts[0]!)||runs.has(parts[1]!)||projectRuns.length>=25)
                throw new Error("Invalid or duplicate exact Project-to-recovery-run scope.");
            const [projectId,runId]=parts as [string,string];
            projectRuns.push({projectId,runId});
            projects.add(projectId);runs.add(runId);
        }else throw new Error("Only read-only isolated recovery coverage options are supported.");
    }
    if(!verify||expectNoProjects&&projectRuns.length)
        throw new Error("Explicit read-only verification and consistent Project selection are required.");
    return {projectRuns,expectNoLegacy,expectNoProjects};
}
