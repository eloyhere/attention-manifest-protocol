import type { Identifier } from "../shared.ts";
import { mergeIsolationChanges } from "./merge.ts";
import type {
    CooperationIsolationAdapter,
    IsolationAcquireOptions,
    IsolationChange,
    IsolationHandle,
    IsolationLockMode,
    IsolationMergeResult,
    IsolationRegion,
    IsolationResource,
    IsolationSyntaxValidator,
} from "./types.ts";

export { mergeIsolationChanges } from "./merge.ts";
export type { IsolationMergeOptions } from "./merge.ts";
export { balancedSyntaxValidator, contentHash } from "./merge.ts";

export const DEFAULT_ISOLATION_TTL_MILLISECONDS = 30_000;

const fail = (message: string): never => {
    throw new TypeError(message);
};
const text = (value: unknown, field: string): string => typeof value === "string" && value.trim().length > 0 ? value : fail(`${field} must be a nonempty string`);
const positiveInteger = (value: unknown, field: string): number => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fail(`${field} must be a positive safe integer`);

/** Rejects a lease that cannot be acquired; `code` is stable for callers. */
export class IsolationConflictError extends Error {
    readonly code = "isolation_conflict" as const;
    readonly resource: IsolationResource;
    readonly holder?: IsolationHandle;
    readonly cause?: unknown;

    constructor(resource: IsolationResource, detail: string, holder?: IsolationHandle, cause?: unknown) {
        super(`isolation_conflict: ${detail}`);
        this.name = "IsolationConflictError";
        this.resource = resource;
        if (holder !== undefined) this.holder = holder;
        if (cause !== undefined) this.cause = cause;
    }
}

/** Raised when a wait-for cycle is detected before two agents can block forever. */
export class IsolationDeadlockError extends Error {
    readonly code = "isolation_deadlock" as const;
    readonly resource: IsolationResource;
    readonly holder?: IsolationHandle;

    constructor(resource: IsolationResource, detail: string, holder?: IsolationHandle) {
        super(`isolation_deadlock: ${detail}`);
        this.name = "IsolationDeadlockError";
        this.resource = resource;
        if (holder !== undefined) this.holder = holder;
    }
}

/** Synchronous sleeper; hosts/tests can inject a non-blocking replacement. */
export const defaultIsolationSleep = (milliseconds: number): void => {
    if (milliseconds <= 0) return;
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    } catch {
        const deadline = Date.now() + milliseconds;
        while (Date.now() < deadline) { /* bounded spin when Atomics.wait is unavailable */ }
    }
};

/**
 * Wait-for graph shared by adapters that support waiting acquires. An edge points
 * from a waiting agent to the current holder; reaching the waiting agent again is a
 * cycle and is reported as `IsolationDeadlockError` instead of blocking forever.
 */
export class IsolationWaitForGraph {
    private readonly edges = new Map<string, Set<string>>();

    add(waiting: string, holder: string): void {
        const holders = this.edges.get(waiting);
        if (holders === undefined) this.edges.set(waiting, new Set([holder]));
        else holders.add(holder);
    }

    clear(waiting: string): void {
        this.edges.delete(waiting);
    }

    wouldDeadlock(waiting: string, holder: string): boolean {
        if (waiting === holder) return true;
        const visited = new Set<string>();
        const stack: string[] = [holder];
        while (stack.length > 0) {
            const current = stack.pop() as string;
            if (current === waiting) return true;
            if (visited.has(current)) continue;
            visited.add(current);
            for (const next of this.edges.get(current) ?? []) stack.push(next);
        }
        return false;
    }

    snapshot(): readonly { readonly waiting: string; readonly holder: string }[] {
        const result: { readonly waiting: string; readonly holder: string }[] = [];
        for (const [waiting, holders] of this.edges) for (const holder of holders) result.push({ waiting, holder });
        return Object.freeze(result);
    }
}

const validateRegion = (region: IsolationRegion, field: string): void => {
    if (region === null || typeof region !== "object") fail(`${field} must be an object`);
    if (!Number.isSafeInteger(region.start) || region.start < 0) fail(`${field}.start must be a nonnegative safe integer`);
    if (!Number.isSafeInteger(region.end) || region.end < region.start) fail(`${field}.end must be a safe integer >= start`);
};

