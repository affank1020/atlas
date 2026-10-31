import { Pool } from "pg";
import { R2ObjectStore } from "./file-storage.js";
import { loadIsolatedRecoveryConfig } from "./project-recovery-isolation.js";
import { parseIsolatedRecoveryCoverageArgs } from "./isolated-recovery-coverage-args.js";
import { verifyIsolatedRecoveryCoverage } from "./isolated-recovery-coverage.js";

// Does not load the server .env. The existing isolated guard forbids primary
// DB/R2 credentials, requires a local restored DB and a separate R2 account.
// No primary object store, writes or production activation path exists.
const args=parseIsolatedRecoveryCoverageArgs(process.argv.slice(2));
let database:Pool|undefined;
try{
    const config=loadIsolatedRecoveryConfig(process.env);
    database=new Pool({connectionString:config.databaseUrl,connectionTimeoutMillis:5000,max:2});
    const result=await verifyIsolatedRecoveryCoverage({
        restoredDatabase:database,backup:new R2ObjectStore(config.r2),...args});
    console.log(JSON.stringify(result,null,2));
    // "object-scope-passed" is NOT a disaster recovery readiness signal.
    if(result.status!=="object-scope-passed")process.exitCode=2;
}catch{
    // Never include a caught driver error, URL, secret or object key in logs.
    console.error("Isolated all-owner recovery coverage failed or was inconclusive; no objects or metadata were changed.");
    process.exitCode=1;
}finally{await database?.end();}
