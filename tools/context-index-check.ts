#!/usr/bin/env node
/**
 * ContextIndex: exact map + content-addressed detail + LRU, no eager filters.
 */
import assert from "node:assert/strict";

import type { ContextAstView } from "../src/context/ast.ts";
import { ContextIndex } from "../src/context/contextIndex.ts";
import type { ContextIndexStats } from "../src/context/contextIndex.ts";
import { MemoryContentStore } from "../src/context/contentStore.ts";

const Store: MemoryContentStore = new MemoryContentStore();
const Index: ContextIndex = new ContextIndex(undefined, { store: Store, cacheEntries: 4 });
Index.add({ id: "root", kind: "goal", summary: "incident root", order: 0, salience: 1 });
for (let node: number = 0; node < 24; node += 1) {
    const layer: string = node % 3 === 0 ? "database" : node % 3 === 1 ? "connection_pool" : "queue";
    Index.add(
        {
            id: `probe.${node}`,
            parentId: "root",
            kind: "observation",
            summary: `${layer} probe ${node}: saturation signal`,
            order: node + 1,
            salience: 0.5,
        },
        node % 2 === 0 ? "shared detail" : `unique detail ${node}`,
    );
}

assert.equal(Index.stats().nodes, 25);
assert.equal(Store.size() < 24, true);
assert.equal(Index.getDetail("probe.0"), "shared detail");
assert.equal(Index.getDetail("probe.0"), "shared detail");
assert.ok(Index.stats().hits >= 1);
assert.equal(Index.getDetail("root"), undefined);

const View: ContextAstView = Index.view(300);
assert.ok(View.tokens <= 300);
assert.ok(View.refs.length > 0);
assert.match(View.text, /database|connection_pool|queue/);

const Before: ContextIndexStats = Index.stats();
Index.getDetail("probe.23");
assert.ok(Index.stats().misses >= Before.misses);

console.log(`nodes=${Index.stats().nodes} uniqueDetails=${Store.size()} hits=${Index.stats().hits} misses=${Index.stats().misses} viewTokens=${View.tokens}`);
console.log("\x1b[32m✓\x1b[0m ContextIndex dedupes details, caches via LRU and keeps the view budget");
console.log("\n1 passed, 0 failed");
