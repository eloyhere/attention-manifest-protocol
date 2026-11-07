import type { AttentionObject, AttentionScope } from "../attention/types.ts";
import type { Budget } from "../shared.ts";
import { safeStringify } from "../serialization/index.ts";
import { compileContext } from "./compiler.ts";
import type { ContextCache } from "./lifecycle.ts";
import type { CompileContextOptions, CompiledContext } from "./types.ts";

/** Recursively freeze compiled contexts so a cache hit cannot be mutated by its caller. */
function freezeDeep<T>(value: T, seen = new Set<object>()): T {
    if (value === null || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) freezeDeep(child, seen);
    Object.freeze(value);
    return value;
}

export type CachedObjectIdentity = Readonly<{
    id: string;
    version: number;
    sourceVersion: string;
    mounted: boolean;
    stale: boolean;
}>;

/**
 * Cache identity for one compilation. Scope, budget, compile time and every
 * object's identity/version/source-version/residency must all match: a version
 * or staleness change must invalidate the cached payload rather than reuse it.
 */
export function signature(
    scope: AttentionScope,
    budget: Budget,
    now: string,
    objects: readonly CachedObjectIdentity[],
): string {
    // Encode every component as a JSON value rather than joining with a
    // delimiter: IDs and versions are caller-controlled strings and may contain
    // any delimiter. Fixed-position tuples keep the identity deterministic while
    // preserving the exact scope/budget/object fields that affect compilation.
    // Keys are serialized in a fixed order so the signature is identical for
    // structurally equal input, independent of construction order.
    return safeStringify({
        scope: [
            scope.tenantId,
            scope.principalId,
            scope.sessionId,
            scope.turnId,
            scope.workspaceId ?? null,
            scope.projectId ?? null,
        ],
        budget: [
            budget.tokens ?? null,
            budget.milliseconds ?? null,
            budget.calls ?? null,
            budget.bytes ?? null,
        ],
        now,
        objects: objects.map(object => [
            object.id,
            object.version,
            object.sourceVersion,
            object.mounted,
            object.stale,
        ]),
    }, { stableKeys: true });
}

export function cachedContextSignature(objects: readonly AttentionObject[], options: CompileContextOptions): string {
    return signature(options.scope, options.budget, options.now, objects.map(object => ({
        id: object.id,
        version: object.version,
        sourceVersion: object.pointer.version,
        mounted: object.mounted,
        stale: object.stale,
    })));
}

/**
 * Compiles through the cache. A miss compiles and stores a deep-frozen value; a
 * hit returns the frozen cached value and lets `ContextCache` record the saved
 * tokens. The separate `now` is the cache clock (TTL/recency), not part of the
 * compilation signature.
 */
export function compileContextCached(
    cache: ContextCache,
    objects: readonly AttentionObject[],
    options: CompileContextOptions,
    now: string,
): { context: CompiledContext; hit: boolean } {
    const signature = cachedContextSignature(objects, options);
    const cached = cache.get(signature, now);
    if (cached.hit) return { context: freezeDeep(cached.entry.context), hit: true };
    const context = freezeDeep(compileContext(objects, options));
    cache.put(signature, context, now);
    return { context, hit: false };
}
