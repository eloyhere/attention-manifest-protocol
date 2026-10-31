/**
 * Generic, language-agnostic abstract syntax tree.
 *
 * This module is not a parser. It defines a plain node shape plus traversal,
 * search, mapping, cloning, and structural comparison primitives that parsers
 * and interpreters can build on. Node payloads are opaque values owned by the
 * caller; the tree never inspects or clones them.
 *
 * Nodes and their `children` arrays are mutable by design. The class stores the
 * supplied root by reference and performs no deep validation, so manually
 * assembled nodes are accepted. The static {@link AbstractSyntaxTree.leaf} and
 * {@link AbstractSyntaxTree.branch} helpers do enforce a non-empty `kind`.
 */

/**
 * Half-open source extent for a node.
 */
export interface SourceSpan {
    /**
     * Inclusive start offset.
     */
    start: number;
    /**
     * Exclusive end offset.
     */
    end: number;
    /**
     * Optional source identifier or text.
     */
    source?: string;
}

/**
 * A node in an AST.
 *
 * `children` is intentionally mutable; replace a tree with `clone()` or
 * `map()` when an immutable copy is needed.
 *
 * @typeParam T - Value payload stored on nodes.
 */
export interface AstNode<T = unknown> {
    /**
     * Node category. The helpers require a non-empty string.
     */
    kind: string;
    /**
     * Optional payload; ignored by traversal.
     */
    value?: T;
    /**
     * Direct children, in semantic order.
     */
    children: AstNode<T>[];
    /**
     * Optional source extent.
     */
    span?: SourceSpan;
}

/**
 * Traversal order supported by {@link AbstractSyntaxTree.walk}.
 */
export type AstOrder = "preorder" | "postorder" | "levelorder";

/**
 * Predicate used by {@link AbstractSyntaxTree.find} and `findAll`.
 */
export type AstPredicate<T> = (node: AstNode<T>) => boolean;

/**
 * Post-order mapping callback.
 *
 * `children` contains the already transformed children in their original
 * order. The returned node becomes the mapped counterpart of `node`.
 */
export type AstTransform<T, U> = (node: AstNode<T>, children: AstNode<U>[]) => AstNode<U>;

/**
 * Throw unless `kind` is a non-empty string.
 */
function assertKind(kind: string): void {
    if (typeof(kind) !== "string" || kind.length === 0) {
        throw new TypeError("kind must be a non-empty string");
    }
}

/**
 * Build a plain node, omitting absent optional fields.
 */
function makeNode<T>(kind: string, children: AstNode<T>[], value?: T, span?: SourceSpan): AstNode<T> {
    const node: AstNode<T> = { kind, children };
    if (value !== (void 0)) {
        node.value = value;
    }
    if (span !== (void 0)) {
        node.span = span;
    }
    return node;
}

/**
 * Copy a span into a fresh plain object.
 */
function copySpan(span: SourceSpan): SourceSpan {
    const copy: SourceSpan = { start: span.start, end: span.end };
    if ("source" in span) {
        copy.source = span.source;
    }
    return copy;
}

/**
 * Deep-copy nodes and spans, preserving value references.
 *
 * Iterative and memoized by node identity so tall trees do not consume the
 * call stack and shared subtrees stay shared.
 */
function cloneNode<T>(root: AstNode<T>): AstNode<T> {
    const copies = new WeakMap<AstNode<T>, AstNode<T>>();
    const originals: AstNode<T>[] = [];
    const pending: AstNode<T>[] = [root];

    while (pending.length > 0) {
        const node = pending.pop();
        if (node === (void 0) || copies.has(node)) {
            continue;
        }

        const copy: AstNode<T> = { kind: node.kind, children: [] };
        if ("value" in node) {
            copy.value = node.value;
        }
        if (node.span !== (void 0)) {
            copy.span = copySpan(node.span);
        }
        copies.set(node, copy);
        originals.push(node);
        for (const child of node.children) {
            pending.push(child);
        }
    }

    for (const node of originals) {
        const copy = copies.get(node);
        if (copy === (void 0)) {
            continue;
        }
        for (const child of node.children) {
            const childCopy = copies.get(child);
            if (childCopy !== (void 0)) {
                copy.children.push(childCopy);
            }
        }
    }

    const rootCopy = copies.get(root);
    if (rootCopy === (void 0)) {
        throw new Error("failed to clone the AST root");
    }
    return rootCopy;
}

/**
 * Compare optional spans field by field, using SameValue semantics.
 */
