/**
 * Named leases for cross-worker mutual exclusion.
 *
 * A capability answers "may this subject touch the resource"; a lease answers
 * "who is touching it now". The fencing counter makes a stale holder's writes
 * rejectable even after the lease has been reassigned.
 */
import type { DatabaseSync } from "node:sqlite";

export interface LockRecord {
    name: string;
    holder: string;
    fencing: number;
    acquiredAt: string;
    expiresAt: string;
}

interface LockRow {
    name: string;
    holder: string;
    fencing: number;
    acquired_at: string;
    expires_at: string;
}

const toRecord = (row: LockRow): LockRecord => ({
    name: row.name,
    holder: row.holder,
    fencing: row.fencing,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
});

const expiry = (at: string, ttlMs: number): string => new Date(Date.parse(at) + ttlMs).toISOString();

export const getLock = (db: DatabaseSync, name: string): LockRecord | undefined => {
    const row = db.prepare("SELECT * FROM resource_locks WHERE name = ?").get(name) as unknown as LockRow | undefined;
    return row === undefined ? undefined : toRecord(row);
};

/**
 * Acquire a lease when it is free, expired, or already held by the same holder.
 * Returns `undefined` when another holder owns a live lease.
 */
export const acquireLock = (db: DatabaseSync, name: string, holder: string, at: string, ttlMs = 15_000): LockRecord | undefined => {
    const result = db
        .prepare(
            `INSERT INTO resource_locks (name, holder, fencing, acquired_at, expires_at)
             VALUES (?, ?, 1, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               holder = excluded.holder,
               fencing = resource_locks.fencing + 1,
               acquired_at = excluded.acquired_at,
               expires_at = excluded.expires_at
             WHERE resource_locks.expires_at <= ? OR resource_locks.holder = ?`,
        )
        .run(name, holder, at, expiry(at, ttlMs), at, holder);
    if (Number(result.changes) !== 1) return undefined;
    return getLock(db, name);
};

export const renewLock = (db: DatabaseSync, name: string, holder: string, fencing: number, at: string, ttlMs = 15_000): boolean => {
    const result = db
        .prepare("UPDATE resource_locks SET expires_at = ? WHERE name = ? AND holder = ? AND fencing = ?")
        .run(expiry(at, ttlMs), name, holder, fencing);
    return Number(result.changes) === 1;
};

export const releaseLock = (db: DatabaseSync, name: string, holder: string, fencing: number): boolean => {
    const result = db.prepare("DELETE FROM resource_locks WHERE name = ? AND holder = ? AND fencing = ?").run(name, holder, fencing);
    return Number(result.changes) === 1;
};
