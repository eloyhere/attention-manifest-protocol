/**
 * Shared contracts for the serialization helpers.
 *
 * Everything exported at runtime from `src/serialization` is frozen and pure:
 * the functions read their arguments, keep no module-level mutable state and
 * never mutate the value they are given. `safeStringify`/`digestOf` always
 * return a string or throw `SerializationError`; no partial result escapes.
 */

/** Options accepted by `safeStringify`. */
export interface SafeStringifyOptions {
    /**
     * Serialize object keys in a fixed byte-order so structurally equal values
     * produce identical text regardless of property insertion order. Use this
     * for cache keys, signatures and digests; leave it off when the caller
     * depends on the historical `JSON.stringify` property order.
     *
     * The exact ordering rule is documented in `json.ts`.
     */
    readonly stableKeys?: boolean;
    /**
     * Explicit opt-in to the library's shared-reference filter.
     *
     * `false` (the default) preserves the library's current behavior: one
     * shared `WeakSet` walks the value, so a repeated object is dropped at its
     * second occurrence. `true` records that the caller *relies* on that
     * filtering guarantee — persistence uses it because a stored payload must
     * be acyclic and de-duplicated, not because the encoding differs. Both
     * modes are defined by the same library walk and therefore produce the
     * same text today; see `json.ts` for the full semantics.
     */
    readonly filterShared?: boolean;
}

/** Frozen function shape of `safeStringify`. */
export interface SafeStringify {
    (value: unknown, options?: SafeStringifyOptions): string;
}

/** Frozen function shape of `safeParse`. */
export interface SafeParse {
    <T = unknown>(text: string): T;
}

/** Frozen function shape of `digestOf`. */
export interface DigestOf {
    (value: unknown): string;
}

/** Path of a visited leaf, as reported by `useTraverse`. */
export type TraversePath = readonly PropertyKey[];

/**
 * Visitor invoked once per leaf value that `useTraverse` reaches. Returning
 * `false` stops the traversal early. Object values are never visited: the
 * library recurses into them and reports their primitive leaves. Note the
 * library's array rule: a root array (or an array nested inside another array)
 * is walked through its own keys, so its `length` is reported as a leaf.
 */
export type TraverseVisitor = (value: unknown, path: TraversePath) => boolean | void;

/** Statistics returned by `traverseSafely`. */
export interface TraverseStats {
    /** Number of leaf values handed to the visitor. */
    readonly visited: number;
    /**
     * Number of object references the traversal skipped because they were
     * already seen. With a filter-based serializer this includes both cycles
     * and plain shared references; `useTraverse` uses one shared `WeakSet`.
     */
    readonly skipped: number;
    /** True when the visitor returned `false` and the traversal stopped early. */
    readonly stopped: boolean;
}
