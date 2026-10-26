#!/usr/bin/env node
/** Context AST: tree + precedence, summary budget, detail expansion. */
import assert from "node:assert/strict";

import { ContextAst, MemoryDetailStore } from "../src/context/ast.ts";

const ast = new ContextAst();
const details = new MemoryDetailStore();
ast.add({
    id: "incident",
    kind: "goal",
    summary: "payment API p99 2.8s and 5xx 8%; diagnose before changing limits",
    order: 0,
    salience: 1,
});
const layers = ["thread_pool", "connection_pool", "connect", "database", "queue", "application", "release"];
for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
    const layer = layers[layerIndex];
    const layerId = `layer.${layer}`;
    ast.add({
        id: layerId,
        parentId: "incident",
        kind: "frame",
        summary: `${layer} check: utilization, saturation, errors`,
        order: layerIndex + 1,
        salience: 0.9 - layerIndex * 0.05,
    });
    for (let probe = 0; probe < 20; probe += 1) {
        const id = `${layerId}.probe.${probe}`;
        const detail = `${layer} probe ${probe}: ` + "raw metric and stack sample ".repeat(30);
        const ref = details.put(id, detail);
        ast.add({
            id,
            parentId: layerId,
            kind: "observation",
            summary: `${layer} probe ${probe} summary: key saturation signal`,
            detailRef: ref,
            detailTokens: Math.ceil(detail.length / 4),
            order: layerIndex * 100 + probe + 10,
            salience: 0.5,
        });
    }
}
for (let index = 1; index < 20; index += 1) ast.link({ from: "layer.thread_pool.probe.0", to: "layer.thread_pool.probe.1", kind: "before" });
for (let index = 0; index < layers.length - 1; index += 1) ast.link({ from: `layer.${layers[index]}`, to: `layer.${layers[index + 1]}`, kind: "before" });

const order = ast.order();
assert.equal(order.length, 148);
assert.equal(order[0].id, "incident");
assert.equal(ast.children("layer.database").length, 20);
assert.equal(ast.descendants("incident").length, 147);
assert.equal(
    ast
        .ancestors("layer.database.probe.3")
        .map((node) => node.id)
        .join("/"),
    "incident/layer.database",
);

const view = ast.view(1200);
assert.ok(view.tokens <= 1200);
assert.ok(view.nodes.length < order.length);
assert.ok(view.refs.length > 0);
assert.match(view.text, /layer\.database/);

const flat = ast.flat(details);
assert.ok(flat.tokens > view.tokens * 3, `flat=${flat.tokens} view=${view.tokens}`);

const detail = ast.expand("layer.database.probe.3", details);
assert.ok(detail?.startsWith("database probe 3:"));
assert.equal(ast.expand("incident", details), undefined);

const restored = ContextAst.restore(ast.serialize());
assert.equal(restored.order().length, ast.order().length);
assert.equal(restored.children("layer.queue").length, 20);

console.log(`nodes=${order.length} viewTokens=${view.tokens} flatTokens=${flat.tokens} refs=${view.refs.length}`);
console.log("\x1b[32m✓\x1b[0m AST keeps summaries under budget, expands details on demand, and preserves tree/precedence");
console.log("\n1 passed, 0 failed");
