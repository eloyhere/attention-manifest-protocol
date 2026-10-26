/**
 * Unordered binary tree.
 *
 * The tree is shape-oriented rather than search-oriented: values have no
 * ordering, `insert` fills the first missing child in level order, and the
 * four traversal orders are available for inspection. Node objects are
 * deliberately exposed through {@link BinaryTree.root}; a tree assembled by
 * hand should be passed to the constructor so its `size` is computed from the
 * existing nodes.
 *
 * `size` is maintained by {@link BinaryTree.insert} and
 * {@link BinaryTree.clear}. Mutating the exposed nodes directly is not tracked
 * by `size`; construct a new tree after manual restructuring.
 */

/**
 * A binary-tree node. Missing children are represented by `null`.
 */
export class BinaryTreeNode<T> {
    /**
     * Stored value.
     */
    value: T;

    /**
     * Left child, or `null` when absent.
     */
    left: BinaryTreeNode<T> | null;

    /**
     * Right child, or `null` when absent.
     */
    right: BinaryTreeNode<T> | null;

    /**
     * Create a node.
     *
     * @param value - Stored value.
     * @param left - Left child; defaults to `null`.
     * @param right - Right child; defaults to `null`.
     */
    constructor(value: T, left: BinaryTreeNode<T> | null = null, right: BinaryTreeNode<T> | null = null) {
        this.value = value;
        this.left = left;
        this.right = right;
    }
}

/**
 * Traversal orders supported by {@link BinaryTree.traverse}.
 */
export type BinaryTreeOrder = "preorder" | "inorder" | "postorder" | "levelorder";

/**
 * A binary tree with level-order construction, insertion and traversal.
 *
 * An empty tree has `size` 0 and `height` 0; a single node has height 1. A tree
 * built from an existing root computes its size once in the constructor. All
 * traversals are iterative, so unusually deep manual trees do not consume the
 * call stack.
 */
export class BinaryTree<T> implements Iterable<T> {
    private rootNode: BinaryTreeNode<T> | null;
    private count: number;

    /**
     * Create a tree from an existing node graph.
     *
     * `size` is computed by walking the supplied graph. Passing `null` creates an
     * empty tree.
     *
     * @param root - Root node, or `null` for an empty tree.
     */
    constructor(root: BinaryTreeNode<T> | null = null) {
        this.rootNode = root;
        this.count = BinaryTree.countNodes(root);
    }

    /**
     * Build a tree from a level-order array.
     *
     * Index 0 is the root; the children of index `i` are at `2i + 1` and
     * `2i + 2`. `null` entries are holes. Trailing `null` entries are ignored, and
     * entries below a hole are unreachable and therefore omitted.
     *
     * @param values - Level-order values, with `null` marking a missing node.
     */
    static fromLevelOrder<T>(values: ReadonlyArray<T | null>): BinaryTree<T> {
        let last = values.length - 1;
        while (last >= 0 && values[last] === null) {
            last -= 1;
        }
        if (last < 0) {
            return new BinaryTree<T>();
        }

        const nodes: Array<BinaryTreeNode<T> | null> = [];
        let root: BinaryTreeNode<T> | null = null;
        for (let index = 0; index <= last; index += 1) {
            const value = values[index];
            if (value === null) {
                nodes.push(null);
                continue;
            }
            if (index === 0) {
                const rootNode = new BinaryTreeNode(value);
                root = rootNode;
                nodes.push(rootNode);
                continue;
            }
            const parent = nodes[(index - 1) >> 1];
            if (parent === null || parent === undefined) {
                nodes.push(null);
                continue;
            }
            const node = new BinaryTreeNode(value);
            if (index % 2 === 1) {
                parent.left = node;
            } else {
                parent.right = node;
            }
            nodes.push(node);
        }
        return new BinaryTree(root);
    }

