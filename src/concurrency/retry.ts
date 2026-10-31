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

export const isBusyError: (error: unknown) => boolean = (error: unknown): boolean => {
    const message: string = error instanceof Error ? error.message : `${error}`;
    return message.includes("database is locked") || message.includes("SQLITE_BUSY");
};

const defaultSleep: (ms: number) => Promise<void> = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const positiveSafeInteger: (value: number, name: string) => number = (value: number, name: string): number => {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    return value;
};

const nonNegativeFinite: (value: number, name: string) => number = (value: number, name: string): number => {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative finite number`);
    }
    return value;
};

type BusyRetry = <T>(fn: () => Promise<T> | T, options?: RetryOptions) => Promise<T>;

/**
 * Retry an async operation with exponential backoff while it is busy.
 */
export const withBusyRetry: BusyRetry = async <T>(fn: () => Promise<T> | T, options: RetryOptions = {}): Promise<T> => {
    const attempts: number = positiveSafeInteger(options.attempts ?? 5, "attempts");
    const baseMs: number = nonNegativeFinite(options.baseMs ?? 25, "baseMs");
    const maxMs: number = nonNegativeFinite(options.maxMs ?? 1000, "maxMs");
    if (maxMs < baseMs) {
        throw new RangeError("maxMs must be greater than or equal to baseMs");
    }
    const sleep: (ms: number) => Promise<void> = options.sleep ?? defaultSleep;
    const retryable: (error: unknown) => boolean = options.isRetryable ?? isBusyError;
    let lastError: unknown;
    for (let attempt: number = 0; attempt < attempts; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (!retryable(error) || attempt === attempts - 1) {
                throw error;
            }
            await sleep(Math.min(maxMs, baseMs * 2 ** attempt));
        }
    }
    throw lastError;
};
