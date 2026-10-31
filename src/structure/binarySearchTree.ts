/**
 * Unbalanced binary search tree.
 *
 * Values are ordered by a supplied {@link Comparator}, defaulting to
 * {@link compareNatural}. Duplicate values (comparator result 0) are rejected.
 * The tree is deliberately not balanced: a sorted insertion sequence degenerates
 * it into a linked list, so `insert`, `has`, and `delete` are O(n) in the worst
 * case and O(log n) only when the insertion order happens to keep the tree
 * shallow. Use {@link AVLTree} or {@link RedBlackTree} when worst-case bounds
 * matter.
 */

import { compareNatural } from "./compare.ts";
import type { Comparator } from "./compare.ts";

/**
 * Options shared by the ordered search trees.
 */
export interface TreeOptions<T> {
    /**
     * Total-preorder comparator. Defaults to {@link compareNatural}, which
     * supports numbers, bigints, strings, booleans and Dates and throws for other
     * values.
     */
    compare?: Comparator<T>;
}

/**
 * One search-tree node; links are `null` at the leaves.
 */
interface SearchNode<T> {
    value: T;
    left: SearchNode<T> | null;
    right: SearchNode<T> | null;
}

/**
 * One frame of the iterative height walk.
 */
interface HeightFrame<T> {
    node: SearchNode<T>;
    depth: number;
}

/**
 * An unbalanced binary search tree.
 *
 * In-order iteration is sorted according to the configured comparator. The
 * tree keeps exactly one representative for each comparator equivalence class,
 * so inserting an equivalent value returns `false` and leaves the stored
 * representative unchanged.
 */
export class BinarySearchTree<T> implements Iterable<T> {
    private rootNode: SearchNode<T> | null = null;
    private count = 0;
    private readonly compare: Comparator<T>;

    /**
     * Create an empty search tree.
     *
     * @param options - Comparator override; defaults to natural ordering.
     */
    constructor(options?: TreeOptions<T>) {
        this.compare = options?.compare ?? ((left: T, right: T): number => compareNatural(left, right));
    }

    /**
     * Number of stored values.
     */
    get size(): number {
        return this.count;
    }

    /**
     * Number of nodes on the longest root-to-leaf path.
     *
     * Empty trees have height 0 and leaves have height 1. Computed in O(n) time.
     */
    get height(): number {
        if (this.rootNode === null) {
            return 0;
        }
        let maximum: number = 0;
        const stack: HeightFrame<T>[] = [{ node: this.rootNode, depth: 1 }];
        while (stack.length > 0) {
            const frame: HeightFrame<T> | undefined = stack.pop();
            if (frame === (void 0)) {
                break;
            }
            if (frame.depth > maximum) {
                maximum = frame.depth;
            }
            if (frame.node.left !== null) {
                stack.push({ node: frame.node.left, depth: frame.depth + 1 });
            }
            if (frame.node.right !== null) {
                stack.push({ node: frame.node.right, depth: frame.depth + 1 });
            }
        }
        return maximum;
    }

    /**
     * Whether the tree contains no values.
     */
    get isEmpty(): boolean {
        return this.count === 0;
    }

    /**
     * Insert a value unless an equivalent one is already stored.
     *
     * O(h) where `h` is the current height; O(n) worst case. The first value
     * inserted into an empty tree does not invoke the comparator.
     *
     * @param value - Value to insert.
     * @returns `true` if a node was added, `false` for an equivalent duplicate.
     */
    insert(value: T): boolean {
        if (this.rootNode === null) {
            this.rootNode = { value, left: null, right: null };
            this.count = 1;
            return true;
        }
        let node: SearchNode<T> | null = this.rootNode;
        while (true) {
            const order: number = this.compare(value, node.value);
            if (order === 0) {
                return false;
            }
            if (order < 0) {
                if (node.left === null) {
                    node.left = { value, left: null, right: null };
                    this.count += 1;
                    return true;
                }
                node = node.left;
            } else {
                if (node.right === null) {
                    node.right = { value, left: null, right: null };
                    this.count += 1;
                    return true;
                }
                node = node.right;
            }
        }
    }

    /**
     * Test whether an equivalent value is stored.
     *
     * @param value - Value to look up.
     */
    has(value: T): boolean {
        let node: SearchNode<T> | null = this.rootNode;
        while (node !== null) {
            const order: number = this.compare(value, node.value);
            if (order === 0) {
                return true;
            }
            node = order < 0 ? node.left : node.right;
        }
        return false;
    }

