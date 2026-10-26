/**
 * Height-balanced AVL search tree.
 *
 * Every node stores its subtree height, and each insertion or deletion walks
 * back up the affected path applying LL/RR/LR/RL rotations until every balance
 * factor is in `[-1, 1]`. The tree therefore keeps its height O(log n) even for
 * sorted insertion sequences, and `insert`, `has`, `delete`, `min`, `max`,
 * `floor` and `ceil` are O(log n) worst case.
 */

import { compareNatural } from "./compare.ts";
import type { Comparator } from "./compare.ts";
import type { TreeOptions } from "./binarySearchTree.ts";

export type { TreeOptions };

/**
 * One AVL node; `height` is the node count of its subtree.
 */
interface AVLNode<T> {
    value: T;
    left: AVLNode<T> | null;
    right: AVLNode<T> | null;
    height: number;
}

/**
 * A self-balancing AVL binary search tree.
 *
 * Duplicate values (comparator result 0) are rejected. The stored
 * representative is never replaced by an equivalent insert; deleting with an
 * equivalent value removes the stored representative.
 */
export class AVLTree<T> implements Iterable<T> {
    private rootNode: AVLNode<T> | null = null;
    private count = 0;
    private readonly compare: Comparator<T>;

    /**
     * Create an empty AVL tree.
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
     * Height of the tree in nodes: 0 when empty, 1 for a leaf.
     */
    get height(): number {
        return this.rootNode === null ? 0 : this.rootNode.height;
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
     * @param value - Value to insert.
     * @returns `true` if a node was added, `false` for an equivalent duplicate.
     */
    insert(value: T): boolean {
        const previous = this.count;
        this.rootNode = this.insertNode(this.rootNode, value);
        return this.count > previous;
    }

    /**
     * Test whether an equivalent value is stored.
     *
     * @param value - Value to look up.
     */
    has(value: T): boolean {
        let node = this.rootNode;
        while (node !== null) {
            const order = this.compare(value, node.value);
            if (order === 0) {
                return true;
            }
            node = order < 0 ? node.left : node.right;
        }
        return false;
    }

    /**
     * Delete the value equivalent to `value` and rebalance the path to the root.
     *
     * A two-child node is replaced by its in-order successor. Rotation is applied
     * on every ancestor whose balance factor leaves `[-1, 1]`.
     *
     * @param value - Value to remove.
     * @returns `true` if a value was removed, `false` when none is equivalent.
     */
    delete(value: T): boolean {
        const previous = this.count;
        this.rootNode = this.deleteNode(this.rootNode, value);
        return this.count < previous;
    }

    /**
     * Minimum stored value according to the comparator, or `undefined` when
     * empty.
     */
    min(): T | undefined {
        if (this.rootNode === null) {
            return undefined;
        }
        return AVLTree.minimumNode(this.rootNode).value;
    }

    /**
     * Maximum stored value according to the comparator, or `undefined` when
     * empty.
     */
    max(): T | undefined {
        let node = this.rootNode;
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
        let node = this.rootNode;
        let result: T | undefined;
        while (node !== null) {
            const order = this.compare(node.value, value);
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
        let node = this.rootNode;
        let result: T | undefined;
        while (node !== null) {
            const order = this.compare(node.value, value);
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
     * Remove every value and reset the height to 0.
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
     * Verifies strict in-order ordering, the maintained size, every node's stored
     * height against the actual subtree height, and the AVL balance condition
     * `|balanceFactor| <= 1`. An empty array means the tree is valid.
     */
    validate(): string[] {
        const errors: string[] = [];
        if (this.rootNode === null) {
            if (this.count !== 0) {
                errors.push(`size mismatch: expected ${this.count}, found an empty tree`);
            }
            return errors;
        }

        const values = this.toArray();
        if (values.length !== this.count) {
            errors.push(`size mismatch: expected ${this.count}, traversed ${values.length}`);
        }
        for (let index = 1; index < values.length; index += 1) {
            if (this.compare(values[index - 1], values[index]) >= 0) {
                errors.push(`ordering violation between in-order positions ${index - 1} and ${index}`);
            }
        }

        const actualHeights = new Map<AVLNode<T>, number>();
        const stack: Array<{ node: AVLNode<T>; visited: boolean }> = [{ node: this.rootNode, visited: false }];
        let seen = 0;
        while (stack.length > 0) {
            const frame = stack.pop();
            if (frame === undefined) {
                break;
            }
            if (!frame.visited) {
                stack.push({ node: frame.node, visited: true });
                if (frame.node.right !== null) {
                    stack.push({ node: frame.node.right, visited: false });
                }
                if (frame.node.left !== null) {
                    stack.push({ node: frame.node.left, visited: false });
                }
                continue;
            }

            seen += 1;
            const node = frame.node;
            const leftHeight = node.left === null ? 0 : actualHeights.get(node.left);
            const rightHeight = node.right === null ? 0 : actualHeights.get(node.right);
            if (leftHeight === undefined || rightHeight === undefined) {
                errors.push("height metadata is missing for a child subtree");
                actualHeights.set(node, 1);
                continue;
            }
            const actualHeight = 1 + Math.max(leftHeight, rightHeight);
            actualHeights.set(node, actualHeight);
            if (node.height !== actualHeight) {
                errors.push(`height mismatch: stored ${node.height}, actual ${actualHeight}`);
            }
            const balance = leftHeight - rightHeight;
            if (Math.abs(balance) > 1) {
                errors.push(`balance violation: balance factor ${balance}`);
            }
        }
        if (seen !== this.count) {
            errors.push(`size mismatch: expected ${this.count}, reached ${seen} nodes`);
        }
        return errors;
    }

    private insertNode(node: AVLNode<T> | null, value: T): AVLNode<T> {
        if (node === null) {
            this.count += 1;
            return { value, left: null, right: null, height: 1 };
        }
        const order = this.compare(value, node.value);
        if (order === 0) {
            return node;
        }
        if (order < 0) {
            node.left = this.insertNode(node.left, value);
        } else {
            node.right = this.insertNode(node.right, value);
        }
        return this.rebalance(node);
    }

    private deleteNode(node: AVLNode<T> | null, value: T): AVLNode<T> | null {
        if (node === null) {
            return null;
        }
        const order = this.compare(value, node.value);
        if (order < 0) {
            node.left = this.deleteNode(node.left, value);
        } else if (order > 0) {
            node.right = this.deleteNode(node.right, value);
        } else {
            if (node.left === null) {
                this.count -= 1;
                return node.right;
            }
            if (node.right === null) {
                this.count -= 1;
                return node.left;
            }
            const successor = AVLTree.minimumNode(node.right);
            node.value = successor.value;
            node.right = this.deleteNode(node.right, successor.value);
        }
        return this.rebalance(node);
    }

    /**
     * Recompute this node's height and repair its subtree with rotations.
     */
    private rebalance(node: AVLNode<T>): AVLNode<T> {
        this.updateHeight(node);
        const balance = this.balanceFactor(node);
        if (balance > 1) {
            const left = node.left;
            if (left !== null && this.balanceFactor(left) < 0) {
                node.left = this.rotateLeft(left);
            }
            return this.rotateRight(node);
        }
        if (balance < -1) {
            const right = node.right;
            if (right !== null && this.balanceFactor(right) > 0) {
                node.right = this.rotateRight(right);
            }
            return this.rotateLeft(node);
        }
        return node;
    }

    /**
     * Right rotation; returns the new subtree root.
     */
    private rotateRight(node: AVLNode<T>): AVLNode<T> {
        const pivot = node.left;
        if (pivot === null) {
            return node;
        }
        node.left = pivot.right;
        pivot.right = node;
        this.updateHeight(node);
        this.updateHeight(pivot);
        return pivot;
    }

    /**
     * Left rotation; returns the new subtree root.
     */
    private rotateLeft(node: AVLNode<T>): AVLNode<T> {
        const pivot = node.right;
        if (pivot === null) {
            return node;
        }
        node.right = pivot.left;
        pivot.left = node;
        this.updateHeight(node);
        this.updateHeight(pivot);
        return pivot;
    }

    private updateHeight(node: AVLNode<T>): void {
        node.height = 1 + Math.max(AVLTree.heightOf(node.left), AVLTree.heightOf(node.right));
    }

    private balanceFactor(node: AVLNode<T>): number {
        return AVLTree.heightOf(node.left) - AVLTree.heightOf(node.right);
    }

    private static heightOf<T>(node: AVLNode<T> | null): number {
        return node === null ? 0 : node.height;
    }

    private static minimumNode<T>(node: AVLNode<T>): AVLNode<T> {
        let current = node;
        while (current.left !== null) {
            current = current.left;
        }
        return current;
    }

    private *inorderValues(): Generator<T> {
        const stack: AVLNode<T>[] = [];
        let node = this.rootNode;
        while (node !== null || stack.length > 0) {
            while (node !== null) {
                stack.push(node);
                node = node.left;
            }
            const current = stack.pop();
            if (current === undefined) {
                break;
            }
            yield current.value;
            node = current.right;
        }
    }
}
