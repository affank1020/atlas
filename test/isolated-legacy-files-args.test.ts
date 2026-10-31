import assert from "node:assert/strict";
import test from "node:test";
import {parseIsolatedLegacyFilesArgs,isolatedLegacyVerificationExitCode} from "../apps/server/src/server/isolated-legacy-files-args.js";

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

test("CLI exit policy never treats empty, partial, failed or inconsistent recovery as success",()=>{
    const code=isolatedLegacyVerificationExitCode;
    assert.equal(code({status:"passed",checked:2,entireLegacyCatalogVerified:true}),0);
    for(const report of [
        {status:"empty" as const,checked:0,entireLegacyCatalogVerified:false},
        {status:"partial" as const,checked:2,entireLegacyCatalogVerified:false},
        {status:"failed" as const,checked:2,entireLegacyCatalogVerified:false},
        {status:"passed" as const,checked:0,entireLegacyCatalogVerified:false},
        {status:"passed" as const,checked:2,entireLegacyCatalogVerified:false},
        {status:"passed" as const,checked:0,entireLegacyCatalogVerified:true},
    ])assert.equal(code(report),2,JSON.stringify(report));
});
