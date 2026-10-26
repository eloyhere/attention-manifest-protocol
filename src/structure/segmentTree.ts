/**
 * Iterative segment tree over an associative monoid.
 *
 * The class owns a power-of-two padded tree: every real leaf holds one value,
 * padding leaves hold the identity, and every internal node combines its two
 * children. Point updates rebuild the root path in O(log n); half-open range
 * queries combine O(log n) canonical nodes while preserving left-to-right
 * order, so non-commutative operations such as string concatenation work.
 *
 * Lazy range updates are deliberately not supported. Empty ranges return the
 * identity, and `size: 0` is valid: the tree has no leaves but still answers
 * empty queries and `queryAll()` with that identity.
 */

/**
 * Construction options for {@link SegmentTree}.
 */
export interface SegmentTreeOptions<T> {
    /**
     * Number of leaves. Must be a non-negative safe integer.
     */
    size: number;
    /**
     * Associative operation applied left-to-right.
     */
    operation: (left: T, right: T) => T;
    /**
     * Neutral element for {@link SegmentTreeOptions.operation}.
     */
    identity: T;
    /**
     * Optional initial leaf values, in index order. If present, the iterable
     * must contain exactly {@link SegmentTreeOptions.size} values.
     */
    values?: Iterable<T>;
}

/**
 * A segment tree for an associative monoid.
 *
 * Values are stored by reference; the tree never clones them. The operation
 * must be associative, and `identity` must be neutral for it. Commutativity is
 * not required: range queries combine canonical nodes in index order.
 *
 * @typeParam T - Leaf value type.
 */
export class SegmentTree<T> {
    private readonly operation: (left: T, right: T) => T;
    private readonly identity: T;
    private readonly count: number;
    private readonly base: number;
    private readonly tree: T[];

    /**
     * Build a tree with `options.size` leaves.
     *
     * When `values` is omitted, every leaf starts as `identity`. When it is
     * supplied, it is consumed once and must produce exactly `size` values.
     *
     * @param options - Size, operation, identity, and optional initial values.
     * @throws RangeError if `size` is not a non-negative safe integer, or if
     * `values` does not contain exactly `size` values.
     * @throws TypeError if `operation` is not a function or `identity` is not
     * supplied.
     */
    constructor(options: SegmentTreeOptions<T>) {
        const input: SegmentTreeOptions<T> | null | undefined = options;
        if (input === null || typeof input !== "object") {
            throw new TypeError("options must be an object");
        }
        if (!Number.isSafeInteger(input.size) || input.size < 0) {
            throw new RangeError(`size must be a non-negative safe integer, received ${String(input.size)}`);
        }
        if (typeof input.operation !== "function") {
            throw new TypeError("operation must be a function");
        }
        if (!("identity" in input)) {
            throw new TypeError("identity is required");
        }

        this.operation = input.operation;
        this.identity = input.identity;
        this.count = input.size;

        let base = 1;
        while (base < this.count) {
            base *= 2;
        }
        this.base = base;

        const tree = new Array<T>(base * 2).fill(this.identity);
        if (input.values !== undefined) {
            let index = 0;
            for (const value of input.values) {
                if (index === this.count) {
                    throw new RangeError(`values must contain exactly ${this.count} values`);
                }
                tree[base + index] = value;
                index += 1;
            }
            if (index !== this.count) {
                throw new RangeError(`values must contain exactly ${this.count} values, received ${index}`);
            }
        }

        for (let node = base - 1; node >= 1; node -= 1) {
            tree[node] = this.operation(tree[node * 2], tree[node * 2 + 1]);
        }
        this.tree = tree;
    }

    /**
     * Number of real leaves.
     */
    get size(): number {
        return this.count;
    }

    /**
     * Read the leaf at `index`.
     *
     * @throws RangeError if `index` is not a safe integer in `[0, size)`.
     */
    get(index: number): T {
        this.assertIndex(index);
        return this.tree[this.base + index];
    }

    /**
     * Replace the leaf at `index`.
     *
     * @throws RangeError if `index` is not a safe integer in `[0, size)`.
     */
    set(index: number, value: T): void {
        this.assertIndex(index);
        const leaf = this.base + index;
        this.tree[leaf] = value;
        this.rebuild(leaf);
    }

    /**
     * Transform the leaf at `index` from its current value.
     *
     * `update` is called once with the previous leaf value. If it throws, the
     * tree is left unchanged.
     *
     * @throws RangeError if `index` is not a safe integer in `[0, size)`.
     */
    update(index: number, update: (previous: T) => T): void {
        this.assertIndex(index);
        const leaf = this.base + index;
        const next = update(this.tree[leaf]);
        this.tree[leaf] = next;
        this.rebuild(leaf);
    }

    /**
     * Query the half-open range `[left, right)`.
     *
     * Canonical nodes are combined in index order, so the result is correct for
     * non-commutative operations. An empty range returns `identity`.
     *
     * @throws RangeError unless `left` and `right` are safe integers satisfying
     * `0 <= left <= right <= size`.
     */
    query(left: number, right: number): T {
        this.assertRange(left, right);
        if (left === right) {
            return this.identity;
        }

        let leftNode = this.base + left;
        let rightNode = this.base + right;
        let leftResult = this.identity;
        let rightResult = this.identity;

        while (leftNode < rightNode) {
            if (leftNode % 2 === 1) {
                leftResult = this.operation(leftResult, this.tree[leftNode]);
                leftNode += 1;
            }
            if (rightNode % 2 === 1) {
                rightNode -= 1;
                rightResult = this.operation(this.tree[rightNode], rightResult);
            }
            leftNode = Math.floor(leftNode / 2);
            rightNode = Math.floor(rightNode / 2);
        }

        return this.operation(leftResult, rightResult);
    }

    /**
     * Query the whole stored range.
     *
     * This is O(1): the tree root already combines the leaves in order. It
     * returns `identity` when the tree is empty.
     */
    queryAll(): T {
        return this.count === 0 ? this.identity : this.tree[1];
    }

    /**
     * Return a fresh array of leaf values in index order.
     */
    toArray(): T[] {
        return this.tree.slice(this.base, this.base + this.count);
    }

    /**
     * Reset every leaf to `identity`.
     *
     * All tree nodes are overwritten directly, so this is O(n) total rather than
     * performing a separate rebuild path for each leaf.
     */
    clear(): void {
        this.tree.fill(this.identity);
    }

    /**
     * Recombine the root path after a leaf write.
     */
    private rebuild(leaf: number): void {
        let node = Math.floor(leaf / 2);
        while (node >= 1) {
            this.tree[node] = this.operation(this.tree[node * 2], this.tree[node * 2 + 1]);
            node = Math.floor(node / 2);
        }
    }

    /**
     * Validate a single-leaf index.
     */
    private assertIndex(index: number): void {
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) {
            throw new RangeError(`index must be a safe integer in [0, ${this.count}), received ${String(index)}`);
        }
    }

    /**
     * Validate a half-open query range.
     */
    private assertRange(left: number, right: number): void {
        if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right > this.count || left > right) {
            throw new RangeError(`query range must satisfy 0 <= left <= right <= ${this.count}, received [${String(left)}, ${String(right)})`);
        }
    }
}
