// Admin-local approval only. No approval grant/revoke surface is exposed over MCP or HTTP.
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { AgentService } from '../apps/server/dist/agents/service.js';
import { NodeService } from '../apps/server/dist/nodes/service.js';
import { PostgresNodeRepository } from '../apps/server/dist/infrastructure/database/nodes.js';
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try {
    const service=new AgentService(pool,new NodeService(new PostgresNodeRepository(pool)));
    if(process.argv[2]==='grant'&&process.argv.length===4)
        console.log(JSON.stringify(await service.approve(JSON.parse(await readFile(process.argv[3],'utf8')))));
    else if(process.argv[2]==='revoke'&&process.argv.length===4) {
        await service.revoke(process.argv[3]);console.log(JSON.stringify({revoked:true}));
    } else throw new Error('Usage: node scripts/agent-approval.mjs grant /private/request.json | revoke approvalUUID');
} finally {await pool.end();}
