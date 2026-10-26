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

export const once = <T>(db: DatabaseSync, key: string, at: string, fn: () => T): OnceResult<T> => {
    const existing = db.prepare("SELECT result FROM idempotency WHERE key = ?").get(key) as { result: string } | undefined;
    if (existing !== undefined) {
        return { value: JSON.parse(existing.result) as T, replayed: true };
    }
    const value: T = fn();
    try {
        db.prepare("INSERT INTO idempotency (key, result, created_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), at);
        return { value, replayed: false };
    } catch {
        // Another worker won the insert between our SELECT and INSERT.
        const row = db.prepare("SELECT result FROM idempotency WHERE key = ?").get(key) as { result: string } | undefined;
        if (row === undefined) throw new Error(`idempotency key ${key} was not stored`);
        return { value: JSON.parse(row.result) as T, replayed: true };
    }
};
