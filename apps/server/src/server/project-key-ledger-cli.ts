import { config as loadEnv } from "dotenv";
import { Pool } from "pg";
import { loadPortfolioConfig, requireDatabaseUrl } from "./config.js";
import { LocalObjectStore, R2ObjectStore } from "./file-storage.js";
import { createR2SeedPrimarySource } from "./r2-backup-seeding.js";
import { parseProjectKeyLedgerArgs } from "./project-key-ledger-args.js";
import {
    auditProjectKeyRun, advanceProjectKeyRun,
    captureProjectKeyRun, projectKeyLedgerStatus,
} from "./project-key-ledger.js";

// Privileged operator CLI only. No HTTP endpoint, scheduled copy or production
// side effects until exact command, confirmation and environment gates.
loadEnv({path:"apps/server/.env",quiet:true});
let pool:Pool | undefined;
try {
    const command=parseProjectKeyLedgerArgs(process.argv.slice(2));
    if (["capture","apply"].includes(command.mode) &&
        process.env.ATLAS_PROJECT_KEY_LEDGER_ENABLED !== "1")
        throw new Error("Project key checkpoint write gate disabled.");
    if (command.mode === "apply" && process.env.ATLAS_PROJECT_KEY_COPY_ENABLED !== "1")
        throw new Error("Project key copy apply gate disabled.");
    pool=new Pool({connectionString:requireDatabaseUrl(),connectionTimeoutMillis:5000});
    let result: unknown;
    if (command.mode === "capture") {
        const run=await captureProjectKeyRun(pool,command.projectId!);
        // Exclude the full immutable manifest from console receipts.
        result={runId:run.id,projectId:run.projectId,manifestSha256:run.manifestSha256,
            count:run.objectCount,capturedAt:run.capturedAt};
    } else if (command.mode === "status") {
        result=await projectKeyLedgerStatus(pool,command.runId!);
    } else {
        const storage=loadPortfolioConfig();
        if (!storage.r2) throw new Error("Primary R2 is not configured.");
        const destination=new R2ObjectStore(storage.r2);
        const source=createR2SeedPrimarySource(destination,new LocalObjectStore(storage.mediaRoot));
        if (command.mode === "audit") {
            result=await auditProjectKeyRun({database:pool,source,destination,
                runId:command.runId!,projectId:command.projectId!,
                fromOrdinal:command.fromOrdinal,maxFiles:command.maxFiles});
        } else {
            result=await advanceProjectKeyRun({database:pool,source,destination,
                runId:command.runId!,projectId:command.projectId!,
                apply:command.mode==="apply",maxFiles:command.maxFiles});
        }
    }
    console.log(JSON.stringify(result,null,2));
} catch {
    // Raw errors may include private object identifiers or signed R2 URLs.
    console.error("Project key checkpoint operation failed or was inconclusive; no source object deletion or key cutover occurred.");
    process.exitCode=1;
} finally { await pool?.end(); }
