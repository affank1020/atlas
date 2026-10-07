/** Owns existing background work; this is not an automation scheduler. */
export class ServerLifecycle {
    private readonly pending = new Set<Promise<unknown>>();
    private closing?: Promise<void>;
    private stopping = false;
    constructor(private readonly resources: Array<{ close(): Promise<void> }>, private readonly report: (message: string) => void = console.error) {}
    run(label: string, operation: () => Promise<unknown>) {
        if (this.stopping) throw new Error('Atlas Server is stopping.');
        const task = Promise.resolve().then(operation).catch(() => this.report(`${label} failed; inspect the integration status.`));
        this.pending.add(task);
        void task.finally(() => this.pending.delete(task));
    }
    close(): Promise<void> {
        if (!this.closing) {
            this.stopping = true;
            this.closing = (async () => {
                await Promise.allSettled(this.pending);
                const results = await Promise.allSettled(this.resources.map(resource => resource.close()));
                const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
                if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Atlas Server resource shutdown failed.');
            })();
        }
        return this.closing;
    }
}
