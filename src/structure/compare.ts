/**
 * Ordering primitives shared by the ordered structures.
 *
 * A comparator returns a negative number when `a` sorts before `b`, zero when
 * they are equivalent for the structure, and a positive number otherwise.
 * The structures only require a total preorder; duplicate equivalence is
 * resolved by the container (e.g. a search tree keeps one representative).
 */

/**
 * Three-way comparison used by search trees, heaps and sorted helpers.
 */
export type Comparator<T> = (a: T, b: T) => number;

/**
 * Numeric comparison. NaN is rejected rather than silently sorted.
 */
export function compareNumbers(a: number, b: number): number {
    if (Number.isNaN(a) || Number.isNaN(b)) {
        throw new TypeError("cannot order NaN");
    }
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Lexicographic UTF-16 comparison, matching JavaScript's `<`.
 */
export function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * BigInt comparison, safe for values outside the number range.
 */
export function compareBigInts(a: bigint, b: bigint): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Chronological comparison of two Dates (invalid dates are rejected).
 */
export function compareDates(a: Date, b: Date): number {
    const left = a.getTime();
    const right = b.getTime();
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
        throw new TypeError("cannot order an invalid Date");
    }
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Natural ordering for the primitive types this library supports.
 *
 * It deliberately throws for unsupported values instead of coercing them to
 * strings: a search tree built on `"[object Object]"` order is a silent bug.
 * Equal primitive values compare as `0`; `-0` and `0` are equivalent, and
 * `NaN` is rejected.
 */
export function compareNatural<T>(a: T, b: T): number {
    if (typeof(a) === "number" && typeof(b) === "number") {
        return compareNumbers(a, b);
    }
    if (typeof(a) === "bigint" && typeof(b) === "bigint") {
        return compareBigInts(a, b);
    }
    if (typeof(a) === "string" && typeof(b) === "string") {
        return compareStrings(a, b);
    }
    if (typeof(a) === "boolean" && typeof(b) === "boolean") {
        return a === b ? 0 : a ? 1 : -1;
    }
    if (a instanceof Date && b instanceof Date) {
        return compareDates(a, b);
    }
    if (Object.is(a, b)) {
        return 0;
    }
    throw new TypeError(`no natural ordering for ${typeof(a)}; supply a Comparator<T>`);
}

/**
 * Invert a comparator. Useful for max-heaps built on min-heap machinery.
 */
export function reverseComparator<T>(compare: Comparator<T>): Comparator<T> {
    return (a, b) => {
        const result = compare(a, b);
        return result === 0 ? 0 : -result;
    };
}

/**
 * Derive a comparator for `T` from a key selector and an optional key
 * comparator. The selector is evaluated once per comparison; callers that need
 * caching should build it outside the hot path.
 */
export function byKey<T, K>(select: (value: T) => K, compare: Comparator<K> = compareNatural): Comparator<T> {
    return (a, b) => compare(select(a), select(b));
}

/**
 * Clamp a comparator result to the documented -1/0/1 shape.
 */
export function sign(value: number): -1 | 0 | 1 {
    return value < 0 ? -1 : value > 0 ? 1 : 0;
}

/**
 * The default comparator used when a structure's options omit one.
 */
export const defaultCompare: Comparator<unknown> = (a, b) => compareNatural(a, b);
