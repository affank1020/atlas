import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseProjectKeyLedgerArgs } from "../apps/server/src/server/project-key-ledger-args.js";
import { CAPTURE_PROJECT_KEY_MANIFEST } from "../apps/server/src/server/project-key-ledger.js";
import { PROJECT_KEY_COPY_CONFIRMATION } from "../apps/server/src/server/project-key-migration.js";

test("Checkpoint CLI permits only explicit, Project-scoped and gated write modes", () => {
    const project=randomUUID(),run=randomUUID();
    assert.deepEqual(parseProjectKeyLedgerArgs(["--capture","--project="+project,
        "--confirm="+CAPTURE_PROJECT_KEY_MANIFEST]),{mode:"capture",projectId:project,maxFiles:3});
    assert.deepEqual(parseProjectKeyLedgerArgs(["--status","--run="+run]),
        {mode:"status",runId:run,maxFiles:3});
    assert.deepEqual(parseProjectKeyLedgerArgs(["--dry-run","--run="+run,"--project="+project,
        "--max-files=5"]),{mode:"dry-run",runId:run,projectId:project,maxFiles:5});
    assert.deepEqual(parseProjectKeyLedgerArgs(["--apply","--run="+run,"--project="+project,
        "--confirm="+PROJECT_KEY_COPY_CONFIRMATION]),
        {mode:"apply",runId:run,projectId:project,maxFiles:3});
    assert.deepEqual(parseProjectKeyLedgerArgs(["--audit","--run="+run,"--project="+project,
        "--from=2"]),{mode:"audit",runId:run,projectId:project,maxFiles:3,fromOrdinal:2});
    const failures=[
        [],["--capture"],["--capture","--project="+project],["--capture","--run="+run,
        "--project="+project,"--confirm="+CAPTURE_PROJECT_KEY_MANIFEST],
        ["--status","--run="+run,"--project="+project],
        ["--dry-run","--run="+run],["--apply","--run="+run,"--project="+project],
        ["--apply","--run="+run,"--project="+project,"--confirm=YES"],
        ["--apply","--dry-run","--run="+run,"--project="+project,
            "--confirm="+PROJECT_KEY_COPY_CONFIRMATION],
        ["--dry-run","--run="+run,"--project="+project,
            "--confirm="+PROJECT_KEY_COPY_CONFIRMATION],
        ["--audit","--run="+run,"--project="+project,"--from=-1"],
        ["--audit","--run="+run,"--project="+project,"--from=1.5"],
        ["--status","--run="+run,"--max-files=1"],
        ["--dry-run","--run="+run,"--project="+project,"--max-files=6"],
        ["--apply","--run="+run,"--project="+project,"--from=1",
            "--confirm="+PROJECT_KEY_COPY_CONFIRMATION],
        ["--apply","--run="+run,"--project=../etc",
            "--confirm="+PROJECT_KEY_COPY_CONFIRMATION],
        ["--status","--run="+run,"--run="+run],
        ["--copy","--run="+run],
    ];
    for(const args of failures) assert.throws(()=>parseProjectKeyLedgerArgs(args),args.join(" "));
});
