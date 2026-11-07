import {
    DEFAULT_ISOLATION_TTL_MILLISECONDS,
    IsolationConflictError,
    IsolationDeadlockError,
    IsolationWaitForGraph,
    defaultIsolationSleep,
    fileSegment,
    isolationLeasesConflict,
    mergeIsolationChanges,
    validateIsolationResource,
} from "./isolation.ts";
import { DEFAULT_NODE_ISOLATION_ROOT, createNodeIsolationDirectory } from "./nodeDirectory.ts";
import type {
    CooperationIsolationAdapter,
    IsolationAcquireOptions,
    IsolationChange,
    IsolationHandle,
    IsolationLockMode,
    IsolationMergeResult,
    IsolationResource,
    IsolationSyntaxValidator,
} from "./types.ts";

/**
 * Low-level directory port used by `DirectoryIsolationAdapter`. Implementations
 * only need atomic exclusive file creation plus directory listing; the adapter
 * builds shared/region lock semantics on top.
 */
export interface IsolationDirectoryPort {
    /** Atomically creates `path`; returns false when it already exists. Creates parents. */
    writeExclusive(path: string, content: string): boolean;
    read(path: string): string | undefined;
    remove(path: string): boolean;
    /** File names (not paths) directly inside `directory`; an absent directory is empty. */
    list(directory: string): readonly string[];
}

/** Host-neutral directory port used by tests and by hosts without Node fs. */
export class InMemoryIsolationDirectory implements IsolationDirectoryPort {
    private readonly files = new Map<string, string>();

    writeExclusive(path: string, content: string): boolean {
        if (this.files.has(path)) return false;
        this.files.set(path, content);
        return true;
    }

    read(path: string): string | undefined {
        return this.files.get(path);
    }

    remove(path: string): boolean {
        return this.files.delete(path);
    }

    list(directory: string): readonly string[] {
        const prefix = directory.endsWith("/") ? directory : `${directory}/`;
        const names: string[] = [];
        for (const path of this.files.keys()) {
            if (!path.startsWith(prefix)) continue;
            const remainder = path.slice(prefix.length);
            if (remainder.length > 0 && !remainder.includes("/")) names.push(remainder);
        }
        return names;
    }

    /** Diagnostics/tests. */
    size(): number {
        return this.files.size;
    }
}

export type DirectoryIsolationAdapterOptions = {
    /** Root directory used by the default Node port and as the key prefix of injected ports. */
    readonly root?: string;
    readonly clock?: () => number;
    readonly sleep?: (milliseconds: number) => void;
    readonly syntaxValidator?: IsolationSyntaxValidator;
    readonly guardTtlMilliseconds?: number;
    readonly guardRetryDelayMilliseconds?: number;
    readonly guardMaxAttempts?: number;
    /** Injectable token source; defaults to `crypto.randomUUID()` with a time/random fallback. */
    readonly randomId?: () => string;
};

type GuardRecord = { readonly token: string; readonly expiresAt: string };

