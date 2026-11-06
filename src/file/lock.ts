import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { Optional, isNumber, isObject, isString } from "semantic-typescript";
import { WorkspaceError } from "../workspace/types.ts";

/** Durable lock metadata stored next to the target file. */
export interface LockRecord {
    readonly target: string;
    readonly owner: string;
    readonly fence: number;
    readonly token: string;
    readonly expiresAt: string;
}

export interface LockHandle {
    readonly record: LockRecord;
    /** Extends the lease; fails when the token is no longer the holder. */
    refresh(ttlMilliseconds?: number): LockRecord;
    /** Removes the lock only when the token still matches. */
    release(): boolean;
}

export interface NodeFileLockOptions {
    readonly defaultTtlMilliseconds?: number;
    readonly clock?: () => number;
    readonly fsync?: boolean;
}

export const DEFAULT_LOCK_TTL_MILLISECONDS = 30_000;

export function lockPathOf(target: string): string {
    return `${target}.lock`;
}

/** Monotonic fencing counter; it outlives individual locks so stale handles stay stale. */
export function fencePathOf(target: string): string {
    return `${target}.fence`;
}

function errno(error: unknown): string | undefined {
    return isObject(error) && isString((error as NodeJS.ErrnoException).code) ? (error as NodeJS.ErrnoException).code : undefined;
}

function ioError(action: string, error: unknown): WorkspaceError {
    const code = errno(error);
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
        return new WorkspaceError("read_only", `cannot ${action}: ${code}`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new WorkspaceError("io_error", `cannot ${action}: ${detail}`);
}

function parseRecord(raw: string, target: string): Optional<LockRecord> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return Optional.empty();
    }
    if (!isObject(parsed)) return Optional.empty();
    const value = parsed as Record<string, unknown>;
    if (!isString(value.owner) || !value.owner || !isString(value.token) || !value.token
        || !isNumber(value.fence) || !Number.isSafeInteger(value.fence) || value.fence < 1
        || !isString(value.expiresAt) || !Number.isFinite(Date.parse(value.expiresAt))) return Optional.empty();
    return Optional.of(Object.freeze({ target, owner: value.owner, fence: value.fence, token: value.token, expiresAt: value.expiresAt }));
}

/**
 * Cross-process advisory lock over `<target>.lock` using O_CREAT|O_EXCL.
 * A live holder is never stolen; only an expired lease may be taken over, and the
 * takeover re-checks the moved record so a concurrent refresh wins.
 */
export class NodeFileLock {
    private readonly defaultTtlMilliseconds: number;
    private readonly clock: () => number;
    private readonly fsync: boolean;

    constructor(options: NodeFileLockOptions = {}) {
        const ttl = options.defaultTtlMilliseconds ?? DEFAULT_LOCK_TTL_MILLISECONDS;
        if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new TypeError("lock TTL must be a positive safe integer");
        this.defaultTtlMilliseconds = ttl;
        this.clock = options.clock ?? (() => Date.now());
        this.fsync = options.fsync ?? true;
    }

    inspect(target: string): Optional<LockRecord> {
        try {
            return parseRecord(readFileSync(lockPathOf(target), "utf8"), target);
        } catch {
            return Optional.empty();
        }
    }

    isExpired(record: LockRecord): boolean {
        return Date.parse(record.expiresAt) <= this.clock();
    }

