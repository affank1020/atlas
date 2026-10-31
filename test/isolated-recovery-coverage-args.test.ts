import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {parseIsolatedRecoveryCoverageArgs} from "../apps/server/src/server/isolated-recovery-coverage-args.js";

test("All-owner recovery command requires explicit read-only mode and scoped run for every Project",()=>{
    const p=randomUUID(),r=randomUUID();
    const given=["--verify-all","--project-run="+p+":"+r];
    assert.deepEqual(parseIsolatedRecoveryCoverageArgs(given),{
        projectRuns:[{projectId:p,runId:r}],expectNoLegacy:false,expectNoProjects:false,
    });
    assert.deepEqual(parseIsolatedRecoveryCoverageArgs([
        "--verify-all","--expect-no-projects","--expect-no-legacy"
    ]),{projectRuns:[],expectNoLegacy:true,expectNoProjects:true});
    for(const args of [
        [],["--project-run="+p+":"+r],["--verify-all","--verify-all"],
        [...given,"--apply"],[...given,"--delete"],[...given,"--commit"],
        [...given,"--confirm=YES"],[...given,"--cursor=1"],
        [...given,"--project-run="+p+":"+randomUUID()],
        [...given,"--project-run="+randomUUID()+":"+r],
        [...given,"--expect-no-projects"],
        [...given,"--expect-no-legacy","--expect-no-legacy"],
        [...given,"--project-run=nope:"+r],
        [...given,"--project-run="+p+":../bad"],
        [...given,"--project-run="+p+":"+r+":extra"],
        ["--verify-all=yes"],
        ["--verify-all",...Array.from({length:26},
            ()=>"--project-run="+randomUUID()+":"+randomUUID())],
    ])assert.throws(()=>parseIsolatedRecoveryCoverageArgs(args),args.join(" "));
});
