import {config as loadEnv} from "dotenv";
import {Pool} from "pg";
import {loadPortfolioConfig,requireDatabaseUrl} from "./config.js";
import {LocalObjectStore,R2ObjectStore} from "./file-storage.js";
import {createR2SeedPrimarySource} from "./r2-backup-seeding.js";
import {parseProjectKeyCutoverArgs} from "./project-key-cutover-args.js";
import {executeProjectKeyCutover,getProjectKeyCutoverStatus} from "./project-key-cutover.js";

// Manual operator-only program: no HTTP/MCP endpoint, automatic scheduling,
// PUT, DELETE, or server configuration toggle. Application and other storage
// writers MUST already be stopped for the entire cutover/rollback window.
loadEnv({path:"apps/server/.env",quiet:true});
let pool:Pool|undefined;
try{
    const command=parseProjectKeyCutoverArgs(process.argv.slice(2));
    if(command.mode!=="status"&&
       (process.env.ATLAS_PROJECT_STORAGE_CUTOVER_ENABLED!=="1"||
        process.env.ATLAS_PROJECT_VERSIONED_WRITES_ENABLED==="true"))
        throw new Error("Cutover requires an explicit operator gate and no active versioned writes.");
    pool=new Pool({connectionString:requireDatabaseUrl(),connectionTimeoutMillis:5000,max:2});
    if(command.mode==="status"){
        console.log(JSON.stringify(await getProjectKeyCutoverStatus(pool,command.projectId),null,2));
    }else{
        const config=loadPortfolioConfig();
        if(!config.r2)throw new Error("The primary R2 account is required for a cutover.");
        const primary=new R2ObjectStore(config.r2);
        const oldSource=createR2SeedPrimarySource(primary,new LocalObjectStore(config.mediaRoot));
        const result=await executeProjectKeyCutover({database:pool,projectId:command.projectId,
            keyRunId:command.keyRunId,mode:command.mode,
            oldSource,newPrimary:primary});
        console.log(JSON.stringify(result,null,2));
    }
}catch{
    // In particular, an interrupted COMMIT may have succeeded: operators must
    // inspect --status and the live catalogue, never blindly retry an apply.
    console.error("Project key cutover failed or has an unknown outcome. Inspect --status before taking further action.");
    process.exitCode=1;
}finally{await pool?.end();}