    /**
     * Build a complete tree from values in level order.
     *
     * Every position is filled, so the result is always complete. An empty
     * iterable produces an empty tree.
     *
     * @param values - Values to place in level order.
     */
    static fromArray<T>(values: Iterable<T>): BinaryTree<T> {
        const items = Array.from(values);
        if (items.length === 0) {
            return new BinaryTree<T>();
        }
        const nodes: Array<BinaryTreeNode<T>> = [];
        for (let index = 0; index < items.length; index += 1) {
            nodes.push(new BinaryTreeNode(items[index]));
        }
        for (let index = 0; index < nodes.length; index += 1) {
            const leftIndex = 2 * index + 1;
            const rightIndex = 2 * index + 2;
            if (leftIndex < nodes.length) {
                nodes[index].left = nodes[leftIndex];
            }
            if (rightIndex < nodes.length) {
                nodes[index].right = nodes[rightIndex];
            }
        }
        return new BinaryTree(nodes[0] ?? null);
    }

    /**
     * Root node, or `null` for an empty tree.
     */
    get root(): BinaryTreeNode<T> | null {
        return this.rootNode;
    }

    /**
     * Number of reachable nodes.
     *
     * Maintained by {@link insert} and {@link clear}. A tree built with the
     * constructor starts from a traversal count; direct edits to exposed nodes are
     * not reflected here.
     */
    get size(): number {
        return this.count;
    }