export const validateIsolationResource = (resource: IsolationResource, mode: IsolationLockMode): void => {
    if (resource === null || typeof resource !== "object") fail("Isolation resource must be an object");
    text(resource.cooperationId, "Isolation resource cooperationId");
    text(resource.agentId, "Isolation resource agentId");
    text(resource.resourceId, "Isolation resource resourceId");
    if (!["exclusive", "shared", "region"].includes(mode)) fail(`Invalid isolation lock mode: ${mode}`);
    if (resource.lockScope !== undefined && !["file", "region", "workspace"].includes(resource.lockScope)) {
        fail(`Invalid isolation lock scope: ${resource.lockScope}`);
    }
    if (resource.region !== undefined) validateRegion(resource.region, "Isolation resource region");
    if (mode === "region" && resource.region === undefined) fail("A region lock requires resource.region");
    if (mode !== "region" && resource.region !== undefined) fail("resource.region requires the region lock mode");
};

export const regionsOverlap = (left: IsolationRegion, right: IsolationRegion): boolean => left.start < right.end && right.start < left.end;

export const sameIsolationResource = (left: IsolationResource, right: IsolationResource): boolean =>
    left.cooperationId === right.cooperationId && left.resourceId === right.resourceId;

/**
 * True when a requested lease conflicts with a held lease. Shared leases coexist
 * with shared leases only; region leases coexist with disjoint region leases only.
 */
export const isolationLeasesConflict = (held: { readonly resource: IsolationResource; readonly mode: IsolationLockMode }, resource: IsolationResource, mode: IsolationLockMode): boolean => {
    if (!sameIsolationResource(held.resource, resource)) return false;
    if (mode === "shared" && held.mode === "shared") return false;
    if (mode === "region" && held.mode === "region") {
        return regionsOverlap(resource.region as IsolationRegion, held.resource.region as IsolationRegion);
    }
    return true;
};

export type InMemoryIsolationAdapterOptions = {
    /** Epoch milliseconds; tests can inject a deterministic clock. */
    readonly clock?: () => number;
    /** Overrides the lightweight default syntax validator used by semantic merge. */
    readonly syntaxValidator?: IsolationSyntaxValidator;
};

/**
 * Default, host-neutral isolation adapter. Leases live in one process and expire
 * lazily against the injected clock; it is not a cross-process lock. Waiting
 * acquires build a wait-for graph and raise `IsolationDeadlockError` on a cycle.
 */
export class InMemoryIsolationAdapter implements CooperationIsolationAdapter {
    private readonly clock: () => number;
    private readonly syntaxValidator?: IsolationSyntaxValidator;
    private readonly leases = new Map<Identifier, { readonly handle: IsolationHandle; readonly expiresAtEpoch: number }>();
    private readonly waitFor = new IsolationWaitForGraph();
    private sequence = 0;

    constructor(options: InMemoryIsolationAdapterOptions = {}) {
        this.clock = options.clock ?? (() => Date.now());
        this.syntaxValidator = options.syntaxValidator;
    }

    acquire(resource: IsolationResource, mode: IsolationLockMode, ttlMilliseconds: number, options: IsolationAcquireOptions = {}): IsolationHandle {
        validateIsolationResource(resource, mode);
        positiveInteger(ttlMilliseconds, "Isolation TTL");
        const waitMilliseconds = options.waitMilliseconds ?? 0;
        if (waitMilliseconds < 0 || !Number.isFinite(waitMilliseconds)) fail("Isolation waitMilliseconds must be a finite number >= 0");
        if (waitMilliseconds > 0) return this.acquireWithWait(resource, mode, ttlMilliseconds, waitMilliseconds, options.sleep ?? defaultIsolationSleep);
        const handle = this.tryAcquire(resource, mode, ttlMilliseconds);
        return handle;
    }

    release(handle: IsolationHandle): boolean {
        if (handle === null || typeof handle !== "object") return false;
        this.prune(this.clock());
        const lease = this.leases.get(handle.handleId);
        if (lease === undefined || lease.handle.token !== handle.token) return false;
        this.leases.delete(handle.handleId);
        return true;
    }

    merge(changes: readonly IsolationChange[]): IsolationMergeResult {
        return mergeIsolationChanges(changes, { clock: this.clock, ...(this.syntaxValidator === undefined ? {} : { syntaxValidator: this.syntaxValidator }) });
    }

    /** Diagnostics/tests: live leases after pruning expired ones. */
    activeHandles(): IsolationHandle[] {
        this.prune(this.clock());
        return [...this.leases.values()].map(lease => lease.handle);
    }

    /** Diagnostics/tests: current wait-for edges (agent -> blockers). */
    waitForEdges(): readonly { readonly waiting: string; readonly holder: string }[] {
        return this.waitFor.snapshot();
    }

