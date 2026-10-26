#!/usr/bin/env node
/**
 * Tree structure checks.
 *
 * Covers the unordered binary tree, the unbalanced BST, the AVL tree and the
 * red-black tree. Randomised runs use a deterministic 32-bit LCG so every run
 * produces the same sequence, and every search tree is compared against a
 * native `Set` (plus a maintained sorted array where ordering is checked).
 */
import assert from "node:assert/strict";

import { AVLTree } from "../src/structure/avlTree.ts";
import { BinarySearchTree } from "../src/structure/binarySearchTree.ts";
import { BinaryTree, BinaryTreeNode } from "../src/structure/binaryTree.ts";
import type { Comparator } from "../src/structure/compare.ts";
import { byKey, reverseComparator } from "../src/structure/compare.ts";
import { RedBlackTree } from "../src/structure/redBlackTree.ts";

interface Task {
    id: number;
    title: string;
}

/**
 * The subset of the search-tree API the shared comparator checks need.
 */
interface OrderedTreeLike<T> {
    insert(value: T): boolean;
    has(value: T): boolean;
    delete(value: T): boolean;
    toArray(): T[];
    validate(): string[];
    min(): T | undefined;
    max(): T | undefined;
}

type PlainRow = {
    id: number;
};

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, body: () => void) => void = (name: string, body: () => void): void => {
    try {
        body();
        Passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        Failed += 1;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

/**
 * Deterministic 32-bit linear congruential generator.
 */
const createRandom: (seed: number) => () => number = (seed: number): (() => number) => {
    let state: number = seed >>> 0;
    return (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };
};

const randomInt: (random: () => number, bound: number) => number = (random: () => number, bound: number): number => Math.floor(random() * bound);

/**
 * First index whose value is >= `value`.
 */
const lowerBound: (values: number[], value: number) => number = (values: number[], value: number): number => {
    let low: number = 0;
    let high: number = values.length;
    while (low < high) {
        const middle: number = (low + high) >>> 1;
        if (values[middle] < value) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
};

const insertSorted: (values: number[], value: number) => void = (values: number[], value: number): void => {
    const index: number = lowerBound(values, value);
    if (values[index] === value) {
        return;
    }
    values.splice(index, 0, value);
};

const removeSorted: (values: number[], value: number) => void = (values: number[], value: number): void => {
    const index: number = lowerBound(values, value);
    if (values[index] === value) {
        values.splice(index, 1);
    }
};

const expectedFloor: (values: number[], value: number) => number | undefined = (values: number[], value: number): number | undefined => {
    const index: number = lowerBound(values, value);
    if (values[index] === value) {
        return value;
    }
    return index === 0 ? undefined : values[index - 1];
};

const expectedCeil: (values: number[], value: number) => number | undefined = (values: number[], value: number): number | undefined => {
    const index: number = lowerBound(values, value);
    return index === values.length ? undefined : values[index];
};

test("BinaryTree: empty-tree operations", () => {
    const tree: BinaryTree<number> = new BinaryTree<number>();
    assert.equal(tree.size, 0);
    assert.equal(tree.height, 0);
    assert.equal(tree.isEmpty, true);
    assert.equal(tree.root, null);
    assert.deepEqual(tree.toArray(), []);
    assert.deepEqual(tree.toArray("preorder"), []);
    assert.deepEqual([...tree], []);
    assert.equal(tree.traverse().next().done, true);
    assert.equal(tree.isComplete(), true);
    assert.equal(tree.isFull(), true);

    const copy: BinaryTree<number> = tree.clone();
    assert.equal(copy.size, 0);
    assert.equal(copy.root, null);
    assert.equal(tree.invert(), tree);
    tree.clear();
    assert.equal(tree.size, 0);

    assert.equal(BinaryTree.fromLevelOrder<number>([null, null]).isEmpty, true);
    assert.equal(BinaryTree.fromArray<number>([]).isEmpty, true);
});

test("BinaryTree: level-order construction", () => {
    const tree: BinaryTree<number> = BinaryTree.fromLevelOrder([1, 2, 3, null, 4, null, 5]);
    assert.equal(tree.size, 5);
    assert.equal(tree.height, 3);
    assert.deepEqual(tree.toArray(), [1, 2, 3, 4, 5]);
    assert.deepEqual(tree.toArray("preorder"), [1, 2, 4, 3, 5]);
    assert.deepEqual(tree.toArray("inorder"), [2, 4, 1, 3, 5]);
    assert.deepEqual(tree.toArray("postorder"), [4, 2, 5, 3, 1]);
    assert.equal(tree.isComplete(), false);
    assert.equal(tree.isFull(), false);

    const trailing: BinaryTree<number> = BinaryTree.fromLevelOrder([1, 2, 3, null, null, null]);
    assert.equal(trailing.size, 3);
    assert.equal(trailing.height, 2);
    assert.deepEqual(trailing.toArray(), [1, 2, 3]);
    assert.equal(trailing.isComplete(), true);
    assert.equal(trailing.isFull(), true);

    const complete: BinaryTree<number> = BinaryTree.fromArray([1, 2, 3, 4, 5]);
    assert.equal(complete.size, 5);
    assert.equal(complete.height, 3);
    assert.deepEqual(complete.toArray(), [1, 2, 3, 4, 5]);
    assert.equal(complete.isComplete(), true);
    assert.equal(complete.isFull(), true);

    const almost: BinaryTree<number> = BinaryTree.fromArray([1, 2, 3, 4]);
    assert.equal(almost.isComplete(), true);
    assert.equal(almost.isFull(), false);
});

test("BinaryTree: every traversal order", () => {
    const tree: BinaryTree<number> = BinaryTree.fromArray([1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(tree.toArray(), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(tree.toArray("preorder"), [1, 2, 4, 5, 3, 6, 7]);
    assert.deepEqual(tree.toArray("inorder"), [4, 2, 5, 1, 6, 3, 7]);
    assert.deepEqual(tree.toArray("postorder"), [4, 5, 2, 6, 7, 3, 1]);
    assert.deepEqual([...tree.traverse("levelorder")], [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual([...tree], [1, 2, 4, 5, 3, 6, 7]);
    assert.equal(tree.size, 7);
    assert.equal(tree.height, 3);
    assert.equal(tree.isComplete(), true);
    assert.equal(tree.isFull(), true);
});

test("BinaryTree: insert fills the first missing level-order slot", () => {
    const tree: BinaryTree<number> = new BinaryTree<number>();
    const root: BinaryTreeNode<number> = tree.insert(1);
    assert.equal(tree.root, root);
    tree.insert(2);
    const third: BinaryTreeNode<number> = tree.insert(3);
    tree.insert(4);
    tree.insert(5);
    assert.equal(tree.size, 5);
    assert.deepEqual(tree.toArray(), [1, 2, 3, 4, 5]);
    assert.equal(tree.height, 3);
    assert.equal(tree.isComplete(), true);
    assert.equal(tree.isFull(), true);

    const sixth: BinaryTreeNode<number> = tree.insert(6);
    assert.equal(third.left, sixth);
    assert.deepEqual(tree.toArray(), [1, 2, 3, 4, 5, 6]);
    assert.equal(tree.isComplete(), true);
    assert.equal(tree.isFull(), false);

    tree.insert(7);
    assert.deepEqual(tree.toArray(), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(tree.isComplete(), true);
    assert.equal(tree.isFull(), true);

    const manualRoot: BinaryTreeNode<number> = new BinaryTreeNode(1);
    manualRoot.left = new BinaryTreeNode(2);
    const manual: BinaryTree<number> = new BinaryTree(manualRoot);
    assert.equal(manual.size, 2);
    const manualThird: BinaryTreeNode<number> = manual.insert(3);
    assert.equal(manualRoot.right, manualThird);
    const manualFourth: BinaryTreeNode<number> = manual.insert(4);
    assert.equal(manualRoot.left.left, manualFourth);
    assert.equal(manual.size, 4);
    assert.deepEqual(manual.toArray(), [1, 2, 3, 4]);
});

test("BinaryTree: invert mirrors the shape in place", () => {
    const tree: BinaryTree<number> = BinaryTree.fromArray([1, 2, 3, 4, 5]);
    assert.equal(tree.invert(), tree);
    assert.deepEqual(tree.toArray(), [1, 3, 2, 5, 4]);
    assert.deepEqual(tree.toArray("preorder"), [1, 3, 2, 5, 4]);
    assert.equal(tree.size, 5);
    assert.equal(tree.height, 3);
    assert.equal(tree.isComplete(), false);
    assert.equal(tree.isFull(), true);

    tree.invert();
    assert.deepEqual(tree.toArray(), [1, 2, 3, 4, 5]);
    assert.deepEqual(tree.toArray("preorder"), [1, 2, 4, 5, 3]);
    assert.equal(tree.isComplete(), true);
});

test("BinaryTree: clone is a deep, independent copy", () => {
    const original: BinaryTree<number> = BinaryTree.fromLevelOrder([1, 2, null, 3]);
    const copy: BinaryTree<number> = original.clone();
    assert.notEqual(copy.root, original.root);
    assert.notEqual(copy.root?.left, original.root?.left);
    assert.deepEqual(copy.toArray(), original.toArray());
    assert.equal(copy.size, 3);

    const copyRoot: BinaryTreeNode<number> | null = copy.root;
    const originalRoot: BinaryTreeNode<number> | null = original.root;
    assert.ok(copyRoot !== null && originalRoot !== null);
    copyRoot.value = 99;
    if (copyRoot.left !== null) {
        copyRoot.left.value = 98;
    }
    assert.equal(originalRoot.value, 1);
    assert.equal(originalRoot.left?.value, 2);
    assert.deepEqual(original.toArray("preorder"), [1, 2, 3]);

    copy.insert(4);
    assert.equal(copy.size, 4);
    assert.equal(original.size, 3);
});

test("BinaryTree: constructor counts manual nodes and clear resets", () => {
    const root: BinaryTreeNode<number> = new BinaryTreeNode(1, new BinaryTreeNode(2), new BinaryTreeNode(3));
    const tree: BinaryTree<number> = new BinaryTree(root);
    assert.equal(tree.size, 3);
    assert.equal(tree.height, 2);
    assert.deepEqual(tree.toArray(), [1, 2, 3]);
    assert.equal(tree.isComplete(), true);
    assert.equal(tree.isFull(), true);

    tree.clear();
    assert.equal(tree.size, 0);
    assert.equal(tree.height, 0);
    assert.equal(tree.root, null);

    const leaf: BinaryTree<string> = new BinaryTree(new BinaryTreeNode("only"));
    assert.equal(leaf.size, 1);
    assert.equal(leaf.height, 1);
    assert.equal(leaf.isComplete(), true);
    assert.equal(leaf.isFull(), true);
});

test("BinarySearchTree: ordering, duplicates, bounds and iteration", () => {
    const tree: BinarySearchTree<number> = new BinarySearchTree<number>();
    const values: number[] = [50, 30, 70, 20, 40, 60, 80, 35, 45, 65];
    for (let index: number = 0; index < values.length; index += 1) {
        const value: number = values[index];
        assert.equal(tree.insert(value), true);
    }

    assert.equal(tree.size, 10);
    assert.equal(tree.height, 4);
    assert.equal(tree.isEmpty, false);
    assert.deepEqual(tree.toArray(), [20, 30, 35, 40, 45, 50, 60, 65, 70, 80]);
    assert.deepEqual([...tree], tree.toArray());
    assert.equal(tree.has(35), true);
    assert.equal(tree.has(36), false);
    assert.equal(tree.min(), 20);
    assert.equal(tree.max(), 80);
    assert.equal(tree.insert(50), false);
    assert.equal(tree.size, 10);
    assert.deepEqual(tree.validate(), []);

    assert.equal(tree.floor(50), 50);
    assert.equal(tree.floor(55), 50);
    assert.equal(tree.floor(19), undefined);
    assert.equal(tree.floor(80), 80);
    assert.equal(tree.floor(100), 80);
    assert.equal(tree.ceil(50), 50);
    assert.equal(tree.ceil(55), 60);
    assert.equal(tree.ceil(19), 20);
    assert.equal(tree.ceil(80), 80);
    assert.equal(tree.ceil(81), undefined);
});

test("BinarySearchTree: delete handles zero, one and two children", () => {
    const leafTree: BinarySearchTree<number> = new BinarySearchTree<number>();
    const leafValues: number[] = [50, 30, 70, 20];
    for (let index: number = 0; index < leafValues.length; index += 1) {
        leafTree.insert(leafValues[index]);
    }
    assert.equal(leafTree.delete(20), true);
    assert.equal(leafTree.delete(20), false);
    assert.equal(leafTree.has(20), false);
    assert.deepEqual(leafTree.toArray(), [30, 50, 70]);
    assert.deepEqual(leafTree.validate(), []);

    const oneChildTree: BinarySearchTree<number> = new BinarySearchTree<number>();
    const oneChildValues: number[] = [50, 30, 70, 20];
    for (let index: number = 0; index < oneChildValues.length; index += 1) {
        oneChildTree.insert(oneChildValues[index]);
    }
    assert.equal(oneChildTree.delete(30), true);
    assert.deepEqual(oneChildTree.toArray(), [20, 50, 70]);
    assert.deepEqual(oneChildTree.validate(), []);

    const twoChildTree: BinarySearchTree<number> = new BinarySearchTree<number>();
    const twoChildValues: number[] = [50, 30, 70, 20, 40, 60, 80, 35, 45, 65];
    for (let index: number = 0; index < twoChildValues.length; index += 1) {
        twoChildTree.insert(twoChildValues[index]);
    }
    assert.equal(twoChildTree.delete(50), true);
    assert.equal(twoChildTree.delete(999), false);
    assert.deepEqual(twoChildTree.toArray(), [20, 30, 35, 40, 45, 60, 65, 70, 80]);
    assert.equal(twoChildTree.size, 9);
    assert.deepEqual(twoChildTree.validate(), []);
});

test("BinarySearchTree: empty tree and invalid values", () => {
    const tree: BinarySearchTree<number> = new BinarySearchTree<number>();
    assert.equal(tree.size, 0);
    assert.equal(tree.height, 0);
    assert.equal(tree.isEmpty, true);
    assert.deepEqual(tree.toArray(), []);
    assert.deepEqual([...tree], []);
    assert.equal(tree.has(1), false);
    assert.equal(tree.delete(1), false);
    assert.equal(tree.min(), undefined);
    assert.equal(tree.max(), undefined);
    assert.equal(tree.floor(1), undefined);
    assert.equal(tree.ceil(1), undefined);
    assert.deepEqual(tree.validate(), []);

    assert.equal(tree.insert(5), true);
    assert.equal(tree.height, 1);
    assert.equal(tree.min(), 5);
    assert.equal(tree.max(), 5);
    assert.equal(tree.delete(5), true);
    assert.equal(tree.isEmpty, true);

    const invalid: BinarySearchTree<number> = new BinarySearchTree<number>();
    invalid.insert(1);
    assert.throws(() => invalid.insert(Number.NaN), /NaN/);
    assert.throws(() => invalid.has(Number.NaN), /NaN/);
    assert.equal(invalid.size, 1);

    const objectTree: BinarySearchTree<PlainRow> = new BinarySearchTree<PlainRow>();
    objectTree.insert({ id: 1 });
    assert.throws(() => objectTree.insert({ id: 2 }), /no natural ordering/);
});

test("BinarySearchTree: randomized operations against Set", () => {
    const random: () => number = createRandom(0x5157);
    const tree: BinarySearchTree<number> = new BinarySearchTree<number>();
    const expected: Set<number> = new Set<number>();

    for (let step: number = 0; step < 3000; step += 1) {
        const value: number = randomInt(random, 200);
        if (random() < 0.55) {
            const inserted: boolean = !expected.has(value);
            assert.equal(tree.insert(value), inserted);
            expected.add(value);
        } else {
            const removed: boolean = expected.delete(value);
            assert.equal(tree.delete(value), removed);
        }
        assert.equal(tree.size, expected.size);
        if (step % 250 === 0) {
            assert.deepEqual(tree.validate(), [], `validate failed at step ${step}`);
        }
    }

    assert.deepEqual(
        tree.toArray(),
        [...expected].sort((left, right) => left - right),
    );
    assert.deepEqual(tree.validate(), []);
});

test("AVLTree: empty tree and invalid values", () => {
    const tree: AVLTree<number> = new AVLTree<number>();
    assert.equal(tree.size, 0);
    assert.equal(tree.height, 0);
    assert.equal(tree.isEmpty, true);
    assert.deepEqual(tree.toArray(), []);
    assert.deepEqual([...tree], []);
    assert.equal(tree.has(1), false);
    assert.equal(tree.delete(1), false);
    assert.equal(tree.min(), undefined);
    assert.equal(tree.max(), undefined);
    assert.equal(tree.floor(1), undefined);
    assert.equal(tree.ceil(1), undefined);
    assert.deepEqual(tree.validate(), []);

    assert.equal(tree.insert(5), true);
    assert.equal(tree.height, 1);
    tree.clear();
    assert.equal(tree.size, 0);
    assert.equal(tree.height, 0);

    const invalid: AVLTree<number> = new AVLTree<number>();
    invalid.insert(1);
    assert.throws(() => invalid.insert(Number.NaN), /NaN/);
    assert.throws(() => invalid.has(Number.NaN), /NaN/);
});

test("AVLTree: basic operations and rebalancing delete", () => {
    const tree: AVLTree<number> = new AVLTree<number>();
    const insertValues: number[] = [10, 20, 30, 40, 50, 25];
    for (let index: number = 0; index < insertValues.length; index += 1) {
        tree.insert(insertValues[index]);
    }
    assert.equal(tree.size, 6);
    assert.equal(tree.height, 3);
    assert.deepEqual(tree.toArray(), [10, 20, 25, 30, 40, 50]);
    assert.equal(tree.min(), 10);
    assert.equal(tree.max(), 50);
    assert.equal(tree.has(25), true);
    assert.equal(tree.has(26), false);
    assert.equal(tree.insert(25), false);
    assert.equal(tree.size, 6);
    assert.deepEqual(tree.validate(), []);

    assert.equal(tree.floor(26), 25);
    assert.equal(tree.floor(9), undefined);
    assert.equal(tree.ceil(26), 30);
    assert.equal(tree.ceil(51), undefined);

    assert.equal(tree.delete(40), true);
    assert.equal(tree.delete(40), false);
    assert.deepEqual(tree.toArray(), [10, 20, 25, 30, 50]);
    assert.deepEqual(tree.validate(), []);
});

test("AVLTree: sorted insertion stays logarithmic", () => {
    const count: number = 4095;
    const tree: AVLTree<number> = new AVLTree<number>();
    for (let value: number = 0; value < count; value += 1) {
        tree.insert(value);
    }

    assert.equal(tree.size, count);
    assert.deepEqual(tree.validate(), []);
    const limit: number = 2 * Math.log2(count + 1);
    assert.ok(tree.height <= limit, `sorted AVL height ${tree.height} exceeds logarithmic limit ${limit}`);
    assert.equal(tree.min(), 0);
    assert.equal(tree.max(), count - 1);
    assert.equal(tree.toArray().length, count);

    for (let value: number = 0; value < count; value += 2) {
        assert.equal(tree.delete(value), true);
        if (value % 500 === 0) {
            assert.deepEqual(tree.validate(), [], `validate failed after deleting ${value}`);
        }
    }
    assert.equal(tree.size, 2047);
    assert.deepEqual(tree.validate(), []);
});

test("AVLTree: 10000 randomized operations against Set and sorted array", () => {
    const random: () => number = createRandom(0xa711);
    const tree: AVLTree<number> = new AVLTree<number>();
    const expected: Set<number> = new Set<number>();
    const sorted: number[] = [];

    for (let step: number = 0; step < 10000; step += 1) {
        const value: number = randomInt(random, 2000);
        if (random() < 0.55) {
            const inserted: boolean = !expected.has(value);
            assert.equal(tree.insert(value), inserted);
            if (inserted) {
                expected.add(value);
                insertSorted(sorted, value);
            }
        } else {
            const removed: boolean = expected.delete(value);
            assert.equal(tree.delete(value), removed);
            if (removed) {
                removeSorted(sorted, value);
            }
        }
        assert.equal(tree.size, expected.size);

        if (step % 500 === 0) {
            assert.deepEqual(tree.validate(), [], `validate failed at step ${step}`);
            assert.deepEqual(tree.toArray(), sorted);
            assert.equal(tree.has(value), expected.has(value));
            const probe: number = randomInt(random, 2100);
            assert.equal(tree.floor(probe), expectedFloor(sorted, probe));
            assert.equal(tree.ceil(probe), expectedCeil(sorted, probe));
            if (sorted.length > 0) {
                assert.equal(tree.min(), sorted[0]);
                assert.equal(tree.max(), sorted[sorted.length - 1]);
            }
        }
    }

    assert.deepEqual(tree.validate(), []);
    assert.deepEqual(tree.toArray(), sorted);
    assert.deepEqual(
        tree.toArray(),
        [...expected].sort((left, right) => left - right),
    );

    const remaining: number[] = [...expected];
    for (let index: number = 0; index < remaining.length; index += 1) {
        assert.equal(tree.delete(remaining[index]), true);
        if (index % 250 === 0) {
            assert.deepEqual(tree.validate(), [], `validate failed while draining index ${index}`);
        }
    }
    assert.equal(tree.size, 0);
    assert.equal(tree.isEmpty, true);
    assert.deepEqual(tree.toArray(), []);
    assert.deepEqual(tree.validate(), []);
});

test("RedBlackTree: empty tree and invalid values", () => {
    const tree: RedBlackTree<number> = new RedBlackTree<number>();
    assert.equal(tree.size, 0);
    assert.equal(tree.height, 0);
    assert.equal(tree.isEmpty, true);
    assert.deepEqual(tree.toArray(), []);
    assert.deepEqual([...tree], []);
    assert.equal(tree.has(1), false);
    assert.equal(tree.delete(1), false);
    assert.equal(tree.min(), undefined);
    assert.equal(tree.max(), undefined);
    assert.equal(tree.floor(1), undefined);
    assert.equal(tree.ceil(1), undefined);
    assert.deepEqual(tree.validate(), []);

    assert.equal(tree.insert(5), true);
    assert.equal(tree.height, 1);
    tree.clear();
    assert.equal(tree.size, 0);
    assert.equal(tree.height, 0);

    const invalid: RedBlackTree<number> = new RedBlackTree<number>();
    invalid.insert(1);
    assert.throws(() => invalid.insert(Number.NaN), /NaN/);
    assert.throws(() => invalid.has(Number.NaN), /NaN/);
});

test("RedBlackTree: delete root, leaf and one-child nodes", () => {
    const tree: RedBlackTree<number> = new RedBlackTree<number>();
    const insertValues: number[] = [20, 10, 30, 5, 15, 25, 35];
    for (let index: number = 0; index < insertValues.length; index += 1) {
        tree.insert(insertValues[index]);
    }
    assert.equal(tree.size, 7);
    assert.equal(tree.height, 3);
    assert.deepEqual(tree.toArray(), [5, 10, 15, 20, 25, 30, 35]);
    assert.deepEqual(tree.validate(), []);
    assert.equal(tree.min(), 5);
    assert.equal(tree.max(), 35);
    assert.equal(tree.has(25), true);
    assert.equal(tree.insert(20), false);
    assert.equal(tree.floor(22), 20);
    assert.equal(tree.ceil(22), 25);

    /**
     * The first inserted value is still the root: two-child deletion.
     */
    assert.equal(tree.delete(20), true);
    assert.equal(tree.has(20), false);
    assert.deepEqual(tree.toArray(), [5, 10, 15, 25, 30, 35]);
    assert.equal(tree.size, 6);
    assert.deepEqual(tree.validate(), []);

    /**
     * A red leaf.
     */
    assert.equal(tree.delete(5), true);
    assert.deepEqual(tree.toArray(), [10, 15, 25, 30, 35]);
    assert.equal(tree.size, 5);
    assert.deepEqual(tree.validate(), []);

    const oneChild: RedBlackTree<number> = new RedBlackTree<number>();
    const oneChildValues: number[] = [20, 10, 30, 5];
    for (let index: number = 0; index < oneChildValues.length; index += 1) {
        oneChild.insert(oneChildValues[index]);
    }
    assert.equal(oneChild.delete(10), true);
    assert.deepEqual(oneChild.toArray(), [5, 20, 30]);
    assert.deepEqual(oneChild.validate(), []);

    const single: RedBlackTree<number> = new RedBlackTree<number>();
    single.insert(42);
    assert.equal(single.delete(42), true);
    assert.equal(single.size, 0);
    assert.deepEqual(single.toArray(), []);
    assert.deepEqual(single.validate(), []);

    assert.equal(tree.delete(999), false);
});

test("RedBlackTree: insertion rotation shapes", () => {
    const sequences: number[][] = [
        [30, 20, 10],
        [30, 10, 20],
        [10, 20, 30],
        [10, 30, 20],
    ];
    for (let index: number = 0; index < sequences.length; index += 1) {
        const sequence: number[] = sequences[index];
        const tree: RedBlackTree<number> = new RedBlackTree<number>();
        for (let position: number = 0; position < sequence.length; position += 1) {
            assert.equal(tree.insert(sequence[position]), true);
        }
        assert.deepEqual(tree.toArray(), [10, 20, 30]);
        assert.equal(tree.height, 2);
        assert.deepEqual(tree.validate(), []);
    }
});

test("RedBlackTree: sorted insertion and deletion stay balanced", () => {
    const count: number = 4095;
    const tree: RedBlackTree<number> = new RedBlackTree<number>();
    for (let value: number = 0; value < count; value += 1) {
        tree.insert(value);
    }

    assert.equal(tree.size, count);
    assert.deepEqual(tree.validate(), []);
    const limit: number = 2 * Math.log2(count + 1);
    assert.ok(tree.height <= limit, `sorted red-black height ${tree.height} exceeds logarithmic limit ${limit}`);

    let deleted: number = 0;
    for (let value: number = 0; value < count; value += 3) {
        assert.equal(tree.delete(value), true);
        deleted += 1;
        if (deleted % 250 === 0) {
            assert.deepEqual(tree.validate(), [], `validate failed after ${deleted} deletes`);
        }
    }
    assert.equal(tree.size, count - deleted);
    assert.deepEqual(tree.validate(), []);

    const surviving: number[] = [];
    for (let value: number = 0; value < count; value += 1) {
        if (value % 3 !== 0) {
            surviving.push(value);
        }
    }
    assert.deepEqual(tree.toArray(), surviving);
});

test("RedBlackTree: 12000 randomized operations against Set", () => {
    const random: () => number = createRandom(0x5b17);
    const tree: RedBlackTree<number> = new RedBlackTree<number>();
    const expected: Set<number> = new Set<number>();
    const sorted: number[] = [];

    for (let step: number = 0; step < 12000; step += 1) {
        const value: number = randomInt(random, 1500);
        if (random() < 0.55) {
            const inserted: boolean = !expected.has(value);
            assert.equal(tree.insert(value), inserted);
            if (inserted) {
                expected.add(value);
                insertSorted(sorted, value);
            }
        } else {
            const removed: boolean = expected.delete(value);
            assert.equal(tree.delete(value), removed);
            if (removed) {
                removeSorted(sorted, value);
            }
        }
        assert.equal(tree.size, expected.size);
        if (step % 250 === 0) {
            assert.deepEqual(tree.validate(), [], `validate failed at step ${step}`);
        }
        if (step % 1000 === 0) {
            assert.deepEqual(tree.toArray(), sorted);
            assert.equal(tree.has(value), expected.has(value));
        }
    }

    assert.deepEqual(tree.validate(), []);
    assert.deepEqual(tree.toArray(), sorted);
    assert.deepEqual(
        tree.toArray(),
        [...expected].sort((left, right) => left - right),
    );
    if (tree.size > 0) {
        assert.ok(tree.height <= 2 * Math.log2(tree.size + 1));
    }

    const remaining: number[] = [...expected];
    for (let index: number = 0; index < remaining.length; index += 1) {
        assert.equal(tree.delete(remaining[index]), true);
        if (index % 250 === 0) {
            assert.deepEqual(tree.validate(), [], `validate failed while draining index ${index}`);
        }
    }
    assert.equal(tree.size, 0);
    assert.equal(tree.isEmpty, true);
    assert.deepEqual(tree.toArray(), []);
    assert.deepEqual(tree.validate(), []);
});

test("search trees honor reverse and object-key comparators", () => {
    const reverse: Comparator<number> = reverseComparator((left: number, right: number): number => left - right);
    const reverseTrees: OrderedTreeLike<number>[] = [
        new BinarySearchTree<number>({ compare: reverse }),
        new AVLTree<number>({ compare: reverse }),
        new RedBlackTree<number>({ compare: reverse }),
    ];
    for (let index: number = 0; index < reverseTrees.length; index += 1) {
        const tree: OrderedTreeLike<number> = reverseTrees[index];
        const values: number[] = [1, 2, 3, 4];
        for (let position: number = 0; position < values.length; position += 1) {
            assert.equal(tree.insert(values[position]), true);
        }
        assert.deepEqual(tree.toArray(), [4, 3, 2, 1]);
        assert.equal(tree.min(), 4);
        assert.equal(tree.max(), 1);
        assert.equal(tree.insert(3), false);
        assert.equal(tree.has(2), true);
        assert.equal(tree.delete(3), true);
        assert.deepEqual(tree.toArray(), [4, 2, 1]);
        assert.deepEqual(tree.validate(), []);
    }

    const compareTasks: Comparator<Task> = byKey((task: Task): number => task.id);
    const taskTrees: OrderedTreeLike<Task>[] = [
        new BinarySearchTree<Task>({ compare: compareTasks }),
        new AVLTree<Task>({ compare: compareTasks }),
        new RedBlackTree<Task>({ compare: compareTasks }),
    ];
    for (let index: number = 0; index < taskTrees.length; index += 1) {
        const tree: OrderedTreeLike<Task> = taskTrees[index];
        const one: Task = { id: 1, title: "one" };
        const two: Task = { id: 2, title: "two" };
        const three: Task = { id: 3, title: "three" };
        assert.equal(tree.insert(two), true);
        assert.equal(tree.insert(one), true);
        assert.equal(tree.insert(three), true);
        assert.deepEqual(
            tree.toArray().map((task) => task.id),
            [1, 2, 3],
        );
        assert.equal(tree.insert({ id: 2, title: "duplicate" }), false);
        assert.equal(tree.has({ id: 2, title: "lookup" }), true);
        assert.equal(tree.delete({ id: 2, title: "removal" }), true);
        assert.deepEqual(
            tree.toArray().map((task) => task.id),
            [1, 3],
        );
        assert.deepEqual(tree.validate(), []);
    }
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
