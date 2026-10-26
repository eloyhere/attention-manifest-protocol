#!/usr/bin/env node
/**
 * Shared comparator contract for the ordered structures.
 */
import assert from "node:assert/strict";

import type { Comparator } from "../src/structure/compare.ts";
import {
    byKey,
    compareBigInts,
    compareDates,
    compareNatural,
    compareNumbers,
    compareStrings,
    defaultCompare,
    reverseComparator,
    sign,
} from "../src/structure/compare.ts";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => void) => void = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        Failed++;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

test("numeric comparison is three-way and rejects NaN", () => {
    assert.equal(compareNumbers(1, 2), -1);
    assert.equal(compareNumbers(2, 2), 0);
    assert.equal(compareNumbers(3, 2), 1);
    assert.throws(() => compareNumbers(Number.NaN, 1), TypeError);
});

test("string, bigint and date comparison", () => {
    assert.equal(compareStrings("a", "b"), -1);
    assert.equal(compareStrings("a", "a"), 0);
    assert.equal(compareBigInts(1n, 2n), -1);
    assert.equal(compareBigInts(2n, 2n), 0);
    assert.equal(compareDates(new Date(0), new Date(1)), -1);
    assert.throws(() => compareDates(new Date(Number.NaN), new Date(0)), TypeError);
});

test("natural ordering covers primitives and rejects unsupported values", () => {
    assert.equal(compareNatural(1, 2), -1);
    assert.equal(compareNatural("a", "b"), -1);
    assert.equal(compareNatural(1n, 2n), -1);
    assert.equal(compareNatural(false, true), -1);
    assert.equal(compareNatural("same", "same"), 0);
    assert.throws(() => compareNatural(Number.NaN, Number.NaN), TypeError);
    assert.throws(() => compareNatural({}, {}), TypeError);
    const object: object = {};
    assert.equal(compareNatural(object, object), 0);
});

test("reversing a comparator swaps the ordering", () => {
    const reverse: Comparator<number> = reverseComparator(compareNumbers);
    assert.equal(reverse(1, 2), 1);
    assert.equal(reverse(2, 1), -1);
    assert.equal(reverse(2, 2), 0);
});

test("byKey derives an ordering from a selector", () => {
    interface Item {
        id: number;
        label: string;
    }
    const byId: Comparator<Item> = byKey<Item, number>((item) => item.id);
    assert.equal(byId({ id: 1, label: "b" }, { id: 2, label: "a" }), -1);
    const byLabel: Comparator<Item> = byKey<Item, string>((item) => item.label);
    assert.equal(byLabel({ id: 1, label: "b" }, { id: 2, label: "a" }), 1);
});

test("sign clamps comparator-shaped values", () => {
    assert.equal(sign(-10), -1);
    assert.equal(sign(0), 0);
    assert.equal(sign(10), 1);
});

test("defaultCompare is natural ordering", () => {
    assert.equal(defaultCompare(1, 2), -1);
    assert.equal(defaultCompare("b", "a"), 1);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
