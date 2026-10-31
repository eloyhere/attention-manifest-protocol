/**
 * Hook layer contracts for the agent workspace.
 *
 * A hook is the composition layer between a host/UI and one bound filesystem
 * session. It owns three things that a raw service call does not:
 *
 * - a small observable state machine (`idle`/`loading`/`ready`/`error`) so a
 *   caller can render progress without inventing its own flags;
 * - a run journal (`HookRunEntry`) that is persisted through an injected
 *   `HookRecorder`, which is how the SQLite `hook_runs` table is fed;
 * - an optional bounded cache keyed by the canonical request, so a read whose
 *   request is unchanged can avoid repeating the work.
 *
 * The layer is deliberately read-heavy: every hook except `useWrite` delegates
 * to a read-only session method. `useWrite` is the single mutating hook and it
 * forwards one `WriteRequest` to `FilesystemSession.write`; it never writes on
 * its own and it disables the cache, because replaying a mutation from cache
 * would make "write once" indistinguishable from "do nothing".
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { isFilesystemError } from "../file/errors.ts";
import type { FilesystemSession } from "../file/service.ts";
import type { FilesystemToolErrorCode } from "../protocol/filesystem.ts";
import { canonical, digestOf } from "../semantic/canonical.ts";
import { isSessionError } from "../session/errors.ts";
import { LRUOrderedMap } from "../structure/lru.ts";

/**
 * Lifecycle of one hook. `ready` and `error` are both terminal for a single
 * `run`; a later `run` starts again from `loading`.
 */
export type HookStatus = "idle" | "loading" | "ready" | "error";

/**
 * Error surface of a hook. Domain failures keep their filesystem/session code;
 * a malformed hook request is reported as `invalid_arguments`.
 */
export type HookErrorCode = FilesystemToolErrorCode | "invalid_arguments";

/**
 * Observable hook state. `revision` is the workspace revision the value (or
 * failure) was observed at; an `idle` state keeps the revision of the previous
 * run so a caller does not lose the coordinate when resetting a view.
 *
 * @typeParam T - Value produced by a successful run.
 */
export interface HookState<T> {
    readonly status: HookStatus;
    readonly value?: T;
    readonly error?: HookErrorCode;
    readonly revision: string;
}

/**
 * One audit row for a hook run. Digests are `sha256:` values of the canonical
 * request and (on success) the canonical output; `startedAt` is an ISO
 * timestamp and `durationMs` is wall-clock milliseconds.
 */
export interface HookRunEntry {
    readonly hook: string;
    readonly sessionId: string;
    readonly path?: string;
    readonly status: HookStatus;
    readonly error?: HookErrorCode;
    readonly revision: string;
    readonly startedAt: string;
    readonly durationMs: number;
    readonly inputDigest: string;
    readonly outputDigest: string;
}

/**
 * Persistence port for run entries. A recorder is fire-and-forget from the
 * hook's point of view: the hook catches recorder failures so an audit sink
 * outage cannot turn a successful read into a failed one.
 */
export interface HookRecorder {
    record(entry: HookRunEntry): void;
}

/**
 * Per-hook options. `cache` is opt-in because a request-only cache key cannot
 * know that a file changed on disk; hosts that enable it accept that trade-off.
 * `maxCacheEntries` is clamped to a positive bound instead of being trusted.
 */
export interface HookOptions {
    readonly recorder?: HookRecorder;
    readonly cache?: boolean;
    readonly maxCacheEntries?: number;
}

/**
 * The slice of `FilesystemSession` a hook needs. Kept as a structural `Pick`
 * instead of importing the concrete class so a test double with the same typed
 * methods works, and so the dependency direction stays `hook -> filesystem`.
 */
export type HookSession = Pick<
    FilesystemSession,
    "sessionId" | "descriptor" | "read" | "write" | "outline" | "imports" | "exports" | "dependency" | "ast" | "revision"
>;

/**
 * One observable hook. `run` returns the state it produced, which lets a caller
 * use the direct return value without waiting for the subscription callback.
 *
 * @typeParam TRequest - Request accepted by `run`.
 * @typeParam TResult - Value produced by a successful run.
 */
export interface Hook<TRequest, TResult> {
    readonly state: HookState<TResult>;
    run(request: TRequest): Promise<HookState<TResult>>;
    subscribe(listener: (state: HookState<TResult>) => void): () => void;
    reset(): void;
}