    acquire(target: string, owner: string, ttlMilliseconds = this.defaultTtlMilliseconds): LockHandle {
        if (!isString(target) || !target) throw new TypeError("lock target is required");
        if (!isString(owner) || !owner) throw new TypeError("lock owner is required");
        if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds <= 0) throw new TypeError("lock TTL must be a positive safe integer");
        const lockPath = lockPathOf(target);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const fence = this.peekFence(target);
            const record: LockRecord = Object.freeze({ target, owner, fence,
                token: randomBytes(12).toString("hex"), expiresAt: new Date(this.clock() + ttlMilliseconds).toISOString() });
            try {
                this.writeExclusive(lockPath, record);
            } catch (error) {
                if (errno(error) !== "EEXIST") throw ioError("acquire lock", error);
                const holder = this.inspect(target);
                if (holder.isEmpty()) continue;
                if (!this.isExpired(holder.get())) {
                    throw new WorkspaceError("fence_rejected", `file is locked by ${holder.get().owner} until ${holder.get().expiresAt}`);
                }
                this.takeOver(target, holder.get());
                continue;
            }
            this.persistFence(target, fence);
            return this.handle(record);
        }
        throw new WorkspaceError("fence_rejected", "could not acquire the file lock");
    }

    /** Highest fence seen in the counter file or in a live lock record, plus one. */
    private peekFence(target: string): number {
        let persisted = 0;
        try {
            const parsed = Number.parseInt(readFileSync(fencePathOf(target), "utf8").trim(), 10);
            if (Number.isSafeInteger(parsed) && parsed > 0) persisted = parsed;
        } catch {
            /* first acquisition */
        }
        const holder = this.inspect(target);
        const live = holder.isPresent() ? holder.get().fence : 0;
        return Math.max(persisted, live) + 1;
    }

    private persistFence(target: string, fence: number): void {
        const path = fencePathOf(target);
        try {
            const existing = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
            if (Number.isSafeInteger(existing) && existing >= fence) return;
        } catch {
            /* no counter yet */
        }
        const fd = openSync(path, "w", 0o600);
        try {
            writeSync(fd, String(fence));
            if (this.fsync) fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
    }

    refresh(target: string, token: string, ttlMilliseconds = this.defaultTtlMilliseconds): LockRecord {
        const current = this.inspect(target);
        if (current.isEmpty() || current.get().token !== token) {
            throw new WorkspaceError("fence_rejected", "lock token is no longer the holder");
        }
        const record: LockRecord = Object.freeze({ ...current.get(), expiresAt: new Date(this.clock() + ttlMilliseconds).toISOString() });
        try {
            const fd = openSync(lockPathOf(target), "w", 0o600);
            try {
                writeSync(fd, JSON.stringify(record));
                if (this.fsync) fsyncSync(fd);
            } finally {
                closeSync(fd);
            }
        } catch (error) {
            throw ioError("refresh lock", error);
        }
        return record;
    }

    release(target: string, token: string): boolean {
        const current = this.inspect(target);
        if (current.isEmpty() || current.get().token !== token) return false;
        try {
            unlinkSync(lockPathOf(target));
            return true;
        } catch (error) {
            if (errno(error) === "ENOENT") return false;
            throw ioError("release lock", error);
        }
    }

    private handle(record: LockRecord): LockHandle {
        return Object.freeze({
            record,
            refresh: (ttlMilliseconds = this.defaultTtlMilliseconds) => this.refresh(record.target, record.token, ttlMilliseconds),
            release: () => this.release(record.target, record.token),
        });
    }

    private writeExclusive(lockPath: string, record: LockRecord): void {
        const fd = openSync(lockPath, "wx", 0o600);
        try {
            writeSync(fd, JSON.stringify(record));
            if (this.fsync) fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
    }

    private takeOver(target: string, observed: LockRecord): void {
        const lockPath = lockPathOf(target);
        const moved = `${lockPath}.stale-${randomBytes(6).toString("hex")}`;
        try {
            renameSync(lockPath, moved);
        } catch (error) {
            if (errno(error) === "ENOENT") return;
            throw ioError("take over lock", error);
        }
        let movedRecord: Optional<LockRecord>;
        try {
            movedRecord = parseRecord(readFileSync(moved, "utf8"), target);
        } catch {
            movedRecord = Optional.empty();
        }
        if (movedRecord.isPresent() && !this.isExpired(movedRecord.get()) && movedRecord.get().token !== observed.token) {
            try {
                renameSync(moved, lockPath);
            } catch {
                /* the refreshed holder keeps its own lock; leave the move behind */
            }
            throw new WorkspaceError("fence_rejected", `file lock was refreshed by ${movedRecord.get().owner}`);
        }
        try {
            unlinkSync(moved);
        } catch {
            /* stale copy is harmless */
        }
    }
}
