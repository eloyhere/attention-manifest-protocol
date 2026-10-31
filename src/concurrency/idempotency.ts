/**
 * Idempotency for external effects.
 *
 * A message send or a tool call carries a key; the first successful attempt
 * stores its result, and a retry after commit returns that result. The write
 * transaction serializes workers before executing a synchronous callback. Only
 * effects in this SQLite transaction roll back with the result; external effects
 * still need their own idempotency key to survive a crash before commit.
 */
import type { DatabaseSync } from "node:sqlite";
import { isAsyncFunction } from "node:util/types";
import { transaction } from "../database/store/database.ts";

export interface OnceResult<T> {
    value: T;
    replayed: boolean;
}

type IdempotencyRow = {
    result: string;
};

interface PossibleThenable {
    then?: unknown;
}

type Once = <T>(db: DatabaseSync, key: string, at: string, fn: () => T) => OnceResult<T>;

const ActiveKeys: WeakMap<DatabaseSync, Set<string>> = new WeakMap();
let SavepointSequence: number = 0;

export const once: Once = <T>(db: DatabaseSync, key: string, at: string, fn: () => T): OnceResult<T> => {
    let active: Set<string> | undefined = ActiveKeys.get(db);
    if (active?.has(key)) {
        throw new Error(`idempotency key ${key} cannot execute reentrantly`);
    }
    active ??= new Set();
    ActiveKeys.set(db, active);
    active.add(key);
    const execute: () => OnceResult<T> = (): OnceResult<T> => {
        const existing: IdempotencyRow | undefined = db.prepare("SELECT result FROM idempotency WHERE key = ?").get(key) as IdempotencyRow | undefined;
        if (existing !== (void 0)) {
            return { value: JSON.parse(existing.result) as T, replayed: true };
        }
        if (isAsyncFunction(fn)) {
            throw new TypeError("idempotency callback must be synchronous");
        }
        const value: T = fn();
        if (value !== null && (typeof(value) === "object" || typeof(value) === "function") && typeof((value as PossibleThenable).then) === "function") {
            throw new TypeError("idempotency callback must return a synchronous result");
        }
        const serialized: string | undefined = JSON.stringify(value);
        if (serialized === (void 0)) {
            throw new TypeError("idempotency result must be JSON serializable");
        }
        db.prepare("INSERT INTO idempotency (key, result, created_at) VALUES (?, ?, ?)").run(key, serialized, at);
        return { value, replayed: false };
    };
    try {
        if (!db.isTransaction) {
            return transaction(db, execute);
        }
        /**
         * Isolate callback writes even when the outer transaction catches failure.
         */
        const savepoint: string = `idempotency_${++SavepointSequence}`;
        db.exec(`SAVEPOINT ${savepoint}`);
        try {
            const result: OnceResult<T> = execute();
            db.exec(`RELEASE ${savepoint}`);
            return result;
        } catch (error) {
            try {
                db.exec(`ROLLBACK TO ${savepoint}`);
                db.exec(`RELEASE ${savepoint}`);
            } catch {
                /**
                 * A trigger may have already rolled back the entire transaction.
                 */
            }
            throw error;
        }
    } finally {
        active.delete(key);
        if (active.size === 0) {
            ActiveKeys.delete(db);
        }
    }
};
