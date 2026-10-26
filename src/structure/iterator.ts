/**
 * Small iterator helpers shared by the collection structures.
 */

/**
 * Yield a snapshot array as a `Generator`.
 *
 * The array is evaluated by the call site before this generator is created, so
 * passing `this.toArray()` gives snapshot iteration without an `ArrayIterator`
 * return type. Consumers can use `for...of`, spread, or `next()` directly.
 */
export function* generatorFrom<T>(values: readonly T[]): Generator<T, void, unknown> {
    yield* values;
}
