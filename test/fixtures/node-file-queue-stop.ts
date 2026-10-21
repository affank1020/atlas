import { NodeOfflineFileQueue } from '../../apps/node/src/core/file-queue.js';
import { readdir } from 'node:fs/promises';

/** Real child process test: a simulated slow HTTP request honours AbortSignal
 * and cannot exit until SIGTERM has stopped the worker and released its lock.
 */
const root = process.argv[2]!;
const identity = {
    nodeId: process.env.ATLAS_TEST_QUEUE_ID!,
    credential: process.env.ATLAS_TEST_QUEUE_CREDENTIAL!,
    serverUrl: process.env.ATLAS_TEST_QUEUE_SERVER!,
};
const queue = new NodeOfflineFileQueue(identity,root,async (_upload,signal)=>{
    process.stdout.write('SENDING\n');
    await new Promise<void>((_resolve,reject)=>{
        if (signal?.aborted) {
            reject(new Error('stopped')); return;
        }
        signal?.addEventListener('abort',()=>reject(new Error('stopped')),{once:true});
    });
    throw new Error('unexpected delivery');
});
process.on('SIGTERM',()=>{
    void queue.stop().then(async()=>{
        const after=await readdir(root);
        if (after.includes('.queue-lock')) {
            process.stderr.write('Queue lock still present after stop completion.\n');
            process.exit(2);return;
        }
        process.stdout.write('STOPPED\n');
        process.exit(0);
    },()=>{
        process.stderr.write('Queue stop promise rejected.\n');
        process.exit(1);
    });
});
void queue.flush().catch(()=>{
    process.exitCode=1;
});
