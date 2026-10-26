#!/usr/bin/env node
/**
 * Bloom-filter and cuckoo-filter checks.
 */
import assert from "node:assert/strict";

import { BloomFilter } from "../src/structure/bloomFilter.ts";
import { CuckooFilter } from "../src/structure/cuckooFilter.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
}

const lcg = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
};

test("BloomFilter validates sizing inputs", () => {
    assert.throws(() => new BloomFilter({ expectedItems: 0 }), RangeError);
    assert.throws(() => new BloomFilter({ expectedItems: 10, falsePositiveRate: 0 }), RangeError);
    assert.throws(() => new BloomFilter({ expectedItems: 10, falsePositiveRate: 1 }), RangeError);
    assert.throws(() => new BloomFilter({ expectedItems: 1_000_000, falsePositiveRate: 0.0001, maxBits: 1000 }), RangeError);
    const filter = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });
    assert.ok(filter.bitSize > 0);
    assert.ok(filter.hashCount >= 1);
    assert.equal(filter.size, 0);
    assert.equal(filter.setBits, 0);
    assert.equal(filter.fillRatio, 0);
});

test("BloomFilter has no false negatives and records duplicates", () => {
    const filter = new BloomFilter({ expectedItems: 2000, falsePositiveRate: 0.01 });
    for (let index = 0; index < 2000; index += 1) {
        filter.add(`key-${index}`);
    }
    for (let index = 0; index < 2000; index += 1) {
        assert.equal(filter.has(`key-${index}`), true);
    }
    assert.equal(filter.size, 2000);
    assert.ok(filter.setBits > 0 && filter.setBits < filter.bitSize);
    assert.ok(filter.fillRatio > 0 && filter.fillRatio < 1);
    assert.ok(filter.estimatedFalsePositiveRate > 0);

    const before = filter.setBits;
    filter.add("key-0");
    assert.equal(filter.size, 2001);
    assert.equal(filter.setBits, before);
});

test("BloomFilter false-positive rate is in the expected range", () => {
    const filter = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });
    for (let index = 0; index < 1000; index += 1) {
        filter.add(`present-${index}`);
    }
    let falsePositives = 0;
    for (let index = 0; index < 10_000; index += 1) {
        if (filter.has(`absent-${index}`)) {
            falsePositives += 1;
        }
    }
    assert.ok(falsePositives < 300, `false positives: ${falsePositives}`);
});

test("BloomFilter supports byte keys, Unicode and clear", () => {
    const filter = new BloomFilter({ expectedItems: 100, falsePositiveRate: 0.001 });
    const bytes = new Uint8Array([0, 1, 2, 255]);
    filter.add(bytes).add("你好");
    assert.equal(filter.has(new Uint8Array([0, 1, 2, 255])), true);
    assert.equal(filter.has("你好"), true);
    assert.equal(filter.has("hello"), false);
    filter.clear();
    assert.equal(filter.size, 0);
    assert.equal(filter.setBits, 0);
    assert.equal(filter.has(bytes), false);
});

test("BloomFilter rejects non-string/non-byte keys", () => {
    const filter = new BloomFilter({ expectedItems: 10 });
    assert.throws(() => filter.add(42 as unknown as string), TypeError);
    assert.throws(() => filter.has(null as unknown as Uint8Array), TypeError);
});

test("CuckooFilter validates parameters and rounds capacity up", () => {
    assert.throws(() => new CuckooFilter({ capacity: 0 }), RangeError);
    assert.throws(() => new CuckooFilter({ capacity: 10, bucketSize: 0 }), RangeError);
    assert.throws(() => new CuckooFilter({ capacity: 10, fingerprintBits: 3 }), RangeError);
    assert.throws(() => new CuckooFilter({ capacity: 10, maxKicks: -1 }), RangeError);
    const filter = new CuckooFilter({ capacity: 10, bucketSize: 4, fingerprintBits: 8 });
    assert.equal(filter.bucketCount, 4);
    assert.equal(filter.capacity, 16);
    assert.equal(filter.size, 0);
    assert.equal(filter.loadFactor, 0);
    assert.ok(filter.falsePositiveRate > 0);
});

test("CuckooFilter has no false negatives for accepted keys", () => {
    const filter = new CuckooFilter({ capacity: 2000, bucketSize: 4, fingerprintBits: 12 });
    const accepted: string[] = [];
    for (let index = 0; index < 1500; index += 1) {
        const key = `key-${index}`;
        if (filter.add(key)) {
            accepted.push(key);
        }
    }
    assert.equal(filter.size, accepted.length);
    for (const key of accepted) {
        assert.equal(filter.has(key), true);
    }
});

