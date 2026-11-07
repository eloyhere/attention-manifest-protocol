import { isIterable, useTraverse } from "semantic-typescript";
import type { TraverseStats, TraverseVisitor } from "./types.ts";

/**
 * Cycle-safe traversal built on `semantic-typescript`'s `useTraverse`.
 *
 * `useTraverse` keeps one shared `WeakSet` and refuses to descend into an
 * object it has already seen, so circular references terminate instead of
 * overflowing the stack. This wrapper adds the two things the library does
 * not report: a visitor that receives the leaf value and its path, and
 * visit/skip statistics.
 *
 * The visitor runs once per primitive leaf (including functions and symbols,
 * but never for `null`/`undefined`, which the library's `validate` skips).
 * Objects are recursion points, not leaves. Returning `false` stops the walk;
 * remaining branches are then unvisited, not "skipped".
 */

const NO_TRAVERSAL: TraverseStats = Object.freeze({ visited: 0, skipped: 0, stopped: false });

/**
 * Count references the shared-`WeakSet` walk would skip. The traversal shape
 * mirrors `useTraverse` exactly: every `traverse(target)` step reads
 * `Reflect.ownKeys(target)`, an iterable *property value* contributes its
 * items in index order, and an object item is traversed again through
 * `Reflect.ownKeys`. This matters for arrays: a root array (or an array nested
 * in an array) is walked through its own keys, so `length` is visited as a
 * leaf; an array held by an object property is walked through its items.
 *
 * Only object references participate in the skip count, because the library
 * only guards objects.
 *
 * This deliberately re-walks identities instead of reading the library's
 * private set: `useTraverse` reports no skip counter, so the count is derived
 * from the same structural rule. The count covers the whole graph even when
 * the visitor stops the traversal early.
 */
function countSkippedReferences(root: object): number {
    const seen = new WeakSet<object>();
    let skipped = 0;
    const walk = (target: object): void => {
        if (seen.has(target)) {
            skipped += 1;
            return;
        }
        seen.add(target);
        for (const key of Reflect.ownKeys(target)) {
            const value = Reflect.get(target, key);
            if (value === null || value === undefined) continue;
            if (typeof value !== "object") continue;
            if (isIterable(value)) {
                for (const item of value) {
                    if (item !== null && typeof item === "object") walk(item);
                }
            } else {
                walk(value);
            }
        }
    };
    walk(root);
    return skipped;
}

/**
 * Traverse `root` without following circular/shared references twice and
 * return frozen statistics. A non-object root is not traversable (matching
 * `useTraverse`) and yields zero counts.
 */
export const traverseSafely = Object.freeze((root: unknown, visitor: TraverseVisitor): TraverseStats => {
    if (typeof visitor !== "function") throw new TypeError("traverseSafely requires a visitor function");
    if (root === null || typeof root !== "object") return NO_TRAVERSAL;
    let visited = 0;
    let stopped = false;
    useTraverse(root, (_key: PropertyKey, value: unknown, path: readonly PropertyKey[]): boolean => {
        visited += 1;
        if (visitor(value, path) === false) {
            stopped = true;
            return false;
        }
        return true;
    });
    return Object.freeze({ visited, skipped: countSkippedReferences(root), stopped });
});