    /**
     * Number of nodes on the longest root-to-leaf path.
     *
     * Empty trees have height 0 and leaves have height 1. Computed on demand in
     * O(n) time.
     */
    get height(): number {
        if (this.rootNode === null) {
            return 0;
        }
        let maximum = 0;
        const stack: Array<{ node: BinaryTreeNode<T>; depth: number }> = [{ node: this.rootNode, depth: 1 }];
        while (stack.length > 0) {
            const frame = stack.pop();
            if (frame === undefined) {
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
     * Whether the tree contains no nodes.
     */
    get isEmpty(): boolean {
        return this.count === 0;
    }

    /**
     * Insert a value at the first missing child in level order.
     *
     * The tree therefore keeps its complete shape when it started complete; for a
     * manually built tree the search is still breadth-first, so the shallowest
     * available slot is filled first. `size` is incremented.
     *
     * @param value - Value to store.
     * @returns The newly created node.
     */
    insert(value: T): BinaryTreeNode<T> {
        const node = new BinaryTreeNode(value);
        if (this.rootNode === null) {
            this.rootNode = node;
            this.count = 1;
            return node;
        }
        const queue: BinaryTreeNode<T>[] = [this.rootNode];
        let index = 0;
        while (index < queue.length) {
            const current = queue[index];
            index += 1;
            if (current.left === null) {
                current.left = node;
                this.count += 1;
                return node;
            }
            queue.push(current.left);
            if (current.right === null) {
                current.right = node;
                this.count += 1;
                return node;
            }
            queue.push(current.right);
        }
        throw new Error("BinaryTree: no insertion point found");
    }

    /**
     * Remove every node and reset `size` to 0.
     */
    clear(): void {
        this.rootNode = null;
        this.count = 0;
    }

    /**
     * Iterate values in the requested order.
     *
     * `null` holes are skipped. The tree is traversed iteratively, so the caller
     * does not consume call-stack depth. Mutating the tree while iterating is not
     * supported.
     *
     * @param order - Traversal order; defaults to `levelorder`.
     */
    traverse(order: BinaryTreeOrder = "levelorder"): Generator<T> {
        if (order === "preorder") {
            return this.preorderValues();
        }
        if (order === "inorder") {
            return this.inorderValues();
        }
        if (order === "postorder") {
            return this.postorderValues();
        }
        return this.levelOrderValues();
    }

    /**
     * Collect values in the requested traversal order.
     *
     * @param order - Traversal order; defaults to `levelorder`.
     */
    toArray(order: BinaryTreeOrder = "levelorder"): T[] {
        return Array.from(this.traverse(order));
    }

    /**
     * Mirror the tree by swapping every left and right child.
     *
     * The shape is unchanged, so `size` and `height` stay the same. Returns the
     * tree itself for chaining.
     */
    invert(): this {
        if (this.rootNode === null) {
            return this;
        }
        const stack: BinaryTreeNode<T>[] = [this.rootNode];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node === undefined) {
                break;
            }
            const left = node.left;
            node.left = node.right;
            node.right = left;
            if (node.left !== null) {
                stack.push(node.left);
            }
            if (node.right !== null) {
                stack.push(node.right);
            }
        }
        return this;
    }

    /**
     * Whether all levels except possibly the last are full and the last level is
     * filled from the left. An empty tree is complete.
     */
    isComplete(): boolean {
        if (this.rootNode === null) {
            return true;
        }
        const queue: Array<BinaryTreeNode<T> | null> = [this.rootNode];
        let sawHole = false;
        for (let index = 0; index < queue.length; index += 1) {
            const node = queue[index];
            if (node === null) {
                sawHole = true;
                continue;
            }
            if (sawHole) {
                return false;
            }
            queue.push(node.left);
            queue.push(node.right);
        }
        return true;
    }

    /**
     * Whether every node has either zero or two children. An empty tree is full.
     */
    isFull(): boolean {
        if (this.rootNode === null) {
            return true;
        }
        const stack: BinaryTreeNode<T>[] = [this.rootNode];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node === undefined) {
                break;
            }
            const hasLeft = node.left !== null;
            const hasRight = node.right !== null;
            if (hasLeft !== hasRight) {
                return false;
            }
            if (node.left !== null) {
                stack.push(node.left);
            }
            if (node.right !== null) {
                stack.push(node.right);
            }
        }
        return true;
    }

    /**
     * Deep-copy the tree.
     *
     * Every node is recreated, so the copy shares no nodes with the original.
     * The copy's size is computed from the cloned shape.
     */
    clone(): BinaryTree<T> {
        const root = this.rootNode;
        if (root === null) {
            return new BinaryTree<T>();
        }
        const copies = new Map<BinaryTreeNode<T>, BinaryTreeNode<T>>();
        const originals: BinaryTreeNode<T>[] = [];
        const stack: BinaryTreeNode<T>[] = [root];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node === undefined) {
                break;
            }
            copies.set(node, new BinaryTreeNode(node.value));
            originals.push(node);
            if (node.left !== null) {
                stack.push(node.left);
            }
            if (node.right !== null) {
                stack.push(node.right);
            }
        }
        for (const original of originals) {
            const copy = copies.get(original);
            if (copy === undefined) {
                continue;
            }
            if (original.left !== null) {
                copy.left = copies.get(original.left) ?? null;
            }
            if (original.right !== null) {
                copy.right = copies.get(original.right) ?? null;
            }
        }
        return new BinaryTree(copies.get(root) ?? null);
    }

    /**
     * Iterate values in preorder (node, left, right).
     *
     * Equivalent to `traverse('preorder')`.
     */
    [Symbol.iterator](): Generator<T> {
        return this.preorderValues();
    }

    /**
     * Count reachable nodes without recursion.
     */
    private static countNodes<T>(root: BinaryTreeNode<T> | null): number {
        if (root === null) {
            return 0;
        }
        let count = 0;
        const stack: BinaryTreeNode<T>[] = [root];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node === undefined) {
                break;
            }
            count += 1;
            if (node.left !== null) {
                stack.push(node.left);
            }
            if (node.right !== null) {
                stack.push(node.right);
            }
        }
        return count;
    }

    private *preorderValues(): Generator<T> {
        if (this.rootNode === null) {
            return;
        }
        const stack: BinaryTreeNode<T>[] = [this.rootNode];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node === undefined) {
                break;
            }
            yield node.value;
            if (node.right !== null) {
                stack.push(node.right);
            }
            if (node.left !== null) {
                stack.push(node.left);
            }
        }
    }

    private *inorderValues(): Generator<T> {
        const stack: BinaryTreeNode<T>[] = [];
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

    private *postorderValues(): Generator<T> {
        if (this.rootNode === null) {
            return;
        }
        const stack: Array<{ node: BinaryTreeNode<T>; visited: boolean }> = [{ node: this.rootNode, visited: false }];
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
            } else {
                yield frame.node.value;
            }
        }
    }

    private *levelOrderValues(): Generator<T> {
        if (this.rootNode === null) {
            return;
        }
        const queue: BinaryTreeNode<T>[] = [this.rootNode];
        for (let index = 0; index < queue.length; index += 1) {
            const node = queue[index];
            yield node.value;
            if (node.left !== null) {
                queue.push(node.left);
            }
            if (node.right !== null) {
                queue.push(node.right);
            }
        }
    }
}