    private acquireWithWait(resource: IsolationResource, mode: IsolationLockMode, ttlMilliseconds: number, waitMilliseconds: number, sleep: (milliseconds: number) => void): IsolationHandle {
        const deadline = this.clock() + waitMilliseconds;
        for (let attempt = 0; attempt < 1_000; attempt += 1) {
            this.prune(this.clock());
            const holder = this.findConflict(resource, mode);
            if (holder === undefined) {
                this.waitFor.clear(resource.agentId);
                return this.createHandle(resource, mode, ttlMilliseconds);
            }
            if (this.waitFor.wouldDeadlock(resource.agentId, holder.resource.agentId)) {
                this.waitFor.clear(resource.agentId);
                throw new IsolationDeadlockError(resource, `wait-for cycle detected at ${resource.resourceId}`, holder);
            }
            this.waitFor.add(resource.agentId, holder.resource.agentId);
            const remaining = deadline - this.clock();
            if (remaining <= 0) {
                this.waitFor.clear(resource.agentId);
                throw new IsolationConflictError(resource, `timed out waiting for ${resource.resourceId}`, holder);
            }
            sleep(Math.max(1, Math.min(50, remaining)));
        }
        this.waitFor.clear(resource.agentId);
        throw new IsolationConflictError(resource, `could not acquire ${resource.resourceId} after waiting`);
    }

    private tryAcquire(resource: IsolationResource, mode: IsolationLockMode, ttlMilliseconds: number): IsolationHandle {
        this.prune(this.clock());
        const holder = this.findConflict(resource, mode);
        if (holder !== undefined) {
            throw new IsolationConflictError(resource, `resource ${resource.resourceId} is held by ${holder.resource.agentId} in ${holder.mode} mode`, holder);
        }
        return this.createHandle(resource, mode, ttlMilliseconds);
    }

    private createHandle(resource: IsolationResource, mode: IsolationLockMode, ttlMilliseconds: number): IsolationHandle {
        const now = this.clock();
        this.sequence += 1;
        const handle: IsolationHandle = Object.freeze({
            handleId: `isolation:${resource.cooperationId}:${resource.resourceId}:${this.sequence}`,
            resource: Object.freeze({
                ...resource,
                ...(resource.region === undefined ? {} : { region: Object.freeze({ ...resource.region }) }),
            }),
            mode,
            token: `isolation-token:${this.sequence}`,
            acquiredAt: new Date(now).toISOString(),
            expiresAt: new Date(now + ttlMilliseconds).toISOString(),
        });
        this.leases.set(handle.handleId, { handle, expiresAtEpoch: now + ttlMilliseconds });
        return handle;
    }

    private prune(now: number): void {
        for (const [handleId, lease] of this.leases) {
            if (lease.expiresAtEpoch <= now) this.leases.delete(handleId);
        }
    }

    private findConflict(resource: IsolationResource, mode: IsolationLockMode): IsolationHandle | undefined {
        for (const lease of this.leases.values()) {
            if (isolationLeasesConflict(lease.handle, resource, mode)) return lease.handle;
        }
        return undefined;
    }

}

/** The minimal `NodeFileLock`/`LockHandle` shape the file adapter needs. */
export interface FileLockRecordPort {
    readonly target: string;
    readonly owner: string;
    readonly fence: number;
    readonly token: string;
    readonly expiresAt: string;
}

export interface FileLockHandlePort {
    readonly record: FileLockRecordPort;
    refresh(ttlMilliseconds?: number): FileLockRecordPort;
    release(): boolean;
}

export interface FileLockPort {
    acquire(target: string, owner: string, ttlMilliseconds?: number): FileLockHandlePort;
}

/**
 * Filesystem-safe segment; `c-`/`r-` prefixes keep `..` and reserved device
 * names (`CON`, `NUL`, …) from becoming a path traversal or illegal Windows name.
 */
export const fileSegment = (value: string): string => encodeURIComponent(value).replaceAll("*", "%2A");

/** Stable target for a resource; shared and exclusive leases share one target, so they exclude each other. */
export const fileLockTargetOf = (resource: IsolationResource): string => {
    const scope = resource.lockScope ?? "file";
    const region = resource.region === undefined ? "" : `#${resource.region.start}-${resource.region.end}`;
    return `cooperation/c-${fileSegment(resource.cooperationId)}/${scope}/r-${fileSegment(resource.resourceId)}${region}`;
};

export type FileLockIsolationAdapterOptions = {
    /** Optional prefix (for example a temp/state directory) applied to lock targets. */
    readonly root?: string;
    /** Epoch milliseconds used by merge receipts and wait timeouts. */
    readonly clock?: () => number;
    readonly syntaxValidator?: IsolationSyntaxValidator;
};

