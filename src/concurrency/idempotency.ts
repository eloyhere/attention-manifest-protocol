/**
 * Idempotency for external effects.
 *
 * A message send or a tool call carries a key; the first successful attempt
 * stores its result, and a retry after a crash returns that result instead of
 * performing the effect twice. The unique primary key is the arbiter, so two
 * workers racing on the same key cannot both execute.
 */
import type { DatabaseSync } from "node:sqlite";

export interface OnceResult<T> {
    value: T;
    replayed: boolean;
}

type IdempotencyRow = {
    result: string;
};

type Once = <T>(db: DatabaseSync, key: string, at: string, fn: () => T) => OnceResult<T>;

export const once: Once = <T>(db: DatabaseSync, key: string, at: string, fn: () => T): OnceResult<T> => {
    const existing: IdempotencyRow | undefined = db.prepare("SELECT result FROM idempotency WHERE key = ?").get(key) as IdempotencyRow | undefined;
    if (existing !== (void 0)) {
        return { value: JSON.parse(existing.result) as T, replayed: true };
    }
    const value: T = fn();
    try {
        db.prepare("INSERT INTO idempotency (key, result, created_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), at);
        return { value, replayed: false };
    } catch {
        /**
         * Another worker won the insert between our SELECT and INSERT.
         */
        const row: IdempotencyRow | undefined = db.prepare("SELECT result FROM idempotency WHERE key = ?").get(key) as IdempotencyRow | undefined;
        if (row === (void 0)) {
            throw new Error(`idempotency key ${key} was not stored`);
        }
        return { value: JSON.parse(row.result) as T, replayed: true };
    }
};
