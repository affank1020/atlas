import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {parseProjectRecoveryArgs} from "../apps/server/src/server/project-recovery-args.js";
import {loadIsolatedRecoveryConfig} from "../apps/server/src/server/project-recovery-isolation.js";
import {PROJECT_RECOVERY_CAPTURE_CONFIRM,PROJECT_RECOVERY_SEED_CONFIRM}
  from "../apps/server/src/server/project-independent-recovery.js";

test("Project recovery CLI scopes all modes, confirmations and bounds",()=>{
    const project=randomUUID(),run=randomUUID(),versioned=randomUUID();
    assert.equal(parseProjectRecoveryArgs(["--capture","--project="+project,
        "--confirm="+PROJECT_RECOVERY_CAPTURE_CONFIRM]).mode,"capture");
    assert.equal(parseProjectRecoveryArgs(["--capture","--project="+project,
        "--versioned-run="+versioned,"--confirm="+PROJECT_RECOVERY_CAPTURE_CONFIRM]).versionedRunId,versioned);
    assert.equal(parseProjectRecoveryArgs(["--seed","--project="+project,
        "--run="+run,"--confirm="+PROJECT_RECOVERY_SEED_CONFIRM]).mode,"seed");
    assert.deepEqual(parseProjectRecoveryArgs(["--status","--project="+project,"--run="+run]),
        {mode:"status",projectId:project,runId:run,maxFiles:3});
    assert.equal(parseProjectRecoveryArgs(["--dry-run","--project="+project,"--run="+run,
        "--from=3","--max-files=5"]).fromOrdinal,3);
    assert.equal(parseProjectRecoveryArgs(["--isolated-verify","--project="+project,
        "--run="+run,"--max-files=2000"]).maxFiles,2000);
    for(const args of [
        [],["--seed"],["--seed","--run="+run,"--project="+project],
        ["--seed","--run="+run,"--project="+project,"--confirm=YES"],
        ["--dry-run","--project="+project,"--run="+run,
            "--confirm="+PROJECT_RECOVERY_SEED_CONFIRM],
        ["--capture","--project="+project],
        ["--capture","--project="+project,"--run="+run,
            "--confirm="+PROJECT_RECOVERY_CAPTURE_CONFIRM],
        ["--capture","--project="+project,"--from=0",
            "--confirm="+PROJECT_RECOVERY_CAPTURE_CONFIRM],
        ["--seed","--project="+project,"--run="+run,"--versioned-run="+versioned,
            "--confirm="+PROJECT_RECOVERY_SEED_CONFIRM],
        ["--status","--project="+project],
        ["--status","--project="+project,"--run="+run,"--from=0"],
        ["--status","--project="+project,"--run="+run,"--max-files=1"],
        ["--status","--project="+project,"--run="+run,"--confirm="+PROJECT_RECOVERY_SEED_CONFIRM],
        ["--isolated-verify","--project="+project],
        ["--isolated-verify","--project="+project,"--run="+run,"--from=-1"],
        ["--isolated-verify","--project="+project,"--run="+run,"--max-files=2001"],
        ["--dry-run","--project="+project,"--run="+run,"--max-files=6"],
        ["--dry-run","--project=../etc","--run="+run],
        ["--dry-run","--project="+project,"--run="+run,"--run="+run],
        ["--seed","--dry-run","--project="+project,"--run="+run,
            "--confirm="+PROJECT_RECOVERY_SEED_CONFIRM],
        ["--delete","--project="+project,"--run="+run],
    ])assert.throws(()=>parseProjectRecoveryArgs(args),args.join(" "));
});
const primary="a".repeat(32),backup="b".repeat(32);
const valid={
    ATLAS_RECOVERY_HOST_APPROVED:"1",
    ATLAS_RESTORED_DATABASE_URL:"postgresql://restorer:secret@127.0.0.1:9999/atlas_recovery",
    ATLAS_R2_PRIMARY_ACCOUNT_ID:primary,
    ATLAS_R2_RECOVERY_ENDPOINT:"https://"+backup+".r2.cloudflarestorage.com/",
    ATLAS_R2_RECOVERY_BUCKET:"offline-backups",
    ATLAS_R2_RECOVERY_ACCESS_KEY_ID:"offline-id",
    ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY:"offline-secret",
};
test("Isolated verification refuses primary credentials, DB environment and same Cloudflare account",()=>{
    const config=loadIsolatedRecoveryConfig(valid);
    assert.equal(config.r2.bucket,"offline-backups");
    assert.equal(config.databaseUrl,valid.ATLAS_RESTORED_DATABASE_URL);
    for(const extra of [
        {DATABASE_URL:"postgresql://production"},
        {ATLAS_R2_ACCESS_KEY_ID:"production-id"},
        {ATLAS_R2_SECRET_ACCESS_KEY:"production-secret"},
        {ATLAS_R2_BUCKET:"primary"},
        {ATLAS_R2_ENDPOINT:"https://"+primary+".r2.cloudflarestorage.com/"},
        {ATLAS_RECOVERY_HOST_APPROVED:"0"},
        {ATLAS_R2_RECOVERY_ENDPOINT:"https://"+primary+".r2.cloudflarestorage.com/"},
        {ATLAS_R2_RECOVERY_ENDPOINT:"https://example.org/"},
        {ATLAS_R2_RECOVERY_ENDPOINT:"http://"+backup+".r2.cloudflarestorage.com/"},
        {ATLAS_R2_RECOVERY_ENDPOINT:"https://"+backup+".r2.cloudflarestorage.com/other"},
        {ATLAS_R2_RECOVERY_ACCESS_KEY_ID:""},
        {ATLAS_RESTORED_DATABASE_URL:""},
        {ATLAS_RESTORED_DATABASE_URL:"postgresql://restorer@production-db.internal/atlas_recovery"},
        {ATLAS_RESTORED_DATABASE_URL:"postgresql://restorer@127.0.0.1:5432/atlas"},
        {ATLAS_RESTORED_DATABASE_URL:"postgresql://restorer@127.0.0.1:5432/atlas_recovery?host=production-db.internal"},
        {ATLAS_R2_PRIMARY_ACCOUNT_ID:"unknown"},
    ]) assert.throws(()=>loadIsolatedRecoveryConfig({...valid,...extra}),JSON.stringify(extra));
});
