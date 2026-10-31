/**
 * An async mutex for in-process critical sections.
 *
 * The kernel's own writes are synchronous and serialized by SQLite, so this is
 * for handlers that interleave at `await` points: a tool call, an LLM request,
 * a file write. It is not a cross-worker lock — for that, use the database
 * lease (`claimThread` + fencing token), because a promise cannot be shared
 * between `worker_threads`.
 */
export class Mutex {
    private tail: Promise<void> = Promise.resolve();

    async run<T>(fn: () => Promise<T> | T): Promise<T> {
        const previous: Promise<void> = this.tail;
        let release: () => void = () => {};
        this.tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await fn();
        } finally {
            release();
        }
    }
}
