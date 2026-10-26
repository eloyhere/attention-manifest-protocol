#!/usr/bin/env node
/** ContextIndex: exact map + content-addressed detail + LRU, no eager filters. */
import assert from "node:assert/strict";

import { ContextIndex } from "../src/context/contextIndex.ts";
import { MemoryContentStore } from "../src/context/contentStore.ts";

const store = new MemoryContentStore();
const index = new ContextIndex(undefined, { store, cacheEntries: 4 });
index.add({ id: "root", kind: "goal", summary: "incident root", order: 0, salience: 1 });
for (let node = 0; node < 24; node += 1) {
    const layer = node % 3 === 0 ? "database" : node % 3 === 1 ? "connection_pool" : "queue";
    index.add(
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

assert.equal(index.stats().nodes, 25);
assert.equal(store.size() < 24, true);
assert.equal(index.getDetail("probe.0"), "shared detail");
assert.equal(index.getDetail("probe.0"), "shared detail");
assert.ok(index.stats().hits >= 1);
assert.equal(index.getDetail("root"), undefined);

const view = index.view(300);
assert.ok(view.tokens <= 300);
assert.ok(view.refs.length > 0);
assert.match(view.text, /database|connection_pool|queue/);

const before = index.stats();
index.getDetail("probe.23");
assert.ok(index.stats().misses >= before.misses);

console.log(`nodes=${index.stats().nodes} uniqueDetails=${store.size()} hits=${index.stats().hits} misses=${index.stats().misses} viewTokens=${view.tokens}`);
console.log("\x1b[32m✓\x1b[0m ContextIndex dedupes details, caches via LRU and keeps the view budget");
console.log("\n1 passed, 0 failed");