    /**
     * Delete the value equivalent to `value`.
     *
     * Handles the zero-, one- and two-child cases; a two-child node is replaced by
     * its in-order successor. O(h), O(n) worst case.
     *
     * @param value - Value to remove.
     * @returns `true` if a value was removed, `false` when none is equivalent.
     */
    delete(value: T): boolean {
        let node: SearchNode<T> | null = this.rootNode;
        let parent: SearchNode<T> | null = null;
        while (node !== null) {
            const order: number = this.compare(value, node.value);
            if (order === 0) {
                break;
            }
            parent = node;
            node = order < 0 ? node.left : node.right;
        }
        if (node === null) {
            return false;
        }

        let target: SearchNode<T> = node;
        let targetParent: SearchNode<T> | null = parent;
        if (target.left !== null && target.right !== null) {
            let successorParent: SearchNode<T> = target;
            let successor: SearchNode<T> | null = target.right;
            while (successor.left !== null) {
                successorParent = successor;
                successor = successor.left;
            }
            target.value = successor.value;
            target = successor;
            targetParent = successorParent;
        }

        const child: SearchNode<T> | null = target.left !== null ? target.left : target.right;
        if (targetParent === null) {
            this.rootNode = child;
        } else if (targetParent.left === target) {
            targetParent.left = child;
        } else {
            targetParent.right = child;
        }

        this.count -= 1;
        return true;
    }

    /**
     * Minimum stored value according to the comparator, or `undefined` when
     * empty.
     */
    min(): T | undefined {
        let node: SearchNode<T> | null = this.rootNode;
        if (node === null) {
            return undefined;
        }
        while (node.left !== null) {
            node = node.left;
        }
        return node.value;
    }

    /**
     * Maximum stored value according to the comparator, or `undefined` when
     * empty.
     */
    max(): T | undefined {
        let node: SearchNode<T> | null = this.rootNode;
        if (node === null) {
            return undefined;
        }
        while (node.right !== null) {
            node = node.right;
        }
        return node.value;
    }

    /**
     * Greatest stored value that is less than or equal to `value` in comparator
     * order, or `undefined` when there is none.
     */
    floor(value: T): T | undefined {
        let node: SearchNode<T> | null = this.rootNode;
        let result: T | undefined;
        while (node !== null) {
            const order: number = this.compare(node.value, value);
            if (order === 0) {
                return node.value;
            }
            if (order < 0) {
                result = node.value;
                node = node.right;
            } else {
                node = node.left;
            }
        }
        return result;
    }

    /**
     * Least stored value that is greater than or equal to `value` in comparator
     * order, or `undefined` when there is none.
     */
    ceil(value: T): T | undefined {
        let node: SearchNode<T> | null = this.rootNode;
        let result: T | undefined;
        while (node !== null) {
            const order: number = this.compare(node.value, value);
            if (order === 0) {
                return node.value;
            }
            if (order < 0) {
                node = node.right;
            } else {
                result = node.value;
                node = node.left;
            }
        }
        return result;
    }

    /**
     * Remove every value.
     */
    clear(): void {
        this.rootNode = null;
        this.count = 0;
    }

    /**
     * Collect values in ascending comparator order.
     */
    toArray(): T[] {
        return Array.from(this.inorderValues());
    }

    /**
     * Iterate values in ascending comparator order.
     *
     * Mutating the tree while iterating is not supported.
     */
    [Symbol.iterator](): Generator<T> {
        return this.inorderValues();
    }

    /**
     * Check the tree's invariants.
     *
     * Verifies strict in-order ordering and that the maintained `size` matches the
     * number of reachable nodes. Returns an empty array for a valid tree; each
     * string describes one violation.
     */
    validate(): string[] {
        const errors: string[] = [];
        const values: T[] = this.toArray();
        if (values.length !== this.count) {
            errors.push(`size mismatch: expected ${this.count}, traversed ${values.length}`);
        }
        for (let index: number = 1; index < values.length; index += 1) {
            if (this.compare(values[index - 1], values[index]) >= 0) {
                errors.push(`ordering violation between in-order positions ${index - 1} and ${index}`);
            }
        }
        return errors;
    }

    private *inorderValues(): Generator<T> {
        const stack: SearchNode<T>[] = [];
        let node: SearchNode<T> | null = this.rootNode;
        while (node !== null || stack.length > 0) {
            while (node !== null) {
                stack.push(node);
                node = node.left;
            }
            const current: SearchNode<T> | undefined = stack.pop();
            if (current === (void 0)) {
                break;
            }
            yield current.value;
            node = current.right;
        }
    }
}
