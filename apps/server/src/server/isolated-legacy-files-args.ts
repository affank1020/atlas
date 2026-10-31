import type { IsolatedLegacyRecoveryReport } from "./isolated-legacy-files-recovery.js";
import {
    ISOLATED_LEGACY_DEFAULT_RECORDS,ISOLATED_LEGACY_MAX_RECORDS,
} from "./isolated-legacy-files-recovery.js";

export function parseIsolatedLegacyFilesArgs(args:string[]):{maxRecords:number}{
    const allowed=["--verify-legacy","--max-records"];
    const flags=new Map<string,string>();
    for(const item of args){
        const parts=item.split("="),flag=parts[0]!;
        if(!allowed.includes(flag)||flags.has(flag)||
           (flag==="--verify-legacy"?parts.length!==1:parts.length!==2))
            throw new Error("Invalid isolated legacy Files verification arguments.");
        flags.set(flag,parts[1]??"");
    }
    if(!flags.has("--verify-legacy"))
        throw new Error("Explicit read-only --verify-legacy mode is required.");
    const maxRecords=flags.has("--max-records")?
        Number(flags.get("--max-records")):ISOLATED_LEGACY_DEFAULT_RECORDS;
    if(!Number.isSafeInteger(maxRecords)||maxRecords<1||
       maxRecords>ISOLATED_LEGACY_MAX_RECORDS)
        throw new Error("Isolated legacy Files verification limit must be 1..2000.");
    return {maxRecords};
}

/** Operator-facing exit policy used by the CLI: only a complete, nonempty
 * verification is success. Keep empty distinct in JSON but fail closed for
 * shell scripts and CI that only inspect the process exit code. */
export function isolatedLegacyVerificationExitCode(
    report: Pick<IsolatedLegacyRecoveryReport,"status"|"checked"|"entireLegacyCatalogVerified">,
):0|2 {
    return report.status==="passed"&&report.entireLegacyCatalogVerified&&report.checked>0?0:2;
}
