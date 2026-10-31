import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {parseProjectCutoverArgs} from "../apps/server/src/server/project-cutover-args.js";

test("Preflight CLI defaults to metadata-only, requires full Project/run scope, and caps pages",()=>{
    const project=randomUUID(),key=randomUUID(),recovery=randomUUID();
    const scope=["--project="+project,"--key-run="+key,"--recovery-run="+recovery];
    assert.deepEqual(parseProjectCutoverArgs(scope),{
        mode:"plan",projectId:project,keyRunId:key,recoveryRunId:recovery,
        fromOrdinal:0,maxFiles:3,
    });
    assert.deepEqual(parseProjectCutoverArgs(["--verify",...scope,"--from=5","--max-files=5"]),{
        mode:"verify",projectId:project,keyRunId:key,recoveryRunId:recovery,
        fromOrdinal:5,maxFiles:5,
    });
    for(const args of [
        [],["--verify"],["--project="+project],
        ["--plan",...scope,"--verify"],
        [...scope,"--apply"],[...scope,"--confirm=YES"],
        [...scope,"--max-files=0"],[...scope,"--max-files=6"],
        [...scope,"--max-files=2.5"],[...scope,"--max-files=NaN"],
        [...scope,"--from=-1"],[...scope,"--from=1.5"],
        [...scope,"--from=Infinity"],
        [...scope,"--project="+project],
        [...scope,"--recovery-run=../etc"],[...scope,"--key-run="+recovery+"?bad"],
        ["--plan="+project,...scope],
    ])assert.throws(()=>parseProjectCutoverArgs(args),args.join(" "));
});