/**
 * Definition consumed by {@link createHook}. `pathOf` supplies the optional
 * path recorded in the run entry; `revisionOf` overrides the default revision
 * read (`session.revision()`), which is what a write needs because its result
 * already carries the post-write revision.
 *
 * @typeParam TRequest - Request accepted by `run`.
 * @typeParam TResult - Value produced by a successful run.
 */
export interface HookDefinition<TRequest, TResult> {
    readonly name: string;
    readonly session: HookSession;
    readonly execute: (request: TRequest) => TResult | Promise<TResult>;
    readonly pathOf?: (request: TRequest) => string | undefined;
    readonly revisionOf?: (result: TResult) => string;
    readonly options?: HookOptions;
}

/**
 * Cached value plus the revision it was produced at. Caching the revision is
 * what makes a cache hit report the same coordinate as the original run.
 */
interface CachedHookResult<TResult> {
    readonly value: TResult;
    readonly revision: string;
}

/**
 * Default cache capacity and its hard ceiling. A hook result can be a whole
 * outline, so the default is intentionally small.
 */
const DefaultCacheEntries: number = 32;
const MaxCacheEntries: number = 256;

/**
 * Convert an arbitrary request/output into a value `digestOf` can canonicalise.
 *
 * `canonical` rejects `bigint`, `Uint8Array` and `undefined`, all of which
 * occur in filesystem results and write requests. The conversion is for audit
 * only: it must be deterministic, not reversible.
 */
const digestable: (value: unknown) => unknown = (value: unknown): unknown => {
    if (value === null) {
        return null;
    }
    const kind: string = typeof(value);
    if (kind === "string" || kind === "number" || kind === "boolean") {
        return value;
    }
    if (kind === "bigint") {
        return `${value}`;
    }
    if (value === (void 0)) {
        return null;
    }
    if (value instanceof Uint8Array) {
        return { encoding: "base64", bytes: Buffer.from(value).toString("base64") };
    }
    if (Array.isArray(value)) {
        return value.map((entry: unknown): unknown => digestable(entry));
    }
    if (kind === "object") {
        const source: Record<string, unknown> = value as Record<string, unknown>;
        const target: Record<string, unknown> = {};
        const keys: string[] = Object.keys(source);
        for (let index: number = 0; index < keys.length; index += 1) {
            const key: string = keys[index];
            const entry: unknown = source[key];
            if (entry === (void 0)) {
                continue;
            }
            target[key] = digestable(entry);
        }
        return target;
    }
    return "<unsupported>";
};

/**
 * Digest of an arbitrary value, falling back to a constant when a caller passes
 * something canonical JSON cannot express. The fallback keeps the run entry
 * well-formed instead of failing the operation it is supposed to audit.
 */
const safeDigest: (value: unknown) => string = (value: unknown): string => {
    try {
        return digestOf(digestable(value));
    } catch {
        return digestOf({ digest: "unavailable" });
    }
};

/**
 * SHA-256 of the canonical request, used as the cache key. An uncanonicalisable
 * request yields an empty key, which the runtime treats as "do not cache".
 */
const cacheKeyOf: (request: unknown) => string = (request: unknown): string => {
    try {
        const text: string = canonical(digestable(request));
        return createHash("sha256").update(text, "utf8").digest("hex");
    } catch {
        return "";
    }
};

/**
 * Translate an unknown thrown value into the closed hook error surface.
 */
const mapHookError: (error: unknown) => HookErrorCode = (error: unknown): HookErrorCode => {
    if (isFilesystemError(error)) {
        return error.code;
    }
    if (isSessionError(error)) {
        if (error.code === "invalid_arguments") {
            return "invalid_arguments";
        }
        if (error.code === "invalid_identity" || error.code === "session_forbidden") {
            return "permission_denied";
        }
        return "session_unavailable";
    }
    if (error instanceof TypeError || error instanceof RangeError) {
        return "invalid_arguments";
    }
    return "internal_error";
};

/**
 * Clamp `maxCacheEntries` into a positive bound.
 */
const cacheCapacity: (value: number | undefined) => number = (value: number | undefined): number => {
    if (value === (void 0) || !Number.isSafeInteger(value) || value < 1) {
        return DefaultCacheEntries;
    }
    return Math.min(value, MaxCacheEntries);
};

/**
 * Concrete hook runtime. Kept private so the public surface is the `Hook`
 * interface and the `createHook` factory.
 *
 * @typeParam TRequest - Request accepted by `run`.
 * @typeParam TResult - Value produced by a successful run.
 */
