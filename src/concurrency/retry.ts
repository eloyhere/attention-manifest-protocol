/**
 * Retry helpers for the two kinds of contention a kernel sees.
 *
 * - SQLite write contention between `worker_threads`: `SQLITE_BUSY`. The
 *   connection sets `busy_timeout`, and async callers can additionally back off
 *   with {@link withBusyRetry}.
 * - Application-level contention: a lease or a row version that moved. Callers
 *   should re-read and decide, not retry blindly.
 */

export interface RetryOptions {
    attempts?: number;
    baseMs?: number;
    maxMs?: number;
    sleep?: (ms: number) => Promise<void>;
    isRetryable?: (error: unknown) => boolean;
}

export const isBusyError = (error: unknown): boolean => {
    const message: string = error instanceof Error ? error.message : `${error}`;
    return message.includes("database is locked") || message.includes("SQLITE_BUSY");
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry an async operation with exponential backoff while it is busy. */
export const withBusyRetry = async <T>(fn: () => Promise<T> | T, options: RetryOptions = {}): Promise<T> => {
    const attempts: number = options.attempts ?? 5;
    const baseMs: number = options.baseMs ?? 25;
    const maxMs: number = options.maxMs ?? 1000;
    const sleep = options.sleep ?? defaultSleep;
    const retryable = options.isRetryable ?? isBusyError;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (!retryable(error) || attempt === attempts - 1) throw error;
            await sleep(Math.min(maxMs, baseMs * 2 ** attempt));
        }
    }
    throw lastError;
};
