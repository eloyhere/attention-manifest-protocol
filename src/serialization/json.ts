import { createHash } from "node:crypto";
import { SerializationError, isSerializationError, useStringify } from "semantic-typescript";
import type { DigestOf, SafeParse, SafeStringify, SafeStringifyOptions } from "./types.ts";

/**
 * Safe JSON serialization built on `semantic-typescript`'s `useStringify`.
 *
 * # Circular and shared references (`filterShared`)
 *
 * `useStringify` walks the value with one shared `WeakSet` and returns
 * `undefined` for every object it has already seen. `JSON.stringify` therefore
 * drops the back edge of a cycle and, like the library, also drops a repeated
 * (non-cyclic) reference instead of duplicating it. This module adopts that
 * library semantics unchanged: circular properties are filtered, never
 * replaced by a marker, and a shared object appears only at its first
 * occurrence. Values are never mutated.
 *
 * `safeStringify(value, { filterShared: true })` registers that lossy
 * filtering as an explicit caller contract. `false` (the default) preserves
 * whatever the pinned library does, which today is the same filtering; both
 * modes intentionally share the one library walk, so the explicit mode can
 * never silently diverge from the default. Persistence passes `true` because a
 * stored payload must be acyclic and de-duplicated by contract rather than by
 * an incidental library implementation detail.
 *
 * # Arrays and non-representable values
 *
 * Arrays keep index order. A hole (a missing index) stays a hole in the
 * cloned tree and `JSON.stringify` renders it as `null`; `undefined`,
 * functions and symbols are omitted from objects and become `null` inside
 * arrays. `BigInt` throws and is reported as `SerializationError`.
 *
 * # Stable key order (`stableKeys: true`)
 *
 * The library callback cannot reorder keys (it maps a key/value pair to a
 * string), so a key-sorted clone is built first and then handed to
 * `useStringify`. The fixed rule is:
 *
 * 1. Objects are ordinary JSON objects: only own enumerable string keys are
 *    copied, and they are sorted with `Array.prototype.sort()` — UTF-16 code
 *    unit order, not `localeCompare` — so the order does not depend on locale,
 *    host or insertion order. Symbols, non-enumerable keys and inherited
 *    properties are dropped, exactly like `JSON.stringify`.
 * 2. Arrays keep index order; holes stay holes (`JSON.stringify` renders a
 *    hole as `null`, which is preserved).
 * 3. Objects with a callable `toJSON` (e.g. `Date`) are not cloned. The JSON
 *    algorithm calls `toJSON` before the replacer, so its own result decides
 *    the order; `stableKeys` cannot and does not rewrite that contract.
 * 4. Values JSON cannot represent are handled the usual way: `undefined`,
 *    functions and symbols are omitted from objects and become `null` inside
 *    arrays. `BigInt` throws and is reported as `SerializationError`.
 * 5. Sharing identity is preserved by the clone memo, so the library's
 *    filter-one-occurrence rule is identical in stable and non-stable mode;
 *    only the first *encountered* occurrence differs when key order changes.
 *
 * Failure policy: any exception raised while serializing, plus a root value
 * that has no JSON text representation (`undefined`, function, symbol), is
 * rethrown as `SerializationError`; callers never receive a partial result.
 */

const NON_REPRESENTABLE_ROOTS = "undefined, function and symbol roots have no JSON text";

/** True when the JSON algorithm would delegate this object to `toJSON`. */
function hasToJSON(value: object): boolean {
    try {
        return typeof Reflect.get(value, "toJSON") === "function";
    } catch {
        // A throwing accessor must fail inside the serializer, where it is
        // wrapped as a SerializationError with the original cause attached.
        return false;
    }
}

/**
 * Clone a value into a key-sorted tree before `useStringify` sees it.
 * `memo` preserves reference identity so circular/shared-reference filtering
 * stays exactly the library's behaviour.
 */
function cloneWithStableKeys(value: unknown, memo: WeakMap<object, unknown>): unknown {
    if (value === null || typeof value !== "object") return value;
    const cached = memo.get(value);
    if (cached !== undefined) return cached;
    if (hasToJSON(value)) return value;
    if (Array.isArray(value)) {
        const array: unknown[] = new Array(value.length);
        memo.set(value, array);
        for (let index = 0; index < value.length; index += 1) {
            if (index in value) array[index] = cloneWithStableKeys(value[index], memo);
        }
        return array;
    }
    const clone: Record<string, unknown> = {};
    memo.set(value, clone);
    for (const key of Object.keys(value).sort()) clone[key] = cloneWithStableKeys(Reflect.get(value, key), memo);
    return clone;
}

function detailOf(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

function serializationError(message: string, cause: unknown): SerializationError {
    if (isSerializationError(cause)) return cause;
    return new SerializationError(`${message}: ${detailOf(cause)}`, { cause });
}

/**
 * Serialize `value` to JSON text without throwing a raw `TypeError` for cycles
 * (they never reach the native serializer) or for hostile values.
 */
export const safeStringify: SafeStringify = Object.freeze((value: unknown, options: SafeStringifyOptions = {}): string => {
    if (options === null || typeof options !== "object") throw new TypeError("safeStringify options must be an object");
    const stableKeys = options.stableKeys ?? false;
    if (typeof stableKeys !== "boolean") throw new TypeError("safeStringify options.stableKeys must be a boolean");
    const filterShared = options.filterShared ?? false;
    if (typeof filterShared !== "boolean") throw new TypeError("safeStringify options.filterShared must be a boolean");
    let text: string | undefined;
    try {
        const target = stableKeys ? cloneWithStableKeys(value, new WeakMap()) : value;
        // Both modes use the same library walk: it is the shared-reference
        // filter, so `filterShared: false` keeps the library's behavior and
        // `filterShared: true` records the caller's reliance on it. Keeping a
        // single call site guarantees the explicit mode cannot drift from the
        // default encoding.
        text = useStringify(target as object);
    } catch (error) {
        throw serializationError("JSON serialization failed", error);
    }
    if (typeof text !== "string") throw new SerializationError(`JSON serialization failed: ${NON_REPRESENTABLE_ROOTS}`);
    return text;
});

/**
 * Parse external or previously persisted JSON text. A malformed document,
 * including one that throws from a reviver extension point, becomes a
 * `SerializationError`; no partially built value escapes.
 */
export const safeParse: SafeParse = Object.freeze(<T = unknown>(text: string): T => {
    if (typeof text !== "string") throw new SerializationError("JSON parse failed: input must be a string");
    try {
        return JSON.parse(text) as T;
    } catch (error) {
        throw serializationError("JSON parse failed", error);
    }
});

/**
 * Content digest of a value: stable (key-sorted) JSON text hashed with SHA-256.
 * The `sha256:` prefix matches the convention already used by the protocol's
 * context, session and execution digests. Equal values produce equal digests
 * regardless of property insertion order; cycles and shared references are
 * filtered by the library semantics described above.
 */
export const digestOf: DigestOf = Object.freeze((value: unknown): string => {
    // Canonical digests rely on the shared-reference filter: a digest must not
    // depend on how often the same object happens to be reachable.
    const text = safeStringify(value, { stableKeys: true, filterShared: true });
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
});