function spansEqual(left: SourceSpan | undefined, right: SourceSpan | undefined): boolean {
    if (left === (void 0) || right === (void 0)) {
        return left === right;
    }
    return Object.is(left.start, right.start) && Object.is(left.end, right.end) && Object.is(left.source, right.source);
}

/**
 * A mutable-rooted tree with non-mutating traversal and transformation helpers.
 *
 * The constructor accepts an arbitrary node value and stores it by reference.
 * It does not inspect the subtree, so callers that build nodes manually are
 * responsible for maintaining the {@link AstNode} shape.
 *
 * @typeParam T - Value payload stored on nodes.
 */
export class AbstractSyntaxTree<T> implements Iterable<AstNode<T>> {
    private readonly rootNode: AstNode<T>;

    /**
     * Wrap an existing root node.
     *
     * @param root - Root node, stored by reference.
     */
    constructor(root: AstNode<T>) {
        this.rootNode = root;
    }

    /**
     * Create a tree with one leaf node.
     *
     * @param kind - Non-empty node category.
     * @param value - Optional leaf payload.
     * @param span - Optional source extent.
     * @throws TypeError if `kind` is not a non-empty string.
     */
    static leaf<T>(kind: string, value?: T, span?: SourceSpan): AbstractSyntaxTree<T> {
        assertKind(kind);
        return new AbstractSyntaxTree<T>(makeNode(kind, [], value, span));
    }

    /**
     * Create a tree with one branch node and the supplied children.
     *
     * The children iterable is copied into a new mutable array.
     *
     * @param kind - Non-empty node category.
     * @param children - Direct children, in order.
     * @param value - Optional branch payload.
     * @param span - Optional source extent.
     * @throws TypeError if `kind` is not a non-empty string.
     */
    static branch<T>(kind: string, children: Iterable<AstNode<T>>, value?: T, span?: SourceSpan): AbstractSyntaxTree<T> {
        assertKind(kind);
        return new AbstractSyntaxTree<T>(makeNode(kind, [...children], value, span));
    }

    /**
     * The stored root node, by reference.
     */
    get root(): AstNode<T> {
        return this.rootNode;
    }

    /**
     * Total node count, recomputed on demand because children are mutable.
     */
    get size(): number {
        const iterator = this.walk();
        let count = 0;
        while (!iterator.next().done) {
            count += 1;
        }
        return count;
    }

    /**
     * Number of nodes on the longest root-to-leaf path; a leaf has height 1.
     */
    get height(): number {
        let maximum = 0;
        const stack: Array<{ node: AstNode<T>; depth: number }> = [{ node: this.rootNode, depth: 1 }];
        while (stack.length > 0) {
            const frame = stack.pop();
            if (frame === (void 0)) {
                break;
            }
            if (frame.depth > maximum) {
                maximum = frame.depth;
            }
            for (const child of frame.node.children) {
                stack.push({ node: child, depth: frame.depth + 1 });
            }
        }
        return maximum;
    }

