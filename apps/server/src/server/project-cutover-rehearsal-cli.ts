import { Pool } from "pg";
import { loadCutoverRehearsalConfig,parseCutoverRehearsalArgs } from "./project-cutover-rehearsal-args.js";
import { rehearseProjectCutover } from "./project-cutover-rehearsal.js";

// Deliberately do NOT load the server .env or accept production DATABASE_URL.
// This command has NO apply/commit path. It always rolls back ALL test
// metadata updates, even after a fully successful reversible rehearsal.
const args=parseCutoverRehearsalArgs(process.argv.slice(2));
let pool:Pool|undefined;
try{
    const config=loadCutoverRehearsalConfig(process.env);
    pool=new Pool({connectionString:config.databaseUrl,connectionTimeoutMillis:3000,max:2});
    const result=await rehearseProjectCutover({database:pool,...args});
    console.log(JSON.stringify(result,null,2));
}catch{
    console.error("Disposable Project cutover rehearsal failed or was inconclusive; no database transaction was committed.");
    process.exitCode=1;
}finally{await pool?.end();}
