/**
 * Node daemon messages need source timestamps when systemd writes raw stdout /
 * stderr to the private service file. journalctl previously supplied those
 * timestamps, but StandardOutput=append does not.
 *
 * This logger is deliberately limited to the daemon's own diagnostics.
 * It does not claim to timestamp native crashes, direct stream writes or
 * arbitrary third-party output. macOS retains its existing launchd log format.
 */
export type NodeRuntimeLogSink = Pick<Console, 'log' | 'warn' | 'error'>;

export function createNodeRuntimeLogger(
    platform: NodeJS.Platform = process.platform,
    sink: NodeRuntimeLogSink = console,
    now: () => Date = () => new Date(),
) {
    const render = (message: string) => {
        if (platform !== 'linux') return message;
        const stamp = now().toISOString();
        // Prefix every emitted line, including multiline connection errors;
        // a caller-supplied line break cannot fabricate an untimestamped entry.
        return message.split(/\r\n|\r|\n/).map(line => stamp + ' ' + line).join('\n');
    };
    return {
        info: (message: string) => sink.log(render(message)),
        warn: (message: string) => sink.warn(render(message)),
        error: (message: string) => sink.error(render(message)),
    };
}