    /**
     * Number of nodes with no children.
     */
    get leaves(): number {
        let count = 0;
        const stack: AstNode<T>[] = [this.rootNode];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node === (void 0)) {
                break;
            }
            if (node.children.length === 0) {
                count += 1;
            } else {
                for (const child of node.children) {
                    stack.push(child);
                }
            }
        }
        return count;
    }

    /**
     * Walk the tree in the requested order.
     *
     * Preorder and postorder visit children left-to-right. Level order visits
     * nodes breadth-first, also left-to-right within each level.
     *
     * @param order - Traversal order; defaults to `'preorder'`.
     * @throws RangeError if `order` is not a supported traversal name.
     */
    *walk(order: AstOrder = "preorder"): Generator<AstNode<T>> {
        switch (order) {
            case "preorder": {
                const stack: AstNode<T>[] = [this.rootNode];
                while (stack.length > 0) {
                    const node = stack.pop();
                    if (node === (void 0)) {
                        break;
                    }
                    yield node;
                    for (let index = node.children.length - 1; index >= 0; index -= 1) {
                        const child = node.children[index];
                        if (child !== (void 0)) {
                            stack.push(child);
                        }
                    }
                }
                return;
            }
            case "postorder": {
                const stack: Array<{ node: AstNode<T>; expanded: boolean }> = [{ node: this.rootNode, expanded: false }];
                while (stack.length > 0) {
                    const frame = stack.pop();
                    if (frame === (void 0)) {
                        break;
                    }
                    if (frame.expanded) {
                        yield frame.node;
                        continue;
                    }
                    stack.push({ node: frame.node, expanded: true });
                    for (let index = frame.node.children.length - 1; index >= 0; index -= 1) {
                        const child = frame.node.children[index];
                        if (child !== (void 0)) {
                            stack.push({ node: child, expanded: false });
                        }
                    }
                }
                return;
            }
            case "levelorder": {
                const queue: AstNode<T>[] = [this.rootNode];
                let next = 0;
                while (next < queue.length) {
                    const node = queue[next];
                    next += 1;
                    if (node === (void 0)) {
                        continue;
                    }
                    yield node;
                    for (const child of node.children) {
                        queue.push(child);
                    }
                }
                return;
            }
            default:
                throw new RangeError(`unknown AST traversal order: ${`${order}`}`);
        }
    }

    /**
     * Return the first node in preorder that satisfies `predicate`.
     *
     * @param predicate - Test applied to each node.
     */
    find(predicate: AstPredicate<T>): AstNode<T> | undefined {
        for (const node of this.walk("preorder")) {
            if (predicate(node)) {
                return node;
            }
        }
        return undefined;
    }

    /**
     * Return every node that satisfies `predicate`, in preorder.
     *
     * @param predicate - Test applied to each node.
     */
    findAll(predicate: AstPredicate<T>): AstNode<T>[] {
        const matches: AstNode<T>[] = [];
        for (const node of this.walk("preorder")) {
            if (predicate(node)) {
                matches.push(node);
            }
        }
        return matches;
    }

    /**
     * Transform every node bottom-up into a new tree.
     *
     * For each original node, `transform` receives that original node and its
     * already mapped children, in order. The original tree is never modified.
     *
     * @param transform - Post-order mapping callback.
     * @typeParam U - Value payload type of the mapped tree.
     */
    map<U>(transform: AstTransform<T, U>): AbstractSyntaxTree<U> {
        const mapped = new WeakMap<AstNode<T>, AstNode<U>>();
        const stack: Array<{ node: AstNode<T>; nextChild: number }> = [{ node: this.rootNode, nextChild: 0 }];

        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            if (frame === (void 0)) {
                break;
            }

            if (frame.nextChild < frame.node.children.length) {
                const child = frame.node.children[frame.nextChild];
                frame.nextChild += 1;
                stack.push({ node: child, nextChild: 0 });
                continue;
            }

            const children: AstNode<U>[] = [];
            for (const child of frame.node.children) {
                const mappedChild = mapped.get(child);
                if (mappedChild === (void 0)) {
                    throw new Error("cannot map an AST child before it has been visited");
                }
                children.push(mappedChild);
            }
            mapped.set(frame.node, transform(frame.node, children));
            stack.pop();
        }

        const mappedRoot = mapped.get(this.rootNode);
        if (mappedRoot === (void 0)) {
            throw new Error("AST mapping produced no root");
        }
        return new AbstractSyntaxTree<U>(mappedRoot);
    }

    /**
     * Deep-copy all nodes, child arrays, and spans.
     *
     * Payload values are copied by reference.
     */
    clone(): AbstractSyntaxTree<T> {
        return new AbstractSyntaxTree<T>(cloneNode(this.rootNode));
    }

    /**
     * Compare kinds, values (`Object.is`), spans, and ordered children.
     *
     * @param other - Tree to compare against.
     */
    equals(other: AbstractSyntaxTree<T>): boolean {
        const stack: Array<[AstNode<T>, AstNode<T>]> = [[this.rootNode, other.rootNode]];
        while (stack.length > 0) {
            const pair = stack.pop();
            if (pair === (void 0)) {
                break;
            }
            const [left, right] = pair;

            if (left.kind !== right.kind) {
                return false;
            }
            if (!Object.is(left.value, right.value)) {
                return false;
            }
            if (!spansEqual(left.span, right.span)) {
                return false;
            }
            if (left.children.length !== right.children.length) {
                return false;
            }

            for (let index = 0; index < left.children.length; index += 1) {
                const leftChild = left.children[index];
                const rightChild = right.children[index];
                if (leftChild === (void 0) || rightChild === (void 0)) {
                    return false;
                }
                stack.push([leftChild, rightChild]);
            }
        }
        return true;
    }

    /**
     * Return a plain deep clone suitable for serialization.
     *
     * Node and span objects are freshly allocated and contain no class
     * instances. Payload values are copied by reference, as with `clone()`.
     */
    toJSON(): AstNode<T> {
        return cloneNode(this.rootNode);
    }

    /**
     * Iterate in preorder; equivalent to `walk('preorder')`.
     */
    [Symbol.iterator](): Generator<AstNode<T>> {
        return this.walk("preorder");
    }
}
