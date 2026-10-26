/**
 * Red-black binary search tree.
 *
 * The tree uses explicit null leaves (no sentinel) and stores a parent pointer
 * on every node. Insertion and full CLRS-style deletion fix-up maintain the
 * red-black invariants: the root is black, red nodes have black children, and
 * every root-to-null path contains the same number of black nodes. These
 * invariants bound the height by `2 * log2(n + 1)`, so `insert`, `has`,
 * `delete`, `min`, `max`, `floor` and `ceil` are O(log n) worst case.
 */

import { compareNatural } from "./compare.ts";
import type { Comparator } from "./compare.ts";
import type { TreeOptions } from "./binarySearchTree.ts";

export type { TreeOptions };

/**
 * One red-black node; `red` is the colour bit and leaves are `null`.
 */
interface RBNode<T> {
    value: T;
    left: RBNode<T> | null;
    right: RBNode<T> | null;
    parent: RBNode<T> | null;
    red: boolean;
}

/**
 * A self-balancing red-black binary search tree.
 *
 * Duplicate values (comparator result 0) are rejected. In-order iteration is
 * sorted according to the configured comparator.
 */
export class RedBlackTree<T> implements Iterable<T> {
    private rootNode: RBNode<T> | null = null;
    private count = 0;
    private readonly compare: Comparator<T>;

