import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createPiSession } from './session.mjs';

// A trusted embedder may supply session construction; commands cannot override this boundary.
export function servePiWorker(createSession = createPiSession) {
    let session;
    let active = false;
    const send = async record => {
        await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(record) + '\n', error => error ? reject(error) : resolve()));
    };
    const stop = () => {
        const timer = setTimeout(() => process.exit(1), 1000);
        session?.abort().finally(() => { session.dispose(); clearTimeout(timer); process.exit(1); });
        if (!session) process.exit(1);
    };
    process.on('SIGTERM', stop);
    process.stdin.on('end', stop); // Parent loss must not leave a model request alive.
    process.stdin.setEncoding('utf8');
    let input = '';
    process.stdin.on('data', async chunk => {
        input += chunk;
        if (Buffer.byteLength(input) > 128 * 1024 || active) return stop();
        if (!input.endsWith('\n')) return;
        active = true;
        try {
            const { prompt, profile } = z.object({ prompt: z.string().min(1).max(16384),
                profile: z.object({ id: z.string(), provider: z.literal('ollama'), model: z.string(), contextWindow: z.number(), maxTokens: z.number() }).strict() }).strict().parse(JSON.parse(input));
            ({ session } = await createSession(process.cwd(), profile.model, undefined, profile));
            let modelFailed = false;
            session.subscribe(event => {
                // Only metadata crosses the boundary: never file contents, prompts, model text or args.
                if (event.type === 'message_end' && event.message.role === 'assistant' &&
                    ['error', 'aborted'].includes(event.message.stopReason)) modelFailed = true;
                if (['agent_start', 'agent_end', 'agent_settled'].includes(event.type))
                    void send({ type: event.type });
                if (['tool_execution_start', 'tool_execution_end'].includes(event.type))
                    void send({ type: event.type, tool: event.toolName,
                        ...(event.type === 'tool_execution_end' && { isError: event.isError }) });
            });
            await send({ type: 'ready', version: '1.5.0' });
            await session.prompt(prompt);
            await send({ type: 'result', ok: !modelFailed });
            session.dispose();
            // Parent owns final process-group cleanup. Avoid an idle stdin keeping Pi alive.
            process.stdin.removeListener('end', stop);
            process.stdin.destroy();
            process.exitCode = modelFailed ? 1 : 0;
        } catch {
            await send({ type: 'worker_error' });
            session?.dispose();
            process.stdin.removeListener('end', stop);
            process.stdin.destroy();
            process.exitCode = 1;
        }
    });

}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href) servePiWorker();
