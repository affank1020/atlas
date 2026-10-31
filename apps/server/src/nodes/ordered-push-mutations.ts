import { AtlasError } from '../shared/errors.js';

/**
 * Each registered Node socket processes FCM token mutations in wire order.
 * Async authentication/SQL must not let an older register commit after an
 * explicit unregister. Backpressure prevents unbounded queued requests.
 */
export class OrderedPushMutations {
    private tail: Promise<void> = Promise.resolve();
    private queued = 0;
    constructor(private readonly maxQueued = 8) {}

    run<T>(operation: () => Promise<T>): Promise<T> {
        if (this.queued >= this.maxQueued)
            return Promise.reject(new AtlasError('Push registration busy.', 'SHARE_BUSY'));
        this.queued++;
        const result = this.tail.then(operation);
        this.tail = result.then(() => undefined, () => undefined);
        void result.then(() => { this.queued--; }, () => { this.queued--; });
        return result;
    }
}