const fail = (message: string): never => {
    throw new TypeError(message);
};
const randomId = (): string => {
    const cryptoObject = globalThis.crypto;
    if (cryptoObject !== undefined && typeof cryptoObject.randomUUID === "function") return cryptoObject.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const parseGuard = (raw: string | undefined): GuardRecord | undefined => {
    if (raw === undefined) return undefined;
    try {
        const value = JSON.parse(raw) as Partial<GuardRecord> | null;
        if (value === null || typeof value !== "object" || typeof value.token !== "string" || typeof value.expiresAt !== "string") return undefined;
        if (!Number.isFinite(Date.parse(value.expiresAt))) return undefined;
        return { token: value.token, expiresAt: value.expiresAt };
    } catch {
        return undefined;
    }
};

const parseHandle = (raw: string | undefined): IsolationHandle | undefined => {
    if (raw === undefined) return undefined;
    try {
        const value = JSON.parse(raw) as Partial<IsolationHandle> | null;
        if (value === null || typeof value !== "object") return undefined;
        const resource = value.resource as Partial<IsolationResource> | undefined;
        if (resource === null || typeof resource !== "object") return undefined;
        if (typeof value.handleId !== "string" || value.handleId.length === 0) return undefined;
        if (typeof value.token !== "string" || value.token.length === 0) return undefined;
        if (typeof value.mode !== "string" || !["exclusive", "shared", "region"].includes(value.mode)) return undefined;
        if (typeof resource.cooperationId !== "string" || typeof resource.agentId !== "string" || typeof resource.resourceId !== "string") return undefined;
        if (typeof value.acquiredAt !== "string" || typeof value.expiresAt !== "string") return undefined;
        if (!Number.isFinite(Date.parse(value.expiresAt))) return undefined;
        if (resource.lockScope !== undefined && !["file", "region", "workspace"].includes(resource.lockScope)) return undefined;
        if (resource.region !== undefined) {
            if (!Number.isSafeInteger(resource.region.start) || !Number.isSafeInteger(resource.region.end)) return undefined;
            if ((resource.region.start as number) < 0 || (resource.region.end as number) < (resource.region.start as number)) return undefined;
        }
        return {
            handleId: value.handleId,
            resource: {
                cooperationId: resource.cooperationId,
                agentId: resource.agentId,
                resourceId: resource.resourceId,
                ...(resource.lockScope === undefined ? {} : { lockScope: resource.lockScope }),
                ...(resource.region === undefined ? {} : { region: { start: resource.region.start, end: resource.region.end } }),
            },
            mode: value.mode as IsolationLockMode,
            token: value.token,
            ...(typeof value.fence === "number" ? { fence: value.fence } : {}),
            acquiredAt: value.acquiredAt,
            expiresAt: value.expiresAt,
        };
    } catch {
        return undefined;
    }
};

/**
 * Filesystem-backed isolation adapter. All members are files under one directory per
 * resource: a short-lived `.guard` file serializes state transitions, and one JSON
 * record per held lease lets independent processes enumerate shared/region holders.
 * This gives real cross-process shared reads, exclusive writes and region overlap
 * detection, with TTL takeover of stale guards/leases.
 */
export class DirectoryIsolationAdapter implements CooperationIsolationAdapter {
    private readonly injectedPort: IsolationDirectoryPort | undefined;
    private lazyPort: IsolationDirectoryPort | undefined;
    private readonly root: string;
    private readonly clock: () => number;
    private readonly sleep: (milliseconds: number) => void;
    private readonly syntaxValidator?: IsolationSyntaxValidator;
    private readonly guardTtlMilliseconds: number;
    private readonly guardRetryDelayMilliseconds: number;
    private readonly guardMaxAttempts: number;
    private readonly tokenFactory: () => string;
    private readonly waitFor = new IsolationWaitForGraph();

    /**
     * `options.root` must match the namespace the injected port writes into; when no
     * port is supplied the adapter lazily creates a Node fs port rooted at `root`.
     */
    constructor(port?: IsolationDirectoryPort, options: DirectoryIsolationAdapterOptions = {}) {
        this.injectedPort = port;
        this.root = (options.root ?? DEFAULT_NODE_ISOLATION_ROOT).replace(/[\\/]+$/, "");
        this.clock = options.clock ?? (() => Date.now());
        this.sleep = options.sleep ?? defaultIsolationSleep;
        this.syntaxValidator = options.syntaxValidator;
        this.guardTtlMilliseconds = options.guardTtlMilliseconds ?? 5_000;
        if (!Number.isSafeInteger(this.guardTtlMilliseconds) || this.guardTtlMilliseconds <= 0) fail("guardTtlMilliseconds must be a positive safe integer");
        this.guardRetryDelayMilliseconds = options.guardRetryDelayMilliseconds ?? 5;
        if (!Number.isSafeInteger(this.guardRetryDelayMilliseconds) || this.guardRetryDelayMilliseconds < 0) fail("guardRetryDelayMilliseconds must be a nonnegative safe integer");
        this.guardMaxAttempts = options.guardMaxAttempts ?? 50;
        if (!Number.isSafeInteger(this.guardMaxAttempts) || this.guardMaxAttempts <= 0) fail("guardMaxAttempts must be a positive safe integer");
        this.tokenFactory = options.randomId ?? randomId;
    }

    acquire(resource: IsolationResource, mode: IsolationLockMode, ttlMilliseconds: number = DEFAULT_ISOLATION_TTL_MILLISECONDS, options: IsolationAcquireOptions = {}): IsolationHandle {
        validateIsolationResource(resource, mode);
        if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds <= 0) fail("Isolation TTL must be a positive safe integer");
        const waitMilliseconds = options.waitMilliseconds ?? 0;
        if (waitMilliseconds < 0 || !Number.isFinite(waitMilliseconds)) fail("Isolation waitMilliseconds must be a finite number >= 0");
        if (waitMilliseconds <= 0) {
            const handle = this.acquireOnce(resource, mode, ttlMilliseconds);
            return handle;
        }
        const sleep = options.sleep ?? this.sleep;
        const deadline = this.clock() + waitMilliseconds;
        for (let attempt = 0; attempt < 1_000; attempt += 1) {
            try {
                const handle = this.acquireOnce(resource, mode, ttlMilliseconds);
                this.waitFor.clear(resource.agentId);
                return handle;
            } catch (error) {
                if (!(error instanceof IsolationConflictError)) {
                    this.waitFor.clear(resource.agentId);
                    throw error;
                }
                const holderAgentId = error.holder?.resource.agentId;
                if (holderAgentId !== undefined) {
                    if (this.waitFor.wouldDeadlock(resource.agentId, holderAgentId)) {
                        this.waitFor.clear(resource.agentId);
                        throw new IsolationDeadlockError(resource, `wait-for cycle detected at ${resource.resourceId}`, error.holder);
                    }
                    this.waitFor.add(resource.agentId, holderAgentId);
                }
                const remaining = deadline - this.clock();
                if (remaining <= 0) {
                    this.waitFor.clear(resource.agentId);
                    throw error;
                }
                sleep(Math.max(1, Math.min(50, remaining)));
            }
        }
        this.waitFor.clear(resource.agentId);
        throw new IsolationConflictError(resource, `could not acquire ${resource.resourceId} after waiting`);
    }

    release(handle: IsolationHandle): boolean {
        if (handle === null || typeof handle !== "object") return false;
        const directory = this.directoryOf(handle.resource);
        return this.withGuard(directory, handle.resource.agentId, () => {
            const path = this.recordPath(directory, handle);
            const stored = parseHandle(this.port.read(path));
            if (stored === undefined || stored.token !== handle.token) return false;
            if (Date.parse(stored.expiresAt) <= this.clock()) {
                this.port.remove(path);
                return false;
            }
            return this.port.remove(path);
        });
    }

    merge(changes: readonly IsolationChange[]): IsolationMergeResult {
        return mergeIsolationChanges(changes, { clock: this.clock, ...(this.syntaxValidator === undefined ? {} : { syntaxValidator: this.syntaxValidator }) });
    }

    /** Diagnostics/tests: wait-for edges of this adapter instance. */
    waitForEdges(): readonly { readonly waiting: string; readonly holder: string }[] {
        return this.waitFor.snapshot();
    }

    /** Diagnostics/tests: live leases stored for one resource. */
    handlesFor(resource: IsolationResource): readonly IsolationHandle[] {
        return Object.freeze(this.loadHandles(this.directoryOf(resource)));
    }

    private acquireOnce(resource: IsolationResource, mode: IsolationLockMode, ttlMilliseconds: number): IsolationHandle {
        const directory = this.directoryOf(resource);
        return this.withGuard(directory, resource.agentId, () => {
            const handles = this.loadHandles(directory);
            for (const held of handles) {
                if (isolationLeasesConflict(held, resource, mode)) {
                    throw new IsolationConflictError(resource, `resource ${resource.resourceId} is held by ${held.resource.agentId} in ${held.mode} mode`, held);
                }
            }
            const now = this.clock();
            const token = `${resource.agentId}:${this.tokenFactory()}`;
            const handle: IsolationHandle = Object.freeze({
                handleId: `directory-isolation:${resource.cooperationId}:${resource.resourceId}:${token}`,
                resource: Object.freeze({
                    ...resource,
                    ...(resource.region === undefined ? {} : { region: Object.freeze({ ...resource.region }) }),
                }),
                mode,
                token,
                acquiredAt: new Date(now).toISOString(),
                expiresAt: new Date(now + ttlMilliseconds).toISOString(),
            });
            const path = this.recordPath(directory, handle);
            if (!this.port.writeExclusive(path, JSON.stringify(handle))) {
                throw new IsolationConflictError(resource, `record ${path} already exists`);
            }
            return handle;
        });
    }

    private loadHandles(directory: string): IsolationHandle[] {
        const now = this.clock();
        const handles: IsolationHandle[] = [];
        for (const name of this.port.list(directory)) {
            if (name === ".guard" || !name.endsWith(".json")) continue;
            const path = `${directory}/${name}`;
            const stored = parseHandle(this.port.read(path));
            if (stored === undefined) {
                this.port.remove(path);
                continue;
            }
            if (Date.parse(stored.expiresAt) <= now) {
                this.port.remove(path);
                continue;
            }
            handles.push(stored);
        }
        return handles;
    }

    private withGuard<T>(directory: string, owner: string, action: () => T): T {
        const guardPath = `${directory}/.guard`;
        const token = this.tokenFactory();
        const expiresAt = new Date(this.clock() + this.guardTtlMilliseconds).toISOString();
        let acquired = false;
        for (let attempt = 0; attempt < this.guardMaxAttempts && !acquired; attempt += 1) {
            if (this.port.writeExclusive(guardPath, JSON.stringify({ token, expiresAt }))) {
                acquired = true;
                break;
            }
            const current = parseGuard(this.port.read(guardPath));
            if (current === undefined || Date.parse(current.expiresAt) <= this.clock()) {
                this.port.remove(guardPath);
                continue;
            }
            if (attempt + 1 < this.guardMaxAttempts) this.sleep(this.guardRetryDelayMilliseconds);
        }
        if (!acquired) throw new IsolationConflictError({ cooperationId: owner, agentId: owner, resourceId: directory }, `guard ${guardPath} is contended`);
        try {
            return action();
        } finally {
            const current = parseGuard(this.port.read(guardPath));
            if (current !== undefined && current.token === token) this.port.remove(guardPath);
        }
    }

    private directoryOf(resource: IsolationResource): string {
        // Region is part of the lease, not of the directory key: every region holder
        // for one resource must be enumerated together to detect overlap.
        const scope = resource.lockScope ?? "file";
        return `${this.root}/cooperation/c-${fileSegment(resource.cooperationId)}/${scope}/r-${fileSegment(resource.resourceId)}`;
    }

    private recordPath(directory: string, handle: IsolationHandle): string {
        return `${directory}/${fileSegment(handle.handleId)}.json`;
    }

    private get port(): IsolationDirectoryPort {
        if (this.injectedPort !== undefined) return this.injectedPort;
        if (this.lazyPort === undefined) this.lazyPort = createNodeIsolationDirectory(this.root);
        return this.lazyPort;
    }
}