class HookRuntime<TRequest, TResult> implements Hook<TRequest, TResult> {
    private readonly definition: HookDefinition<TRequest, TResult>;
    private readonly recorder: HookRecorder | undefined;
    private readonly cache: LRUOrderedMap<string, CachedHookResult<TResult>> | undefined;
    private readonly listeners: Set<(state: HookState<TResult>) => void> = new Set<(state: HookState<TResult>) => void>();
    private current: HookState<TResult>;
    private generation: number = 0;

    /**
     * Create one runtime from a definition.
     *
     * @param definition - Name, session, executor and options.
     */
    constructor(definition: HookDefinition<TRequest, TResult>) {
        const options: HookOptions = definition.options ?? {};
        this.definition = definition;
        this.recorder = options.recorder;
        this.cache =
            options.cache === true
                ? new LRUOrderedMap<string, CachedHookResult<TResult>>(cacheCapacity(options.maxCacheEntries))
                : (void 0);
        this.current = Object.freeze<HookState<TResult>>({ status: "idle", revision: "" });
    }

    /**
     * Current observable state.
     */
    get state(): HookState<TResult> {
        return this.current;
    }

    /**
     * Run one request. The state moves to `loading` synchronously and the
     * executor starts on the next microtask, so a caller that renders after
     * calling `run` can observe the loading state even for a synchronous
     * service method.
     *
     * A newer run (or a `reset`) increments the generation; an older run that
     * finishes later still records and returns its own state but does not
     * overwrite the newer observable state.
     *
     * @param request - Hook request.
     * @returns The state produced by this run.
     */
    async run(request: TRequest): Promise<HookState<TResult>> {
        const started: Date = new Date();
        const generation: number = this.generation + 1;
        this.generation = generation;
        this.update({ status: "loading", revision: this.current.revision });
        const inputDigest: string = safeDigest(request);
        const path: string | undefined = this.pathOf(request);
        const cacheKey: string = this.cache === (void 0) ? "" : cacheKeyOf(request);
        const cached: CachedHookResult<TResult> | undefined = this.cachedFor(cacheKey);
        await Promise.resolve();
        if (cached !== (void 0)) {
            const next: HookState<TResult> = { status: "ready", value: cached.value, revision: cached.revision };
            if (generation === this.generation) {
                this.update(next);
            }
            this.emit({
                hook: this.definition.name,
                sessionId: this.definition.session.sessionId,
                ...(path === (void 0) ? {} : { path }),
                status: "ready",
                revision: next.revision,
                startedAt: started.toISOString(),
                durationMs: Date.now() - started.getTime(),
                inputDigest,
                outputDigest: safeDigest(cached.value),
            });
            return next;
        }
        try {
            const value: TResult = await this.definition.execute(request);
            const revision: string = this.revisionFor(value);
            const next: HookState<TResult> = { status: "ready", value, revision };
            if (generation === this.generation) {
                if (this.cache !== (void 0) && cacheKey.length > 0) {
                    this.cache.set(cacheKey, { value, revision });
                }
                this.update(next);
            }
            this.emit({
                hook: this.definition.name,
                sessionId: this.definition.session.sessionId,
                ...(path === (void 0) ? {} : { path }),
                status: "ready",
                revision,
                startedAt: started.toISOString(),
                durationMs: Date.now() - started.getTime(),
                inputDigest,
                outputDigest: safeDigest(value),
            });
            return next;
        } catch (error: unknown) {
            const code: HookErrorCode = mapHookError(error);
            const revision: string = this.currentRevision();
            const next: HookState<TResult> = { status: "error", error: code, revision };
            if (generation === this.generation) {
                this.update(next);
            }
            this.emit({
                hook: this.definition.name,
                sessionId: this.definition.session.sessionId,
                ...(path === (void 0) ? {} : { path }),
                status: "error",
                error: code,
                revision,
                startedAt: started.toISOString(),
                durationMs: Date.now() - started.getTime(),
                inputDigest,
                outputDigest: "",
            });
            return next;
        }
    }