test("CuckooFilter delete removes one occurrence and supports duplicates", () => {
    const filter = new CuckooFilter({ capacity: 32, fingerprintBits: 16 });
    assert.equal(filter.add("duplicate"), true);
    assert.equal(filter.add("duplicate"), true);
    assert.equal(filter.size, 2);
    assert.equal(filter.has("duplicate"), true);
    assert.equal(filter.delete("duplicate"), true);
    assert.equal(filter.has("duplicate"), true);
    assert.equal(filter.delete("duplicate"), true);
    assert.equal(filter.size, 0);
    assert.equal(filter.delete("duplicate"), false);
});

test("CuckooFilter deletion keeps other accepted keys findable", () => {
    const filter = new CuckooFilter({ capacity: 1200, fingerprintBits: 20 });
    const accepted: string[] = [];
    for (let index = 0; index < 1000; index += 1) {
        const key = `key-${index}`;
        if (filter.add(key)) {
            accepted.push(key);
        }
    }
    for (let index = 0; index < accepted.length; index += 2) {
        assert.equal(filter.delete(accepted[index]), true);
    }
    for (let index = 1; index < accepted.length; index += 2) {
        assert.equal(filter.has(accepted[index]), true);
    }
});

test("CuckooFilter handles a full table without losing accepted keys", () => {
    const filter = new CuckooFilter({
        capacity: 8,
        bucketSize: 1,
        fingerprintBits: 16,
        maxKicks: 12,
        seed: 7n,
    });
    const accepted = new Set<string>();
    let failed = 0;
    for (let index = 0; index < 100; index += 1) {
        const key = `full-${index}`;
        if (filter.add(key)) {
            accepted.add(key);
        } else {
            failed += 1;
        }
    }
    assert.ok(failed > 0, "a table with eight slots must eventually reject");
    assert.equal(filter.size, accepted.size);
    for (const key of accepted) {
        assert.equal(filter.has(key), true);
    }
});

test("CuckooFilter supports bytes, clear and is deterministic for a fixed seed", () => {
    const make = (): CuckooFilter => new CuckooFilter({ capacity: 100, fingerprintBits: 12, seed: 42n });
    const a = make();
    const b = make();
    for (let index = 0; index < 80; index += 1) {
        a.add(`same-${index}`);
        b.add(`same-${index}`);
    }
    assert.equal(a.size, b.size);
    assert.equal(a.loadFactor, b.loadFactor);
    for (let index = 0; index < 80; index += 1) {
        assert.equal(a.has(`same-${index}`), b.has(`same-${index}`));
    }
    const bytes = new Uint8Array([9, 8, 7]);
    assert.equal(a.add(bytes), true);
    assert.equal(a.has(new Uint8Array([9, 8, 7])), true);
    a.clear();
    assert.equal(a.size, 0);
    assert.equal(a.loadFactor, 0);
});

test("CuckooFilter rejects invalid keys", () => {
    const filter = new CuckooFilter({ capacity: 10 });
    assert.throws(() => filter.add(1 as unknown as string), TypeError);
    assert.throws(() => filter.has({} as unknown as Uint8Array), TypeError);
});

test("deterministic randomized cuckoo workload keeps accepted keys findable", () => {
    const random = lcg(0xc0ffee);
    const filter = new CuckooFilter({ capacity: 5000, fingerprintBits: 20, maxKicks: 500 });
    const present = new Set<string>();
    let inserted = 0;
    let deleted = 0;
    for (let index = 0; index < 5000; index += 1) {
        const key = `r-${Math.floor(random() * 10_000)}`;
        if (filter.add(key)) {
            inserted += 1;
            present.add(key);
        }
        if (index % 7 === 0) {
            const victim = [...present][Math.floor(random() * present.size)];
            if (victim !== undefined && filter.delete(victim)) {
                deleted += 1;
                present.delete(victim);
            }
        }
        if (index % 500 === 0) {
            for (const key of present) {
                assert.equal(filter.has(key), true);
            }
        }
    }
    assert.equal(filter.size, inserted - deleted);
    assert.ok(filter.size >= present.size);
    for (const key of present) {
        assert.equal(filter.has(key), true);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
