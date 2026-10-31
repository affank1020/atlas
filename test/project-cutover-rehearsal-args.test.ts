import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
    CUTOVER_REHEARSAL_CONFIRM,loadCutoverRehearsalConfig,parseCutoverRehearsalArgs,
} from "../apps/server/src/server/project-cutover-rehearsal-args.js";

test("Explicitly confirmed simulation is the only CLI mode and all three IDs are required",()=>{
    const project=randomUUID(),key=randomUUID(),recovery=randomUUID();
    const expected={projectId:project,keyRunId:key,recoveryRunId:recovery};
    const valid=["--simulate","--project="+project,
        "--key-run="+key,"--recovery-run="+recovery,
        "--confirm="+CUTOVER_REHEARSAL_CONFIRM];
    assert.deepEqual(parseCutoverRehearsalArgs(valid),expected);
    for(const invalid of [
        [],valid.filter(x=>x!=="--simulate"),
        valid.filter(x=>!x.startsWith("--project=")),
        valid.filter(x=>!x.startsWith("--key-run=")),
        valid.filter(x=>!x.startsWith("--recovery-run=")),
        valid.filter(x=>!x.startsWith("--confirm=")),
        valid.map(x=>x.startsWith("--confirm=")?"--confirm=YES":x),
        [...valid,"--apply"],[...valid,"--rollback"],[...valid,"--commit"],
        [...valid,"--project="+project],
        valid.map(x=>x.startsWith("--project=")?"--project=../etc":x),
        valid.map(x=>x.startsWith("--key-run=")?"--key-run="+randomUUID()+"?evil":x),
        ["--simulate="+project,...valid],
    ])assert.throws(()=>parseCutoverRehearsalArgs(invalid));
});
test("Standalone CLI config refuses primary DB and production R2, requires local disposable DB",()=>{
    const config={ATLAS_CUTOVER_REHEARSAL_ENABLED:"1",
        ATLAS_CUTOVER_REHEARSAL_DATABASE_URL:
        "postgresql://rehearsal:secret@127.0.0.1:5432/atlas_cutover_rehearsal"};
    assert.equal(loadCutoverRehearsalConfig(config).databaseUrl,
        config.ATLAS_CUTOVER_REHEARSAL_DATABASE_URL);
    for(const extra of [
        {ATLAS_CUTOVER_REHEARSAL_ENABLED:"0"},
        {ATLAS_CUTOVER_REHEARSAL_DATABASE_URL:""},
        {DATABASE_URL:"postgresql://prod.internal/atlas"},
        {ATLAS_R2_SECRET_ACCESS_KEY:"prod"},
        {ATLAS_R2_ACCESS_KEY_ID:"prod"},
        {ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY:"backup-prod"},
        {ATLAS_CUTOVER_REHEARSAL_DATABASE_URL:"postgresql://u@prod.internal/atlas_cutover_rehearsal"},
        {ATLAS_CUTOVER_REHEARSAL_DATABASE_URL:"postgresql://u@127.0.0.1/atlas"},
        {ATLAS_CUTOVER_REHEARSAL_DATABASE_URL:"postgresql://u@127.0.0.1/atlas_cutover_rehearsal?host=prod"},
        {ATLAS_CUTOVER_REHEARSAL_DATABASE_URL:"http://127.0.0.1/atlas_cutover_rehearsal"},
    ])assert.throws(()=>loadCutoverRehearsalConfig({...config,...extra}));
});
