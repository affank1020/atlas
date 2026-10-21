import { config as loadEnv } from 'dotenv';
import { basename } from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { NodeOfflineFileQueue } from './file-queue.js';

loadEnv({path:process.env.ATLAS_NODE_ENV_FILE || '.env.node',quiet:true});
const nodeId = process.env.ATLAS_NODE_ID ?? '';
const credential = process.env.ATLAS_NODE_CREDENTIAL ?? '';
const serverUrl = process.env.ATLAS_SERVER_URL ?? 'ws://127.0.0.1:3000/node/connect';
const queue = new NodeOfflineFileQueue({nodeId,credential,serverUrl});
const [action,...args] = process.argv.slice(2);

async function localBytes(location: string): Promise<Uint8Array> {
    const fh = await open(location,constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await fh.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > 25 * 1024 * 1024)
            throw new Error('Only regular files up to 25 MiB can be queued.');
        const bytes = await fh.readFile();
        if (bytes.length !== stat.size || bytes.length > 25 * 1024 * 1024)
            throw new Error('Local file changed during queue admission.');
        return bytes;
    } finally { await fh.close(); }
}

try {
    if (action === 'enqueue' && (args.length === 3 || args.length === 4)) {
        const [workspaceId,location,mimeType,fileName] = args;
        const uploadId=await queue.enqueue({
            workspaceId:workspaceId!, fileName:fileName ?? basename(location!),mimeType:mimeType!,
            bytes:await localBytes(location!),
        });
        console.log(JSON.stringify({queued:true,uploadId}));
    } else if (action === 'status' && !args.length) {
        console.log(JSON.stringify(await queue.snapshot()));
    } else if (action === 'restart-new' && args.length===1) {
        // Explicit operator acknowledgement: old upload might already have
        // committed despite an ambiguous response. Inspect server first.
        const next=await queue.restartWithNewId(args[0]!);
        console.log(JSON.stringify({queued:true,queueId:args[0],uploadId:next}));
    } else if (action === 'discard' && args.length===1) {
        await queue.discard(args[0]!);
        console.log(JSON.stringify({discarded:true}));
    } else {
        throw new Error('Usage: enqueue <workspace-uuid> <file-path> <mime-type> [display-name] | status | restart-new <uuid> | discard <uuid>');
    }
} catch(error) {
    // Never print Node credentials, the full local path, or file contents.
    console.error(error instanceof Error && error.message.startsWith('Usage:')
        ? error.message : 'Atlas offline file queue operation failed.');
    process.exitCode=1;
}
