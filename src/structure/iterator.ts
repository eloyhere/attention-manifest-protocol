/**
 * Small iterator helpers shared by the collection structures.
 */

type GeneratorFactory = <T>(values: readonly T[]) => Generator<T, void, unknown>;

/**
 * Yield a snapshot array as a `Generator`.
 *
 * The array is evaluated by the call site before this generator is created, so
 * passing `this.toArray()` gives snapshot iteration without an `ArrayIterator`
 * return type. Consumers can use `for...of`, spread, or `next()` directly.
 */
const SnapshotGenerators: {
    from: GeneratorFactory;
} = {
    *from<T>(values: readonly T[]): Generator<T, void, unknown> {
        yield* values;
    },
};

export const generatorFrom: GeneratorFactory = <T>(values: readonly T[]): Generator<T, void, unknown> => SnapshotGenerators.from(values);