    /**
     * Create an empty red-black tree.
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
     *
     * Computed on demand in O(n) time; the red-black invariants bound it to
     * O(log n).
     */
    get height(): number {
        if (this.rootNode === null) {
            return 0;
        }
        let maximum = 0;
        const stack: Array<{ node: RBNode<T>; depth: number }> = [{ node: this.rootNode, depth: 1 }];
        while (stack.length > 0) {
            const frame = stack.pop();
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
     * The new node starts red and is repaired by the standard CLRS insertion
     * fix-up, including all LL/RR/LR/RL rotation shapes.
     *
     * @param value - Value to insert.
     * @returns `true` if a node was added, `false` for an equivalent duplicate.
     */
    insert(value: T): boolean {
        let parent: RBNode<T> | null = null;
        let node = this.rootNode;
        let goLeft = false;
        while (node !== null) {
            const order = this.compare(value, node.value);
            if (order === 0) {
                return false;
            }
            parent = node;
            goLeft = order < 0;
            node = goLeft ? node.left : node.right;
        }

        const inserted: RBNode<T> = {
            value,
            left: null,
            right: null,
            parent,
            red: true,
        };
        if (parent === null) {
            this.rootNode = inserted;
        } else if (goLeft) {
            parent.left = inserted;
        } else {
            parent.right = inserted;
        }

        this.count += 1;
        this.insertFixup(inserted);
        if (this.rootNode !== null) {
            this.rootNode.red = false;
        }
        return true;
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
     * Delete the value equivalent to `value`.
     *
     * Handles zero-, one- and two-child removals and runs the full CLRS deletion
     * fix-up, so all red-black invariants are restored before returning. A
     * two-child node is replaced by its in-order successor.
     *
     * @param value - Value to remove.
     * @returns `true` if a value was removed, `false` when none is equivalent.
     */
    delete(value: T): boolean {
        let node = this.rootNode;
        while (node !== null) {
            const order = this.compare(value, node.value);
            if (order === 0) {
                break;
            }
            node = order < 0 ? node.left : node.right;
        }
        if (node === null) {
            return false;
        }

        this.deleteNode(node);
        this.count -= 1;
        if (this.rootNode !== null) {
            this.rootNode.red = false;
        }
        return true;
    }

    /**
     * Minimum stored value according to the comparator, or `undefined` when
     * empty.
     */
    min(): T | undefined {
        if (this.rootNode === null) {
            return undefined;
        }
        return RedBlackTree.minimumNode(this.rootNode).value;
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
     * Remove every value and reset the root to `null`.
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
     * Verifies that the root is black, that no red node has a red child, that
     * every root-to-null path has the same black height, that in-order values are
     * strictly increasing, that parent links are consistent, and that the
     * maintained size matches the reachable node count. An empty array means the
     * tree is valid.
     */
    validate(): string[] {
        const errors: string[] = [];
        if (this.rootNode === null) {
            if (this.count !== 0) {
                errors.push(`size mismatch: expected ${this.count}, found an empty tree`);
            }
            return errors;
        }

        if (this.rootNode.red) {
            errors.push("root is red");
        }
        if (this.rootNode.parent !== null) {
            errors.push("root has a parent");
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

        const blackHeights = new Map<RBNode<T>, number>();
        const stack: Array<{ node: RBNode<T>; visited: boolean }> = [{ node: this.rootNode, visited: false }];
        let seen = 0;
        while (stack.length > 0) {
            const frame = stack.pop();
            if (frame === (void 0)) {
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
            if (node.red) {
                if (node.left !== null && node.left.red) {
                    errors.push("red node has a red left child");
                }
                if (node.right !== null && node.right.red) {
                    errors.push("red node has a red right child");
                }
            }
            if (node.left !== null && node.left.parent !== node) {
                errors.push("left child has an inconsistent parent link");
            }
            if (node.right !== null && node.right.parent !== node) {
                errors.push("right child has an inconsistent parent link");
            }

            const leftBlack = node.left === null ? 0 : blackHeights.get(node.left);
            const rightBlack = node.right === null ? 0 : blackHeights.get(node.right);
            if (leftBlack === (void 0) || rightBlack === (void 0)) {
                errors.push("black height is missing for a child subtree");
                blackHeights.set(node, node.red ? 0 : 1);
                continue;
            }
            if (leftBlack !== rightBlack) {
                errors.push(`black-height mismatch: left ${leftBlack}, right ${rightBlack}`);
            }
            blackHeights.set(node, (node.red ? 0 : 1) + Math.max(leftBlack, rightBlack));
        }
        if (seen !== this.count) {
            errors.push(`size mismatch: expected ${this.count}, reached ${seen} nodes`);
        }
        return errors;
    }

    /**
     * Restore the red-black invariants after inserting a red leaf.
     */
    private insertFixup(start: RBNode<T>): void {
        let node = start;
        while (node.parent !== null && node.parent.red) {
            const parent = node.parent;
            const grandparent = parent.parent;
            if (grandparent === null) {
                break;
            }
            if (parent === grandparent.left) {
                const uncle = grandparent.right;
                if (uncle !== null && uncle.red) {
                    parent.red = false;
                    uncle.red = false;
                    grandparent.red = true;
                    node = grandparent;
                    continue;
                }
                if (node === parent.right) {
                    node = parent;
                    this.rotateLeft(node);
                }
                const nextParent = node.parent;
                const upper = nextParent === null ? null : nextParent.parent;
                if (nextParent !== null) {
                    nextParent.red = false;
                }
                if (upper !== null) {
                    upper.red = true;
                    this.rotateRight(upper);
                }
            } else {
                const uncle = grandparent.left;
                if (uncle !== null && uncle.red) {
                    parent.red = false;
                    uncle.red = false;
                    grandparent.red = true;
                    node = grandparent;
                    continue;
                }
                if (node === parent.left) {
                    node = parent;
                    this.rotateRight(node);
                }
                const nextParent = node.parent;
                const upper = nextParent === null ? null : nextParent.parent;
                if (nextParent !== null) {
                    nextParent.red = false;
                }
                if (upper !== null) {
                    upper.red = true;
                    this.rotateLeft(upper);
                }
            }
        }
        if (this.rootNode !== null) {
            this.rootNode.red = false;
        }
    }

    /**
     * Remove a known node, preserving the tree shape until fix-up runs.
     */
    private deleteNode(node: RBNode<T>): void {
        let moved = node;
        let movedWasRed = moved.red;
        let replacement: RBNode<T> | null;
        let replacementParent: RBNode<T> | null;

        if (node.left === null) {
            replacement = node.right;
            replacementParent = node.parent;
            this.transplant(node, node.right);
        } else if (node.right === null) {
            replacement = node.left;
            replacementParent = node.parent;
            this.transplant(node, node.left);
        } else {
            moved = RedBlackTree.minimumNode(node.right);
            movedWasRed = moved.red;
            replacement = moved.right;
            if (moved.parent === node) {
                replacementParent = moved;
                if (replacement !== null) {
                    replacement.parent = moved;
                }
            } else {
                replacementParent = moved.parent;
                this.transplant(moved, moved.right);
                moved.right = node.right;
                moved.right.parent = moved;
            }
            this.transplant(node, moved);
            moved.left = node.left;
            moved.left.parent = moved;
            moved.red = node.red;
        }

        if (!movedWasRed) {
            this.deleteFixup(replacement, replacementParent);
        }
    }

    /**
     * Replace the subtree rooted at `target` with the subtree `replacement`.
     */
    private transplant(target: RBNode<T>, replacement: RBNode<T> | null): void {
        if (target.parent === null) {
            this.rootNode = replacement;
        } else if (target === target.parent.left) {
            target.parent.left = replacement;
        } else {
            target.parent.right = replacement;
        }
        if (replacement !== null) {
            replacement.parent = target.parent;
        }
    }

    /**
     * Restore the red-black invariants after deleting a black node.
     */
    private deleteFixup(start: RBNode<T> | null, startParent: RBNode<T> | null): void {
        let node = start;
        let parent = startParent;
        while (node !== this.rootNode && !RedBlackTree.isRed(node)) {
            if (parent === null) {
                break;
            }
            if (node === parent.left) {
                let sibling = parent.right;
                if (sibling === null) {
                    node = parent;
                    parent = node.parent;
                    continue;
                }
                if (sibling.red) {
                    sibling.red = false;
                    parent.red = true;
                    this.rotateLeft(parent);
                    sibling = parent.right;
                    if (sibling === null) {
                        node = parent;
                        parent = node.parent;
                        continue;
                    }
                }
                const leftRed = RedBlackTree.isRed(sibling.left);
                const rightRed = RedBlackTree.isRed(sibling.right);
                if (!leftRed && !rightRed) {
                    sibling.red = true;
                    node = parent;
                    parent = node.parent;
                    continue;
                }
                if (!rightRed) {
                    if (sibling.left !== null) {
                        sibling.left.red = false;
                    }
                    sibling.red = true;
                    this.rotateRight(sibling);
                    sibling = parent.right;
                    if (sibling === null) {
                        node = parent;
                        parent = node.parent;
                        continue;
                    }
                }
                sibling.red = parent.red;
                parent.red = false;
                if (sibling.right !== null) {
                    sibling.right.red = false;
                }
                this.rotateLeft(parent);
                node = this.rootNode;
                parent = null;
            } else {
                let sibling = parent.left;
                if (sibling === null) {
                    node = parent;
                    parent = node.parent;
                    continue;
                }
                if (sibling.red) {
                    sibling.red = false;
                    parent.red = true;
                    this.rotateRight(parent);
                    sibling = parent.left;
                    if (sibling === null) {
                        node = parent;
                        parent = node.parent;
                        continue;
                    }
                }
                const leftRed = RedBlackTree.isRed(sibling.left);
                const rightRed = RedBlackTree.isRed(sibling.right);
                if (!leftRed && !rightRed) {
                    sibling.red = true;
                    node = parent;
                    parent = node.parent;
                    continue;
                }
                if (!leftRed) {
                    if (sibling.right !== null) {
                        sibling.right.red = false;
                    }
                    sibling.red = true;
                    this.rotateLeft(sibling);
                    sibling = parent.left;
                    if (sibling === null) {
                        node = parent;
                        parent = node.parent;
                        continue;
                    }
                }
                sibling.red = parent.red;
                parent.red = false;
                if (sibling.left !== null) {
                    sibling.left.red = false;
                }
                this.rotateRight(parent);
                node = this.rootNode;
                parent = null;
            }
        }
        if (node !== null) {
            node.red = false;
        }
    }

    /**
     * Left rotation around `node`; updates the root when needed.
     */
    private rotateLeft(node: RBNode<T>): void {
        const pivot = node.right;
        if (pivot === null) {
            return;
        }
        node.right = pivot.left;
        if (pivot.left !== null) {
            pivot.left.parent = node;
        }
        const parent = node.parent;
        pivot.parent = parent;
        if (parent === null) {
            this.rootNode = pivot;
        } else if (parent.left === node) {
            parent.left = pivot;
        } else {
            parent.right = pivot;
        }
        pivot.left = node;
        node.parent = pivot;
    }

    /**
     * Right rotation around `node`; updates the root when needed.
     */
    private rotateRight(node: RBNode<T>): void {
        const pivot = node.left;
        if (pivot === null) {
            return;
        }
        node.left = pivot.right;
        if (pivot.right !== null) {
            pivot.right.parent = node;
        }
        const parent = node.parent;
        pivot.parent = parent;
        if (parent === null) {
            this.rootNode = pivot;
        } else if (parent.right === node) {
            parent.right = pivot;
        } else {
            parent.left = pivot;
        }
        pivot.right = node;
        node.parent = pivot;
    }

    private static isRed<T>(node: RBNode<T> | null): boolean {
        return node !== null && node.red;
    }

    private static minimumNode<T>(node: RBNode<T>): RBNode<T> {
        let current = node;
        while (current.left !== null) {
            current = current.left;
        }
        return current;
    }

    private *inorderValues(): Generator<T> {
        const stack: RBNode<T>[] = [];
        let node = this.rootNode;
        while (node !== null || stack.length > 0) {
            while (node !== null) {
                stack.push(node);
                node = node.left;
            }
            const current = stack.pop();
            if (current === (void 0)) {
                break;
            }
            yield current.value;
            node = current.right;
        }
    }
}
