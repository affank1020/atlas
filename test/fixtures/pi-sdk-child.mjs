import { servePiWorker } from '../../apps/node/pi-runtime/worker.mjs';
import { createPiSession } from '../../apps/node/pi-runtime/session.mjs';
const endpoint=process.argv[2];
if(endpoint==='session-error') {
    servePiWorker(async()=>{throw new Error('Private provider initialization detail');});
} else {
    if(!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(endpoint)) throw new Error('Expected a loopback test model.');
    servePiWorker((cwd,model,_endpoint,profile)=>createPiSession(cwd,model,endpoint,profile));
}