/**
 * File-lock-backed adapter. The host injects a `NodeFileLock`-compatible port, so
 * this module never imports `node:fs`; without a port every acquire fails explicitly.
 *
 * The lock record is exclusive, so shared/region modes are serialized on one target.
 * `DirectoryIsolationAdapter` implements real cross-process shared/region locks.
 */
export class FileLockIsolationAdapter implements CooperationIsolationAdapter {
    private readonly locks: FileLockPort | undefined;
    private readonly handles = new Map<Identifier, FileLockHandlePort>();
    private readonly root: string;
    private readonly clock: () => number;
    private readonly syntaxValidator?: IsolationSyntaxValidator;

    constructor(locks?: FileLockPort, options: FileLockIsolationAdapterOptions = {}) {
        this.locks = locks;
        this.root = options.root === undefined || options.root === "" ? "" : options.root.replace(/[\\/]+$/, "");
        this.clock = options.clock ?? (() => Date.now());
        this.syntaxValidator = options.syntaxValidator;
    }

    acquire(resource: IsolationResource, mode: IsolationLockMode, ttlMilliseconds: number, options: IsolationAcquireOptions = {}): IsolationHandle {
        validateIsolationResource(resource, mode);
        positiveInteger(ttlMilliseconds, "Isolation TTL");
        const waitMilliseconds = options.waitMilliseconds ?? 0;
        if (waitMilliseconds < 0 || !Number.isFinite(waitMilliseconds)) fail("Isolation waitMilliseconds must be a finite number >= 0");
        const deadline = this.clock() + waitMilliseconds;
        const sleep = options.sleep ?? defaultIsolationSleep;
        for (let attempt = 0; attempt < 10_000; attempt += 1) {
            try {
                return this.acquireOnce(resource, mode, ttlMilliseconds);
            } catch (error) {
                if (!(error instanceof IsolationConflictError) || waitMilliseconds <= 0) throw error;
                const remaining = deadline - this.clock();
                if (remaining <= 0) throw error;
                sleep(Math.max(1, Math.min(50, remaining)));
            }
        }
        throw new IsolationConflictError(resource, `could not acquire ${resource.resourceId} after waiting`);
    }

    release(handle: IsolationHandle): boolean {
        if (handle === null || typeof handle !== "object") return false;
        const portHandle = this.handles.get(handle.handleId);
        if (portHandle === undefined || portHandle.record.token !== handle.token) return false;
        this.handles.delete(handle.handleId);
        return portHandle.release();
    }

    merge(changes: readonly IsolationChange[]): IsolationMergeResult {
        return mergeIsolationChanges(changes, { clock: this.clock, ...(this.syntaxValidator === undefined ? {} : { syntaxValidator: this.syntaxValidator }) });
    }

    /** Diagnostics/tests: number of leases this adapter still tracks. */
    activeHandleCount(): number {
        return this.handles.size;
    }

    private acquireOnce(resource: IsolationResource, mode: IsolationLockMode, ttlMilliseconds: number): IsolationHandle {
        const locks = this.locks;
        if (locks === undefined) throw new TypeError("FileLockIsolationAdapter requires a file lock port");
        const relative = fileLockTargetOf(resource);
        const target = this.root === "" ? relative : `${this.root}/${relative}`;
        let portHandle: FileLockHandlePort;
        try {
            portHandle = locks.acquire(target, resource.agentId, ttlMilliseconds);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new IsolationConflictError(resource, `file lock ${target} was rejected: ${detail}`, undefined, error);
        }
        if (portHandle === null || typeof portHandle !== "object") throw new TypeError("File lock port returned no handle");
        const record = portHandle.record;
        if (record === null || typeof record !== "object" || typeof record.token !== "string" || record.token.length === 0
            || typeof record.fence !== "number" || !Number.isSafeInteger(record.fence) || record.fence < 1
            || typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt))) {
            throw new TypeError("File lock port returned an invalid lock record");
        }
        const expiresAtEpoch = Date.parse(record.expiresAt);
        const handle: IsolationHandle = Object.freeze({
            handleId: `file-lock:${record.target}:${record.token}`,
            resource: Object.freeze({
                ...resource,
                ...(resource.region === undefined ? {} : { region: Object.freeze({ ...resource.region }) }),
            }),
            mode,
            token: record.token,
            fence: record.fence,
            acquiredAt: new Date(expiresAtEpoch - ttlMilliseconds).toISOString(),
            expiresAt: record.expiresAt,
        });
        this.handles.set(handle.handleId, portHandle);
        return handle;
    }
}
