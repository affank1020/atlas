// Explicit local operator harness; deliberately not a Server/MCP entrypoint.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { piStartSchema } from '../packages/protocol/dist/pi-worker.js';
import { WorkspaceFiles } from '../apps/node/dist/capabilities/workspace-files/files.js';
import { PiWorkerSupervisor } from '../apps/node/dist/capabilities/pi/supervisor.js';

if (process.argv.length !== 4 || process.argv[2] !== '--approve-read-only')
    throw new Error('Usage: node scripts/pi-worker-local.mjs --approve-read-only /absolute/operator-request.json');
const manifest = z.object({
    nodeId: z.string().uuid(), roots: z.array(z.string().startsWith('/')).min(1).max(8),
    rootPath: z.string().startsWith('/'), request: piStartSchema,
}).strict().parse(JSON.parse(await readFile(process.argv[3], 'utf8')));
const request = manifest.request;
const workspace = { id: request.workspaceId, nodeId: manifest.nodeId,
    rootPath: manifest.rootPath, status: 'active' };
const workers = new PiWorkerSupervisor(manifest.nodeId, new WorkspaceFiles(manifest.roots), [{
    runId: request.runId, workspaceId: request.workspaceId, rootPath: manifest.rootPath,
    nodeId: manifest.nodeId, head: request.expectedHead, branch: request.expectedBranch,
    promptSha256: createHash('sha256').update(request.prompt).digest('hex'),
    timeoutMs: request.timeoutMs, expiresAt: new Date(Date.now() + 60_000).toISOString(),
}]);
process.on('SIGINT', () => workers.cancel(workspace, request.runId));
process.on('SIGTERM', () => { void workers.close(); });
let cursor = 0;
try {
    console.log(JSON.stringify(await workers.start(workspace, request)));
    while (true) {
        const page = workers.events(workspace, request.runId, cursor);
        for (const event of page.events) console.log(JSON.stringify(event));
        cursor = page.lastCursor;
        const receipt = workers.get(workspace, request.runId);
        if (receipt.finishedAt) {
            console.log(JSON.stringify(receipt));
            process.exitCode = receipt.state === 'completed' ? 0 : 1;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
} finally { await workers.close(); }
