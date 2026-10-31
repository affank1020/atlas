import assert from "node:assert/strict";
import test from "node:test";
import {parseIsolatedLegacyFilesArgs} from "../apps/server/src/server/isolated-legacy-files-args.js";

test("Only read-only legacy recovery mode and bounded full-inventory limit are accepted",()=>{
    assert.deepEqual(parseIsolatedLegacyFilesArgs(["--verify-legacy"]),{maxRecords:100});
    assert.deepEqual(parseIsolatedLegacyFilesArgs(["--verify-legacy","--max-records=2000"]),
        {maxRecords:2000});
    for(const args of [
        [],["--max-records=5"],["--verify-legacy","--verify-legacy"],
        ["--verify-legacy","--apply"],["--verify-legacy","--delete"],
        ["--verify-legacy","--confirm=YES"],["--verify-legacy","--cursor=0"],
        ["--verify-legacy","--max-records=0"],["--verify-legacy","--max-records=2001"],
        ["--verify-legacy","--max-records=-1"],["--verify-legacy","--max-records=1.5"],
        ["--verify-legacy","--max-records=NaN"],["--verify-legacy","--max-records=Infinity"],
        ["--verify-legacy","--max-records=1","--max-records=2"],["--verify-legacy=yes"],
        ["--verify-legacy","--max-records="],
    ])assert.throws(()=>parseIsolatedLegacyFilesArgs(args),args.join(" "));
});