    /**
     * Subscribe to state changes. The listener is not invoked immediately; it
     * receives every subsequent `loading`, `ready`, `error` and reset state.
     *
     * @param listener - Callback invoked with each new state.
     * @returns Unsubscribe function.
     */
    subscribe(listener: (state: HookState<TResult>) => void): () => void {
        this.listeners.add(listener);
        return (): void => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Return to `idle` and drop cached values. The last revision is retained so
     * a view that resets does not lose its workspace coordinate. In-flight runs
     * are invalidated so they cannot overwrite the idle state.
     */
    reset(): void {
        this.generation += 1;
        if (this.cache !== (void 0)) {
            this.cache.clear();
        }
        this.update({ status: "idle", revision: this.current.revision });
    }

    /**
     * Read a cached result only when it was produced at the current workspace
     * revision. The request-only cache key cannot see a file change by itself,
     * so the revision is the freshness check that makes `cache: true` safe for
     * read hooks.
     *
     * @param cacheKey - Canonical request key.
     * @returns Cached result, or `undefined` when absent or stale.
     */
    private cachedFor(cacheKey: string): CachedHookResult<TResult> | undefined {
        if (this.cache === (void 0) || cacheKey.length === 0) {
            return (void 0);
        }
        const entry: CachedHookResult<TResult> | undefined = this.cache.peek(cacheKey);
        if (entry === (void 0)) {
            return (void 0);
        }
        const revision: string | undefined = this.sessionRevision();
        if (revision === (void 0) || revision.length === 0 || entry.revision !== revision) {
            this.cache.delete(cacheKey);
            return (void 0);
        }
        return this.cache.get(cacheKey);
    }

    /**
     * Revision reported by the bound session, or `undefined` when the session
     * cannot answer (revoked, expired, store failure). A cache hit is never
     * trusted without this value.
     *
     * @returns Current workspace revision, or `undefined`.
     */
    private sessionRevision(): string | undefined {
        try {
            return this.definition.session.revision();
        } catch {
            return (void 0);
        }
    }

    /**
     * Last known revision from the bound session, falling back to the state.
     */
    private currentRevision(): string {
        const revision: string | undefined = this.sessionRevision();
        return revision === (void 0) || revision.length === 0 ? this.current.revision : revision;
    }

    /**
     * Revision reported for a successful value.
     *
     * @param value - Successful hook output.
     * @returns Result revision or the session revision.
     */
    private revisionFor(value: TResult): string {
        const revisionOf: ((result: TResult) => string) | undefined = this.definition.revisionOf;
        if (revisionOf === (void 0)) {
            return this.currentRevision();
        }
        try {
            return revisionOf(value);
        } catch {
            return this.currentRevision();
        }
    }

    /**
     * Optional request path for the run journal.
     *
     * @param request - Hook request.
     * @returns Path, or `undefined` when the request has none.
     */
    private pathOf(request: TRequest): string | undefined {
        const pathOf: ((request: TRequest) => string | undefined) | undefined = this.definition.pathOf;
        if (pathOf === (void 0)) {
            return (void 0);
        }
        try {
            return pathOf(request);
        } catch {
            return (void 0);
        }
    }

    /**
     * Publish one state to every subscriber. A listener that throws is skipped
     * so one broken view cannot stop the others from updating.
     *
     * @param next - New state.
     */
    private update(next: HookState<TResult>): void {
        const frozen: HookState<TResult> = Object.freeze(next);
        this.current = frozen;
        const listeners: Array<(state: HookState<TResult>) => void> = [...this.listeners];
        for (let index: number = 0; index < listeners.length; index += 1) {
            try {
                listeners[index](frozen);
            } catch {
                continue;
            }
        }
    }

    /**
     * Forward one entry to the recorder; an audit failure is swallowed by
     * contract and never changes the hook result.
     *
     * @param entry - Run entry.
     */
    private emit(entry: HookRunEntry): void {
        const recorder: HookRecorder | undefined = this.recorder;
        if (recorder === (void 0)) {
            return;
        }
        try {
            recorder.record(entry);
        } catch {
            return;
        }
    }
}

/**
 * Factory shape of {@link createHook}.
 *
 * @typeParam TRequest - Request accepted by `run`.
 * @typeParam TResult - Value produced by a successful run.
 */
export type HookFactory = <TRequest, TResult>(definition: HookDefinition<TRequest, TResult>) => Hook<TRequest, TResult>;

/**
 * Create one observable hook from a definition. This is the shared factory the
 * concrete `use*` hooks are built on.
 *
 * @typeParam TRequest - Request accepted by `run`.
 * @typeParam TResult - Value produced by a successful run.
 * @param definition - Name, session, executor, optional revision/path mapping
 * and options.
 * @returns A hook with state, subscription, reset and bounded caching.
 */
export const createHook: HookFactory = <TRequest, TResult>(definition: HookDefinition<TRequest, TResult>): Hook<TRequest, TResult> =>
    new HookRuntime<TRequest, TResult>(definition);
